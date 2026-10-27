import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { scrapeRoster, fetchReleases } from './scrapers/whatcom.js';
import { nowPST } from './utils.js';
import { setTimeout as sleep } from 'timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ROSTER_FILE = path.join(DATA_DIR, 'roster.json');
const LOG_FILE    = path.join(DATA_DIR, 'change_log.json');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');

const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 5000);

// Partial-load guard. Releases are detected by people disappearing from the
// county's list, so a short list would mark everyone missing from it as
// released. Abort (writing nothing) when in-custody would drop by more than
// both thresholds; percentage alone would trip on small drops at a small
// jail. Backtest on 151 real run-over-run changes (Sep 10 - Oct 9 2026,
// including a 1.5-day outage): largest drop was 10 people / 3.5%.
// ALLOW_BIG_DROP=1 overrides it for one run when a big drop is real.
const GUARD_MIN_PEOPLE = 5;
const GUARD_MIN_FRACTION = 0.10;

// A detected release is looked up on the county's releases list for this
// many days after we noticed it, in case the county enters it late. After
// that it is looked up once (releaseChecked) and left as detected.
const RELEASE_RECHECK_DAYS = 3;
const RELEASES_DELAY_MS = Number(process.env.RELEASES_DELAY_MS ?? 1000);

// County times look like "2026-09-26 07:00:13.0" (Pacific, same zone as
// ours). Returns our "MM/DD/YYYY, HH:MM:SS" format, or null if it isn't a
// real date and time.
function countyToPST(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d+)?$/.exec(s ?? '');
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const day = new Date(Date.UTC(+y, +mo - 1, +d));
  if (day.getUTCMonth() !== +mo - 1 || day.getUTCDate() !== +d || +h > 23 || +mi > 59 || +se > 59) return null;
  return `${mo}/${d}/${y}, ${h}:${mi}:${se}`;
}

// Our "MM/DD/YYYY, HH:MM:SS" -> "YYYY-MM-DD HH:MM:SS", which sorts and
// compares correctly as a plain string.
function sortable(pst) {
  return `${pst.slice(6, 10)}-${pst.slice(0, 2)}-${pst.slice(3, 5)} ${pst.slice(12)}`;
}

function addDays(day, n) {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// A missing or unreadable data file stops the run instead of starting over
// from empty: an empty roster would make everyone look newly booked, and an
// empty change_log.json would be written back over the full history. Set
// ALLOW_FRESH_START=1 only for a deliberate first run.
function readJSON(file, fallback) {
  const name = path.basename(file);
  if (!fs.existsSync(file)) {
    if (process.env.ALLOW_FRESH_START === '1') return fallback;
    throw new Error(`${name} is missing; refusing to start from empty (set ALLOW_FRESH_START=1 for a deliberate first run)`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`${name} could not be parsed: ${err.message}`);
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data));
}

function formatBail(o) {
  if (o.bail_amount == null) return null;
  let s = `$${Number(o.bail_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  if (o.optional_bail_amount && o.optional_bail_amount > 0) {
    s += ` OR $${Number(o.optional_bail_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })} CASH`;
  }
  return s;
}

function mapCharges(offenses) {
  return (offenses || []).map(o => ({
    charge: o.offense_description,
    court: o.offense_court,
    causeNumber: o.citation_number,
    bail: formatBail(o),
    bondType: o.bond_description,
    arrestAgency: o.arrest_agency,
    arrestType: o.arrest_type,
    eventNumber: o.event_number,
    disposition: o.disposition,
    dispositionDate: o.disposition_date,
  }));
}

function buildEntry(b, firstSeen) {
  return {
    idnum: b.booking_num,
    bookingNumber: b.booking_num,
    name: b.fullname,
    status: 'in_custody',
    firstSeen,
    releasedAt: null,
    bookingDate: b.booking_date,
    bookingAgency: b.booking_agency,
    bookingType: b.booking_type,
    facility: b.facility,
    facilityFloor: b.facility_floor,
    facilityCell: b.facility_cell,
    nameId: b.name_id,
    charges: mapCharges(b.offenses),
    hasDetail: true,
  };
}

// Replace detected release times with the county's own (from its releases
// list), and add people who were booked and released entirely between two of
// our runs, so were never on a roster we saw. Failures here only warn: the
// roster update is still good, and anything not looked up is retried next run.
async function applyCountyReleases(roster, log, now) {
  const today = sortable(now).slice(0, 10);
  const recent = addDays(today, -RELEASE_RECHECK_DAYS);
  const pending = Object.values(roster).filter(e =>
    e.status === 'released' && e.releaseSource !== 'county' &&
    (!e.releaseChecked || sortable(e.releasedAt).slice(0, 10) >= recent));

  // Days to fetch: today and yesterday every run (for people never seen),
  // plus around each pending release. We notice a release after it happens,
  // so look up to 2 days before; the county sometimes records it a little
  // after we notice, which can cross midnight, so 1 day after too.
  const daysFor = e => {
    const d = sortable(e.releasedAt).slice(0, 10);
    return [-2, -1, 0, 1].map(n => addDays(d, n)).filter(x => x <= today);
  };
  const days = new Set([today, addDays(today, -1)]);
  for (const e of pending) for (const d of daysFor(e)) days.add(d);

  const county = new Map();   // booking_num -> county release record
  const fetched = new Set();
  for (const day of [...days].sort()) {
    try {
      for (const r of await fetchReleases(day)) if (r?.booking_num) county.set(r.booking_num, r);
      fetched.add(day);
    } catch (err) {
      console.warn(`  Releases for ${day} could not be fetched (retried next run): ${err.message}`);
    }
    if (RELEASES_DELAY_MS) await sleep(RELEASES_DELAY_MS);
  }

  const logIndex = new Map(log.map((e, i) => [e.idnum, i]));
  const update = (id, fields) => {
    Object.assign(roster[id], fields);
    const i = logIndex.get(id);
    if (i !== undefined) Object.assign(log[i], fields);
  };

  // 'county' only for a release_date that parses as a real time, and not
  // before the booking (that would be a different stay).
  let verified = 0;
  for (const e of pending) {
    const r = county.get(e.idnum);
    const at = r ? countyToPST(r.release_date) : null;
    const booked = countyToPST(e.bookingDate);
    if (at && (!booked || sortable(at) >= sortable(booked))) {
      update(e.idnum, {
        releasedAt: at,
        releaseSource: 'county',
        releaseReason: r.release_description ?? null,
        releaseDetectedAt: e.releasedAt,
        releaseChecked: true,
      });
      verified++;
    } else if (!e.releaseChecked && daysFor(e).every(d => fetched.has(d))) {
      update(e.idnum, { releaseChecked: true });
    }
  }

  // Booked and released between two of our runs. Only releases after our
  // first run count; anyone released before it was never ours to see.
  const start = log.reduce((min, e) => (e.firstSeen && sortable(e.firstSeen) < min ? sortable(e.firstSeen) : min), '9999');
  let added = 0;
  for (const r of county.values()) {
    if (roster[r.booking_num]) continue;
    const at = countyToPST(r.release_date);
    const booked = countyToPST(r.booking_date);
    if (!at || !booked || sortable(at) <= start || sortable(at) < sortable(booked)) continue;
    console.log(`  ADDED (booked and released between runs): ${r.fullname}`);
    const entry = {
      ...buildEntry(r, booked),
      status: 'released',
      releasedAt: at,
      releaseSource: 'county',
      releaseReason: r.release_description ?? null,
      releaseChecked: true,
      // Never on any roster we fetched, so firstSeen is the county's booking time.
      seenInCustody: false,
    };
    roster[r.booking_num] = entry;
    const pos = log.findIndex(e => sortable(e.firstSeen) < sortable(booked));
    log.splice(pos === -1 ? log.length : pos, 0, entry);
    added++;
  }

  console.log(`  County releases: ${fetched.size}/${days.size} day(s) fetched, ${verified} release time(s) verified, ${added} never-seen booking(s) added`);
}

async function run() {
  console.log(`[${nowPST()}] Running Whatcom County scrape...`);

  let roster = readJSON(ROSTER_FILE, {});
  let log    = readJSON(LOG_FILE, []);
  // When the last successful run finished. Anyone released this run was
  // still on the county's list then, so their real release happened
  // between that time and now. Missing on a first run, which is fine.
  const lastRunAt = fs.existsSync(STATUS_FILE) ? JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')).lastUpdated ?? null : null;

  let bookings;
  try {
    try {
      bookings = await scrapeRoster();
    } catch (err) {
      // Retry network errors once (a momentary timeout shouldn't turn the
      // run red); a response that arrived but was wrong won't fix itself.
      if (!err.isAxiosError) throw err;
      console.warn(`  Roster fetch failed, retrying once: ${err.message}`);
      await sleep(RETRY_DELAY_MS);
      bookings = await scrapeRoster();
    }
  } catch (err) {
    console.error('Roster fetch failed:', err.message);
    process.exit(1);
  }

  if (bookings.length === 0) {
    console.error('Got 0 bookings (county site down or API change?); nothing written.');
    process.exit(1);
  }

  const currentIds  = new Set(bookings.map(b => b.booking_num));
  const previousIds = new Set(Object.keys(roster));

  const newBookings = bookings.filter(b => !previousIds.has(b.booking_num));
  const reappeared  = bookings.filter(b => roster[b.booking_num]?.status === 'released');
  const releasedIds = [...previousIds].filter(id => !currentIds.has(id) && roster[id]?.status === 'in_custody');

  const prevInCustody = Object.values(roster).filter(e => e.status === 'in_custody').length;
  const nextInCustody = prevInCustody + newBookings.length + reappeared.length - releasedIds.length;
  const drop = prevInCustody - nextInCustody;
  console.log(`  ${bookings.length} on the county roster; in custody ${prevInCustody} -> ${nextInCustody}`);
  if (drop > GUARD_MIN_PEOPLE && drop > prevInCustody * GUARD_MIN_FRACTION) {
    if (process.env.ALLOW_BIG_DROP === '1') {
      console.warn(`  In custody dropping by ${drop}; allowed by ALLOW_BIG_DROP=1.`);
    } else {
      console.error(`In custody would drop by ${drop} (${prevInCustody} -> ${nextInCustody}), more than ${GUARD_MIN_PEOPLE} people and ${GUARD_MIN_FRACTION * 100}%. ` +
        'Looks like a partial list from the county; nothing written. If the drop is real, re-run with ALLOW_BIG_DROP=1.');
      process.exit(1);
    }
  }

  console.log(`  ${newBookings.length} new booking(s) found`);

  const now = nowPST();
  for (const b of newBookings) {
    console.log(`  NEW: ${b.fullname}`);
    const entry = buildEntry(b, now);
    roster[b.booking_num] = entry;
    log.unshift(entry);
  }

  // Refresh mutable fields for people still in custody: cell/floor moves,
  // and charge detail (dispositions can update as cases resolve).
  for (const b of bookings) {
    if (!previousIds.has(b.booking_num)) continue;
    const existing = roster[b.booking_num];
    existing.facility = b.facility;
    existing.facilityFloor = b.facility_floor;
    existing.facilityCell = b.facility_cell;
    existing.charges = mapCharges(b.offenses);
    const logEntry = log.find(e => e.idnum === b.booking_num);
    if (logEntry) {
      logEntry.facility = existing.facility;
      logEntry.facilityFloor = existing.facilityFloor;
      logEntry.facilityCell = existing.facilityCell;
      logEntry.charges = existing.charges;
    }
  }

  // Back on the county's list after we marked them released: the release was
  // wrong (most likely a short list from the county). Reverse it, keeping the
  // old release time so the reversal stays visible.
  for (const b of reappeared) {
    const entry = roster[b.booking_num];
    console.log(`  REAPPEARED: ${entry.name} (marked released ${entry.releasedAt})`);
    const reversal = { releasedAt: entry.releasedAt, releaseSource: entry.releaseSource ?? null, reversedAt: now };
    const cleared = {
      releaseReversals: [...(entry.releaseReversals || []), reversal],
      status: 'in_custody',
      releasedAt: null,
      releaseSource: null,
      lastSeenInCustodyAt: null,
      releaseReason: null,
      releaseDetectedAt: null,
      releaseChecked: null,
    };
    Object.assign(entry, cleared);
    const logEntry = log.find(e => e.idnum === b.booking_num);
    if (logEntry) Object.assign(logEntry, cleared);
  }

  // Releases — in previous roster but no longer on the current page.
  // Whatcom's API has no release field, so releasedAt is when we noticed
  // (releaseSource 'detected'); the real release was after
  // lastSeenInCustodyAt and before releasedAt.
  for (const id of releasedIds) {
    const inmate = roster[id];
    console.log(`  RELEASED: ${inmate.name}`);
    roster[id].status     = 'released';
    roster[id].releasedAt = now;
    roster[id].releaseSource = 'detected';
    roster[id].lastSeenInCustodyAt = lastRunAt;
    const logEntry = log.find(e => e.idnum === id);
    if (logEntry) {
      logEntry.status     = 'released';
      logEntry.releasedAt = roster[id].releasedAt;
      logEntry.releaseSource = 'detected';
      logEntry.lastSeenInCustodyAt = lastRunAt;
    }
  }

  // One-time label for releases recorded before releaseSource existed: all
  // of them were detected the same way. Done here, by the scraper, rather
  // than by a separate data push that the workflow's `git pull -X ours`
  // could overwrite. lastSeenInCustodyAt is left unset for them.
  let labeled = 0;
  for (const e of [...Object.values(roster), ...log]) {
    if (e.status === 'released' && !e.releaseSource) { e.releaseSource = 'detected'; labeled++; }
  }
  if (labeled) console.log(`  Labeled ${labeled} existing record(s) (roster + log) releaseSource: detected`);

  await applyCountyReleases(roster, log, now);

  writeJSON(ROSTER_FILE, roster);
  writeJSON(LOG_FILE, log);

  const inCustody = Object.values(roster).filter(i => i.status === 'in_custody').length;
  writeJSON(STATUS_FILE, { inCustody, lastUpdated: now });

  console.log(`[${nowPST()}] Done. ${newBookings.length} new, ${releasedIds.length} released, ${reappeared.length} reappeared. ${inCustody} in custody.`);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
