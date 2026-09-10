import axios from 'axios';

// This is the same JSON feed that powers the county's own roster.html page
// (apps1.whatcomcounty.us/jaildata/js/roster.js calls it directly) — no HTML
// scraping needed, and unlike Kitsap/Pierce/Thurston it returns full charge
// detail (court, bail, disposition, arresting agency) for every booking in
// one call, so there's no separate detail-page fetch or backfill batching.
const ROSTER_URL = 'https://apps1.whatcomcounty.us/jaildata/api/roster.jsp';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// Returns the raw array of booking objects from the county API, each with
// a nested `offenses` array. Field names are left as the API provides them
// (booking_num, fullname, offenses[].offense_description, etc) — scrape.js
// maps them into the shared roster entry shape.
export async function scrapeRoster() {
  const res = await axios.get(ROSTER_URL, { headers: HEADERS, timeout: 20000 });
  return res.data.roster;
}
