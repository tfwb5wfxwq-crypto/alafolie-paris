import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const PRICELABS_API_KEY = Deno.env.get("PRICELABS_API_KEY") || "";
const ICAL_URL = "https://www.airbnb.fr/calendar/ical/1503490402342628075.ics?t=9b9638075e404bf7b54c0342d07b547b";
const LISTING_ID = "1503490402342628075";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Parse iCal and extract blocked dates
async function getBlockedDates(): Promise<{ start: Date; end: Date; type: string }[]> {
  const response = await fetch(ICAL_URL);
  const icalText = await response.text();

  const blockedDates: { start: Date; end: Date; type: string }[] = [];
  const events = icalText.split("BEGIN:VEVENT");

  for (const event of events.slice(1)) {
    const dtStartMatch = event.match(/DTSTART;VALUE=DATE:(\d{8})/);
    const dtEndMatch = event.match(/DTEND;VALUE=DATE:(\d{8})/);
    const summaryMatch = event.match(/SUMMARY:(.+)/);

    if (dtStartMatch && dtEndMatch) {
      const startStr = dtStartMatch[1];
      const endStr = dtEndMatch[1];
      const summary = summaryMatch ? summaryMatch[1].trim() : "";

      const start = new Date(
        parseInt(startStr.slice(0, 4)),
        parseInt(startStr.slice(4, 6)) - 1,
        parseInt(startStr.slice(6, 8))
      );
      const end = new Date(
        parseInt(endStr.slice(0, 4)),
        parseInt(endStr.slice(4, 6)) - 1,
        parseInt(endStr.slice(6, 8))
      );

      blockedDates.push({
        start,
        end,
        type: summary.includes("Reserved") ? "reserved" : "blocked"
      });
    }
  }

  return blockedDates;
}

// Check if dates are available
function checkAvailability(
  checkIn: Date,
  checkOut: Date,
  blockedDates: { start: Date; end: Date; type: string }[]
): { available: boolean; conflict?: { start: Date; end: Date; type: string } } {
  for (const blocked of blockedDates) {
    // Check if there's any overlap
    if (checkIn < blocked.end && checkOut > blocked.start) {
      return { available: false, conflict: blocked };
    }
  }
  return { available: true };
}

// Find next available periods
function findAlternatives(
  checkIn: Date,
  checkOut: Date,
  blockedDates: { start: Date; end: Date; type: string }[],
  nightsNeeded: number
): { start: Date; end: Date; nights: number }[] {
  const alternatives: { start: Date; end: Date; nights: number }[] = [];
  const sortedBlocked = [...blockedDates].sort((a, b) => a.start.getTime() - b.start.getTime());

  // Look for available windows in the next 90 days
  const today = new Date();
  const maxDate = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);

  let currentDate = new Date(Math.max(today.getTime(), checkIn.getTime() - 14 * 24 * 60 * 60 * 1000));

  while (currentDate < maxDate && alternatives.length < 3) {
    // Find the end of this available window
    let windowEnd = new Date(maxDate);
    for (const blocked of sortedBlocked) {
      if (blocked.start > currentDate) {
        windowEnd = new Date(Math.min(windowEnd.getTime(), blocked.start.getTime()));
        break;
      }
    }

    // Check if we're inside a blocked period
    let insideBlocked = false;
    for (const blocked of sortedBlocked) {
      if (currentDate >= blocked.start && currentDate < blocked.end) {
        currentDate = new Date(blocked.end);
        insideBlocked = true;
        break;
      }
    }

    if (insideBlocked) continue;

    // Calculate available nights
    const availableNights = Math.floor((windowEnd.getTime() - currentDate.getTime()) / (24 * 60 * 60 * 1000));

    if (availableNights >= Math.min(nightsNeeded, 2)) {
      alternatives.push({
        start: new Date(currentDate),
        end: windowEnd,
        nights: availableNights
      });
    }

    // Move to next window
    currentDate = new Date(windowEnd.getTime() + 24 * 60 * 60 * 1000);
    for (const blocked of sortedBlocked) {
      if (blocked.start <= currentDate && blocked.end > currentDate) {
        currentDate = new Date(blocked.end);
      }
    }
  }

  return alternatives;
}

// Get pricing from PriceLabs
async function getPricing(checkIn: string, checkOut: string): Promise<{ prices: any[]; total: number } | null> {
  if (!PRICELABS_API_KEY) {
    console.error("PriceLabs API key not configured");
    return null;
  }

  try {
    const response = await fetch("https://api.pricelabs.co/v1/listing_prices", {
      method: "POST",
      headers: {
        "X-API-Key": PRICELABS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        listings: [{
          id: LISTING_ID,
          pms: "airbnb",
          dateFrom: checkIn,
          dateTo: checkOut
        }]
      })
    });

    if (!response.ok) {
      console.error("PriceLabs API error:", await response.text());
      return null;
    }

    const data = await response.json();

    // Log complete response to see what PriceLabs returns
    console.log("📊 PriceLabs full response:", JSON.stringify(data, null, 2));

    if (data && data.length > 0 && data[0].data) {
      const listingData = data[0];
      const prices = listingData.data;
      const total = prices.reduce((sum: number, day: any) => sum + (day.price || 0), 0);

      // Check if PriceLabs returns rules/restrictions
      console.log("🔍 Listing data keys:", Object.keys(listingData));

      return {
        prices,
        total,
        // Include any additional data from PriceLabs
        min_nights: listingData.min_nights,
        restrictions: listingData.restrictions,
        rules: listingData.rules
      };
    }

    return null;
  } catch (error) {
    console.error("PriceLabs fetch error:", error);
    return null;
  }
}

// Format date for display
function formatDate(date: Date): string {
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

serve(async (req) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // If just requesting blocked dates for calendar display
    if (body.get_calendar) {
      const blockedDates = await getBlockedDates();
      const blockedRanges = blockedDates.map(b => ({
        start: b.start.toISOString().split("T")[0],
        end: b.end.toISOString().split("T")[0],
        type: b.type
      }));
      return new Response(
        JSON.stringify({ blocked: blockedRanges }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { check_in, check_out, guests = 2 } = body;

    if (!check_in || !check_out) {
      return new Response(
        JSON.stringify({ error: "check_in and check_out required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const checkInDate = new Date(check_in);
    const checkOutDate = new Date(check_out);
    const nights = Math.floor((checkOutDate.getTime() - checkInDate.getTime()) / (24 * 60 * 60 * 1000));

    // Get blocked dates from iCal
    const blockedDates = await getBlockedDates();

    // Check availability
    const availability = checkAvailability(checkInDate, checkOutDate, blockedDates);

    // Get pricing ALWAYS (not just when available)
    const pricing = await getPricing(check_in, check_out);

    // Prepare response
    const response: any = {
      check_in,
      check_out,
      nights,
      guests,
      available: availability.available,
      airbnb_url: `https://www.airbnb.fr/rooms/${LISTING_ID}?check_in=${check_in}&check_out=${check_out}&guests=${guests}`
    };

    // Add pricing if available from PriceLabs
    if (pricing) {
      response.pricing = {
        total: pricing.total,
        per_night_avg: Math.round(pricing.total / nights),
        breakdown: pricing.prices,
        // Include rules/restrictions if PriceLabs provides them
        min_nights: pricing.min_nights,
        restrictions: pricing.restrictions,
        rules: pricing.rules
      };
    }

    if (availability.available) {
      response.whatsapp_message = `Salut Léa ! L'appart est dispo du ${formatDate(checkInDate)} au ${formatDate(checkOutDate)} (${nights} nuits). Je voudrais réserver !`;
    } else {
      // Find alternatives
      const alternatives = findAlternatives(checkInDate, checkOutDate, blockedDates, nights);
      response.alternatives = alternatives.map(alt => ({
        start: alt.start.toISOString().split("T")[0],
        end: alt.end.toISOString().split("T")[0],
        nights: alt.nights,
        label: `${formatDate(alt.start)} → ${formatDate(alt.end)} (${alt.nights} nuits dispo)`
      }));

      response.conflict = {
        start: availability.conflict?.start.toISOString().split("T")[0],
        end: availability.conflict?.end.toISOString().split("T")[0],
        type: availability.conflict?.type
      };

      response.whatsapp_message = `Salut Léa ! Je cherchais du ${formatDate(checkInDate)} au ${formatDate(checkOutDate)} mais c'est pris. Est-ce qu'on peut s'arranger ?`;
    }

    return new Response(
      JSON.stringify(response),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
