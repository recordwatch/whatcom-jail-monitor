import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { scrapeRoster } from './scrapers/whatcom.js';
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

async function run() {
  console.log(`[${nowPST()}] Running Whatcom County scrape...`);

  let roster = readJSON(ROSTER_FILE, {});
  let log    = readJSON(LOG_FILE, []);

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
    const reversal = { releasedAt: entry.releasedAt, reversedAt: now };
    entry.releaseReversals = [...(entry.releaseReversals || []), reversal];
    entry.status = 'in_custody';
    entry.releasedAt = null;
    const logEntry = log.find(e => e.idnum === b.booking_num);
    if (logEntry) {
      logEntry.releaseReversals = entry.releaseReversals;
      logEntry.status = entry.status;
      logEntry.releasedAt = null;
    }
  }

  // Releases — in previous roster but no longer on the current page.
  for (const id of releasedIds) {
    const inmate = roster[id];
    console.log(`  RELEASED: ${inmate.name}`);
    roster[id].status     = 'released';
    roster[id].releasedAt = now;
    const logEntry = log.find(e => e.idnum === id);
    if (logEntry) {
      logEntry.status     = 'released';
      logEntry.releasedAt = roster[id].releasedAt;
    }
  }

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
