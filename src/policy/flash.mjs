/** Pure flash-wear bookkeeping. Storage adapters read and write the raw strings. */

/** localStorage keys, except `session`, which belongs in sessionStorage. */
export const FLASH_STORAGE_KEYS = Object.freeze({
  day: 'oa.flash.day',
  total: 'oa.flash.total',
  lastWriteAt: 'oa.flash.lastWriteAt',
  session: 'oa.flash.session',
});

export const MIN_INTERVAL_MS = 2000;
export const DAILY_NOTICE_THRESHOLD = 50;
export const FLASH_NOTICE_TEXT =
  'A memória do cabo tem vida útil desconhecida; memórias desse tipo costumam aguentar de 10 mil a 1 milhão de gravações.';

/**
 * A null timestamp means unknown, never "no cooldown". A null date is a reset day.
 * Counters saturate at MAX_SAFE_INTEGER rather than lose integer precision; they
 * never impose a write limit.
 * @typedef {{date: string | null, count: number}} FlashDay
 * @typedef {{day: FlashDay, total: number, lastWriteAt: number | null, session: number}} FlashState
 * @typedef {{day: string | null, total: string | null, lastWriteAt: string | null,
 *   session: string | null}} RawFlashState
 */

/** @param {unknown} value @returns {value is number} */
function isTimestamp(value) {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8640000000000000
  );
}

/** @param {number} nowMs */
function assertNowMs(nowMs) {
  if (!isTimestamp(nowMs)) {
    throw new RangeError('nowMs must be a valid nonnegative epoch millisecond');
  }
}

/** @param {unknown} value @returns {number} */
function safeCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** @param {string | null} raw @returns {unknown} */
function parseRaw(raw) {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Validate actual Gregorian calendar dates, not just their shape.
 * @param {unknown} value @returns {value is string}
 */
function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

/** Local calendar date, deliberately not UTC. The clock itself is always injected.
 * @param {number} nowMs @returns {string}
 */
export function localDateKey(nowMs) {
  assertNowMs(nowMs);
  const date = new Date(nowMs);
  const key = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
  if (!isDateKey(key)) throw new RangeError('Local date must fit YYYY-MM-DD');
  return key;
}

/**
 * Observe before checking a write. Unknown timestamps or a clock earlier than
 * lastWriteAt are rebased to this observation, as if just written. Persist the
 * returned state. With a subsequently monotonic clock the wait expires exactly
 * 2000 ms later, even if the old timestamp was years in the future. Every new
 * backwards jump starts a fresh, bounded wait at that observation.
 * @param {FlashState} state
 * @param {number} nowMs
 * @returns {FlashState}
 */
export function observeFlashState(state, nowMs) {
  assertNowMs(nowMs);
  return {
    ...state,
    day: { ...state.day },
    lastWriteAt:
      !isTimestamp(state.lastWriteAt) || nowMs < state.lastWriteAt ? nowMs : state.lastWriteAt,
  };
}

/**
 * A negative elapsed time or unknown timestamp returns a full 2000 ms wait
 * relative to this observation, never a wait until the old clock catches up.
 * This query does not mutate state: use observeFlashState to retain that anchor
 * across polling, or supply nowMs to parseFlashState when loading storage.
 * @param {FlashState} state
 * @param {number} nowMs
 * @returns {{ok: boolean, waitMs: number}}
 */
export function canWriteNow(state, nowMs) {
  assertNowMs(nowMs);
  const elapsed = isTimestamp(state.lastWriteAt) ? Math.max(0, nowMs - state.lastWriteAt) : 0;
  const waitMs = Math.max(0, MIN_INTERVAL_MS - elapsed);
  return { ok: waitMs === 0, waitMs };
}

/** Record an actual write, not a permission check. The caller must honor canWriteNow.
 * @param {FlashState} state
 * @param {number} nowMs
 * @param {(nowMs: number) => string} [dateKey]
 * @returns {FlashState}
 */
export function recordWrite(state, nowMs, dateKey = localDateKey) {
  assertNowMs(nowMs);
  const date = dateKey(nowMs);
  if (!isDateKey(date)) throw new RangeError('dateKey must return YYYY-MM-DD');
  const count = state.day.date === date ? safeCount(state.day.count) : 0;
  return {
    day: { date, count: Math.min(Number.MAX_SAFE_INTEGER, count + 1) },
    total: Math.min(Number.MAX_SAFE_INTEGER, safeCount(state.total) + 1),
    lastWriteAt: nowMs,
    session: Math.min(Number.MAX_SAFE_INTEGER, safeCount(state.session) + 1),
  };
}

/** @param {FlashState} state
 * @param {number} nowMs
 * @param {(nowMs: number) => string} [dateKey]
 * @returns {boolean}
 */
export function dailyNotice(state, nowMs, dateKey = localDateKey) {
  assertNowMs(nowMs);
  const date = dateKey(nowMs);
  if (!isDateKey(date)) throw new RangeError('dateKey must return YYYY-MM-DD');
  return state.day.date === date && safeCount(state.day.count) >= DAILY_NOTICE_THRESHOLD;
}

/**
 * Invalid/missing lastWriteAt remains unknown, not zero. Pass the injected nowMs
 * to immediately anchor its cooldown, or call observeFlashState before polling.
 * @param {RawFlashState} raw
 * @param {number} [nowMs]
 * @returns {FlashState}
 */
export function parseFlashState(raw, nowMs) {
  const day = parseRaw(raw.day);
  const lastWriteAt = parseRaw(raw.lastWriteAt);
  /** @type {FlashDay} */
  let parsedDay = { date: null, count: 0 };
  if (typeof day === 'object' && day !== null && 'date' in day && isDateKey(day.date)) {
    parsedDay = { date: day.date, count: safeCount('count' in day ? day.count : null) };
  }
  const state = {
    day: parsedDay,
    total: safeCount(parseRaw(raw.total)),
    lastWriteAt: isTimestamp(lastWriteAt) ? lastWriteAt : null,
    session: safeCount(parseRaw(raw.session)),
  };
  return nowMs === undefined ? state : observeFlashState(state, nowMs);
}

/** Raw strings use the storage contract's JSON object and JSON numbers.
 * Unknown timestamps serialize as JSON null, retaining the conservative wait.
 * @param {FlashState} state @returns {RawFlashState}
 */
export function serializeFlashState(state) {
  return {
    day: JSON.stringify(state.day),
    total: JSON.stringify(state.total),
    lastWriteAt: JSON.stringify(state.lastWriteAt),
    session: JSON.stringify(state.session),
  };
}
