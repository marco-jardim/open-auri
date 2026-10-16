/** Pure write journal. `at` is a nonnegative integer epoch timestamp in milliseconds.
 * This validates record structure, not acoustic safety or permission to write.
 */

/** localStorage JSON array, oldest entry first. */
export const JOURNAL_STORAGE_KEY = 'oa.journal';
export const JOURNAL_MAX = 500;

/**
 * @typedef {import('../dsp/eq0xcb.mjs').Band} JournalBand
 * @typedef {{schema: 1, at: number, name: string, crc: number, preampDb: number,
 *   bands: JournalBand[], status: 'ok' | 'interrupted' | 'simulated',
 *   device: string | null}} JournalEntry
 */

const ACTIVE_KINDS = new Set(['PK', 'LS', 'HS', 'LP', 'HP']);
const STATUSES = new Set(['ok', 'interrupted', 'simulated']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is number} */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Active bands require positive finite freqHz/qFactor. PK/LS/HS require finite
 * gainDb; LP/HP may omit it, but it must be finite when present. OFF ignores all
 * other fields. No safety-gate limits are applied. Extra properties are ignored
 * and stripped when storing records. Text limits count Unicode code points.
 * @param {unknown} entry
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateEntry(entry) {
  /** @type {string[]} */
  const errors = [];
  if (!isRecord(entry)) return { ok: false, errors: ['entry must be an object'] };
  if (entry.schema !== 1) errors.push('schema must be 1');
  if (
    !isFiniteNumber(entry.at) ||
    !Number.isSafeInteger(entry.at) ||
    entry.at < 0 ||
    entry.at > 8640000000000000
  ) {
    errors.push('at must be a valid nonnegative epoch millisecond');
  }
  if (typeof entry.name !== 'string' || [...entry.name].length > 48) {
    errors.push('name must be a string of at most 48 characters');
  }
  if (
    !isFiniteNumber(entry.crc) ||
    !Number.isInteger(entry.crc) ||
    entry.crc < 0 ||
    entry.crc > 65535
  ) {
    errors.push('crc must be an integer from 0 to 65535');
  }
  if (!isFiniteNumber(entry.preampDb)) errors.push('preampDb must be finite');
  if (typeof entry.status !== 'string' || !STATUSES.has(entry.status)) {
    errors.push('status must be ok, interrupted or simulated');
  }
  if (
    entry.device !== null &&
    (typeof entry.device !== 'string' || [...entry.device].length > 64)
  ) {
    errors.push('device must be null or a string of at most 64 characters');
  }
  if (!Array.isArray(entry.bands) || entry.bands.length !== 10) {
    errors.push('bands must contain exactly 10 bands');
  } else {
    for (const [index, band] of entry.bands.entries()) {
      if (!isRecord(band)) {
        errors.push(`bands[${index}] must be an object`);
      } else if (band.kind !== 'OFF') {
        if (typeof band.kind !== 'string' || !ACTIVE_KINDS.has(band.kind)) {
          errors.push(`bands[${index}].kind is unsupported`);
        }
        if (!isFiniteNumber(band.freqHz) || band.freqHz <= 0) {
          errors.push(`bands[${index}].freqHz must be positive and finite`);
        }
        if (
          !isFiniteNumber(band.gainDb) &&
          ((band.kind !== 'LP' && band.kind !== 'HP') || 'gainDb' in band)
        ) {
          errors.push(`bands[${index}].gainDb must be finite`);
        }
        if (!isFiniteNumber(band.qFactor) || band.qFactor <= 0) {
          errors.push(`bands[${index}].qFactor must be positive and finite`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Canonicalize after validation, avoiding aliases and unvalidated extra properties.
 * @param {unknown} value @returns {JournalEntry}
 */
function checkedCopy(value) {
  const result = validateEntry(value);
  if (!result.ok) throw new TypeError(`Invalid journal entry: ${result.errors.join('; ')}`);
  const entry = /** @type {JournalEntry} */ (value);
  return {
    schema: 1,
    at: entry.at,
    name: entry.name,
    crc: entry.crc,
    preampDb: entry.preampDb,
    bands: entry.bands.map((band) => {
      if (band.kind === 'OFF') return { kind: 'OFF' };
      if (band.kind === 'PK' || band.kind === 'LS' || band.kind === 'HS') {
        return { kind: band.kind, freqHz: band.freqHz, gainDb: band.gainDb, qFactor: band.qFactor };
      }
      return {
        kind: band.kind,
        freqHz: band.freqHz,
        ...(band.gainDb === undefined ? {} : { gainDb: band.gainDb }),
        qFactor: band.qFactor,
      };
    }),
    status: entry.status,
    device: entry.device,
  };
}

/** Throws TypeError for an invalid new entry; never mutates either argument.
 * @param {readonly JournalEntry[]} entries
 * @param {unknown} entry
 * @returns {JournalEntry[]}
 */
export function appendEntry(entries, entry) {
  return [...entries, checkedCopy(entry)].slice(-JOURNAL_MAX);
}

/**
 * Invalid JSON/non-arrays return no entries and dropped = 0 (no enumerable
 * records). For arrays, dropped counts invalid records plus FIFO overflow.
 * @param {string | null} raw
 * @returns {{entries: JournalEntry[], dropped: number}}
 */
export function parseJournal(raw) {
  if (raw === null) return { entries: [], dropped: 0 };
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], dropped: 0 };
  }
  if (!Array.isArray(parsed)) return { entries: [], dropped: 0 };
  /** @type {JournalEntry[]} */
  const entries = [];
  let dropped = 0;
  for (const entry of parsed) {
    if (validateEntry(entry).ok) entries.push(checkedCopy(entry));
    else dropped += 1;
  }
  dropped += Math.max(0, entries.length - JOURNAL_MAX);
  return { entries: entries.slice(-JOURNAL_MAX), dropped };
}

/** Validate and serialize at most the newest 500 entries. Invalid entries throw.
 * @param {readonly JournalEntry[]} entries @returns {string}
 */
export function serializeJournal(entries) {
  return JSON.stringify(entries.map(checkedCopy).slice(-JOURNAL_MAX));
}

/** @param {readonly JournalEntry[]} entries @returns {JournalEntry | null} */
export function lastEntry(entries) {
  return entries.at(-1) ?? null;
}
