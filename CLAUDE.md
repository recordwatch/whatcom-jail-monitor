# Whatcom Jail Roster — Project Context

## What it is
A public jail roster monitor for Whatcom County, WA (Bellingham). Polls the Sheriff's Office roster JSON API every 30 minutes, tracks bookings and releases, and displays them on a public website.

## URLs
- **Live site:** (not deployed yet — will be https://theonlytacocat.github.io/whatcom-jail-monitor/ once GitHub Pages is enabled)
- **GitHub repo:** https://github.com/recordwatch/whatcom-jail-monitor
- **Source data:** Whatcom County Sheriff — https://apps1.whatcomcounty.us/jaildata/api/roster.jsp (the JSON feed behind https://www.whatcomcounty.us/250/Jail-Roster-Search → apps1.whatcomcounty.us/jaildata/roster.html)

## Architecture
- **Scraper:** `scrape.js` — standalone Node.js script, runs via GitHub Actions cron every 30 min
- **Frontend:** React + Vite, served as static files on GitHub Pages (`gh-pages` branch)
- **Data storage:** JSON files committed to git in `data/` — no server, no database
- **Hosting cost:** $0

## Key technical notes
- No scraping needed at all — this is a real JSON API (not an HTML page or PDF like the other counties), so `scrapers/whatcom.js` is just an axios GET, no cheerio
- One call returns full detail for every current inmate, including nested `offenses[]` (charges) — unlike Thurston/Pierce, there's no separate detail-page fetch or backfill batching logic needed
- `booking_num` is the stable identifier (used as `idnum` in the shared data shape, matching the other counties' convention)
- Whatcom exposes more per-charge detail than any sibling county: court, cause number, bail amount (+ optional cash alternative), bond type, arresting agency, arrest type, and **disposition** (case outcome) with a disposition date — `BookingCard.jsx` and `index.css` (`.charge-disposition`) were extended to show this
- Also exposes `facility` / `facility_floor` / `facility_cell` (where in the jail someone is housed) — shown in the in-custody card meta line, dropped once released since it's no longer meaningful
- Release detection is diff-based: if a `booking_num` drops off the roster, it's marked released (same approach as Thurston/Kitsap)
- Mutable fields (cell/floor moves, charge disposition updates as cases resolve) are refreshed every run for anyone still in custody, since the API always returns full current state

## Key files
- `scrape.js` — main scraper script, writes all `data/*.json` files
- `scrapers/whatcom.js` — roster fetch (axios only)
- `utils.js` — `nowPST()` helper with `hourCycle: 'h23'` (prevents midnight 24:xx bug)
- `data/change_log.json` — full history of all bookings/releases
- `data/roster.json` — current roster state, keyed by `booking_num`
- `data/status.json` — `{inCustody, lastUpdated}`
- `.github/workflows/scrape.yml` — GitHub Actions workflow (scrape + build + deploy)
- `frontend/src/App.jsx` — React app, HashRouter, fetches from `./data/*.json` (unchanged from Thurston — data shape is compatible)
- `frontend/vite.config.js` — `base: './'` for GitHub Pages compatibility

## Data format
- `change_log.json` is an array of booking entries, newest first
- Each entry: `idnum`/`bookingNumber` (booking_num), `name`, `status` (in_custody/released), `firstSeen`, `releasedAt`, `bookingDate`, `bookingAgency`, `bookingType`, `facility`, `facilityFloor`, `facilityCell`, `nameId`, `charges[]`, `hasDetail` (always true)
- Each charge: `{ charge, court, causeNumber, bail, bondType, arrestAgency, arrestType, eventNumber, disposition, dispositionDate }`
- `name` format: `LAST, FIRST MIDDLE`
- `firstSeen` format: "MM/DD/YYYY, HH:MM:SS" (PST)

## Color scheme
- Violet/storm theme (distinct from Kitsap's blue, Pierce's green, Thurston's amber/bronze)
- Background: #15131F, primary accent: #7A5FC7, secondary accent: #8F6FE0, highlight: #B89AE8

## Related projects
- **Kitsap Jail Roster** — https://theonlytacocat.github.io/ksco-scraper/
- **Pierce County Jail Roster** — https://theonlytacocat.github.io/pierce-jail-roster/
- **Thurston County Jail Roster** — https://theonlytacocat.github.io/thurston-jail-roster/
- **Mason County Jail Roster** — https://alexasroster.com (also serves the wajaildata.org hub page)
- **Washington Jail Data hub** — https://wajaildata.org — landing page linking all county monitors; served from `mason-jail-roster/server.js` around the `.nav-section` block. Add a `<a class="nav-btn">` entry there once this site is live.

## Setup steps still needed
1. `git remote add origin git@github.com:recordwatch/whatcom-jail-monitor.git` and push (repo already exists, empty)
2. Enable GitHub Pages (Settings → Pages → deploy from `gh-pages` branch), same as the other repos
3. Trigger the `scrape.yml` workflow once manually (workflow_dispatch) to confirm it runs end-to-end
4. Add the Whatcom link to `mason-jail-roster/server.js`'s `.nav-section` (wajaildata.org hub)
