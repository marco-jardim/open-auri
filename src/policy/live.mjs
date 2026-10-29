/**
 * Pure pacing and hold policy for live (no-flash) cable previews. Clocks and
 * level estimates are supplied by the caller. The report-8 gate that keeps
 * live data out of flash is not decided here; it runs in the transport.
 */

import { MIN_INTERVAL_MS } from './flash.mjs';
import { LOUDNESS_JUMP_DB, LOUDNESS_TOLERANCE_DB } from './loudness.mjs';

/** Wait after the last edit before applying it. */
export const LIVE_DEBOUNCE_MS = 200;
/** Cap on the wait while edits keep coming, measured from the first pending edit. */
export const LIVE_MAX_WAIT_MS = 600;
/**
 * Lower bound on the spacing between the starts of two live applies, start to
 * start only. It is not the length of an apply: a real one takes
 * 9 × (sendReport I/O latency + 16 ms) + 150 ms of settle, which is more than
 * 294 ms whenever the I/O takes any time at all. The scheduler must therefore
 * also wait for the apply in flight to finish (the transport refuses a second
 * one on the same device with ConcurrentWriteError) before it starts the next;
 * this interval never replaces that wait.
 */
export const LIVE_MIN_INTERVAL_MS = 300;
/**
 * Minimum time from the last commit (a flash write) to the start of a live
 * apply. Unverified hardware fact: nobody has measured whether the chip is
 * still busy with its flash write when new data reports arrive, so this is
 * deliberately conservative and reuses the flash policy's own spacing
 * between writes (MIN_INTERVAL_MS) rather than a separate guess.
 */
export const LIVE_AFTER_COMMIT_MS = MIN_INTERVAL_MS;
/** At most 1 apply in flight plus this many pending; the newest pending wins. */
export const LIVE_MAX_PENDING = 1;

/** @param {unknown} value @param {string} name @returns {number} */
function finiteMs(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite millisecond value`);
  }
  return value;
}

/** Remaining part of a wait; a clock earlier than the anchor restarts the full wait.
 * @param {number} waitMs @param {number} nowMs @param {number} anchorMs
 */
function remaining(waitMs, nowMs, anchorMs) {
  return Math.max(0, waitMs - Math.max(0, nowMs - anchorMs));
}

/** Wait imposed by an optional anchor: none when it is null or omitted.
 * @param {number} waitMs @param {number} nowMs @param {unknown} anchorMs @param {string} name
 */
function optionalWait(waitMs, nowMs, anchorMs, name) {
  return anchorMs === null || anchorMs === undefined
    ? 0
    : remaining(waitMs, nowMs, finiteMs(anchorMs, name));
}

/**
 * Milliseconds to wait before applying the pending edit (0 = apply now). The
 * edit is due at the earlier of debounce (lastEditMs + 200) and max-wait
 * (firstPendingEditMs + 600), but never before lastApplyStartMs + 300 nor
 * before lastCommitMs + LIVE_AFTER_COMMIT_MS (2000). A null or omitted
 * lastApplyStartMs means no live apply has started yet; a null or omitted
 * lastCommitMs means no commit to wait for. Like the flash policy, an anchor
 * later than nowMs (clock went backwards) yields at most the full wait from
 * nowMs, never a wait until the old clock catches up.
 *
 * Throws a RangeError when `input` is not an object, when a clock value is not
 * a finite number, or when lastEditMs is earlier than firstPendingEditMs (the
 * last edit can never precede the first pending one).
 * @param {{nowMs: number, lastEditMs: number, firstPendingEditMs: number,
 *   lastApplyStartMs?: number | null, lastCommitMs?: number | null}} input
 * @returns {number}
 */
export function nextApplyDelay(input) {
  if (input === null || typeof input !== 'object') {
    throw new RangeError('nextApplyDelay needs an input object');
  }
  const { nowMs, lastEditMs, firstPendingEditMs, lastApplyStartMs, lastCommitMs } = input;
  const now = finiteMs(nowMs, 'nowMs');
  const lastEdit = finiteMs(lastEditMs, 'lastEditMs');
  const firstPending = finiteMs(firstPendingEditMs, 'firstPendingEditMs');
  if (lastEdit < firstPending) {
    throw new RangeError('lastEditMs must not be earlier than firstPendingEditMs');
  }
  const editWait = Math.min(
    remaining(LIVE_DEBOUNCE_MS, now, lastEdit),
    remaining(LIVE_MAX_WAIT_MS, now, firstPending),
  );
  return Math.max(
    editWait,
    optionalWait(LIVE_MIN_INTERVAL_MS, now, lastApplyStartMs, 'lastApplyStartMs'),
    optionalWait(LIVE_AFTER_COMMIT_MS, now, lastCommitMs, 'lastCommitMs'),
  );
}

/**
 * Merge a new edit into the single pending slot: the newest edit wins and the
 * older pending one is dropped, never queued or merged field by field. Each
 * edit is a complete curve, so only the latest matters. The apply in flight is
 * not part of this slot and is never cancelled.
 * @template T
 * @param {T | null | undefined} pending
 * @param {T} next
 * @returns {T}
 */
export function coalesce(pending, next) {
  return next;
}

/**
 * @typedef {{reason: 'loudness', deltaDb: number} | {reason: 'unknown-state'}} LiveHold
 */

/** States in which the cable's curve is known; anything else holds. */
const KNOWN_STATES = Object.freeze(['known']);

/** @param {unknown} value @returns {value is number} */
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Decide whether a live apply must wait for the user. Returns null to send.
 * The comparison is always against ackLevelDb, the level the user last
 * confirmed, never against the previous live apply: many small +2.9 dB steps
 * therefore cannot creep past the threshold, because each is measured from the
 * same confirmed level and holds once the cumulative rise reaches 3 dB. The
 * threshold matches loudnessWarning, including its Q23 rounding tolerance.
 * Decreases never hold.
 *
 * Fail safe: only `state === 'known'` may send. Any other state ('unknown',
 * null, omitted, a typo), a non-object input, a level that is not a finite
 * number (types are checked before any arithmetic, so BigInts and objects
 * never reach it and no valueOf runs), or an overflowed difference holds as
 * unknown-state.
 * @param {{levelDb: number, ackLevelDb?: number | null, state?: string | null}} input
 * @returns {LiveHold | null}
 */
export function liveHold(input) {
  if (input === null || typeof input !== 'object') return { reason: 'unknown-state' };
  const { levelDb, ackLevelDb, state } = input;
  if (
    typeof state !== 'string' ||
    !KNOWN_STATES.includes(state) ||
    !isFiniteNumber(levelDb) ||
    !isFiniteNumber(ackLevelDb)
  ) {
    return { reason: 'unknown-state' };
  }
  const deltaDb = levelDb - ackLevelDb;
  if (!Number.isFinite(deltaDb)) return { reason: 'unknown-state' };
  if (deltaDb >= LOUDNESS_JUMP_DB - LOUDNESS_TOLERANCE_DB) {
    return { reason: 'loudness', deltaDb };
  }
  return null;
}
