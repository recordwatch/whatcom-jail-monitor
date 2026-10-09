import axios from 'axios';

// This is the same JSON feed that powers the county's own roster.html page
// (apps1.whatcomcounty.us/jaildata/js/roster.js calls it directly) — no HTML
// scraping needed, and unlike Kitsap/Pierce/Thurston it returns full charge
// detail (court, bail, disposition, arresting agency) for every booking in
// one call, so there's no separate detail-page fetch or backfill batching.
// WHATCOM_ROSTER_URL exists only so tests can point the scraper at a local mock server.
const ROSTER_URL = process.env.WHATCOM_ROSTER_URL || 'https://apps1.whatcomcounty.us/jaildata/api/roster.jsp';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// Returns the raw array of booking objects from the county API, each with
// a nested `offenses` array. Field names are left as the API provides them
// (booking_num, fullname, offenses[].offense_description, etc) — scrape.js
// maps them into the shared roster entry shape.
//
// Throws on anything that isn't a list of bookings (an HTML error page, a
// changed API shape, a booking with no booking_num), so a bad response can
// never be mistaken for a real roster.
export async function scrapeRoster() {
  const res = await axios.get(ROSTER_URL, { headers: HEADERS, timeout: 20000 });
  const roster = res.data?.roster;
  if (!Array.isArray(roster)) {
    throw new Error(`API response has no roster array (got ${typeof res.data}; error page or API change?)`);
  }
  const missing = roster.filter(b => !b?.booking_num).length;
  if (missing > 0) throw new Error(`${missing} booking(s) in the API response have no booking_num (API change?)`);
  return roster;
}
