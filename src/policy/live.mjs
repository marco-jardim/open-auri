/**
 * Pure pacing and hold policy for live (no-flash) cable previews. Clocks and
 * level estimates are supplied by the caller. The report-8 gate that keeps
 * live data out of flash is not decided here; it runs in the transport.
 */

import { LOUDNESS_JUMP_DB, LOUDNESS_TOLERANCE_DB } from './loudness.mjs';

/** Wait after the last edit before applying it. */
export const LIVE_DEBOUNCE_MS = 200;
/** Cap on the wait while edits keep coming, measured from the first pending edit. */
export const LIVE_MAX_WAIT_MS = 600;
/**
 * Minimum spacing between the starts of two live applies. One sequence sends
 * 9 reports at about 16 ms each (144 ms) and then lets the cable settle for
 * 150 ms: 294 ms, rounded up to 300 ms so a new apply never overlaps the
 * settle of the previous one.
 * @type {number}
 */
export const LIVE_MIN_INTERVAL_MS = 300;
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

/**
 * Milliseconds to wait before applying the pending edit (0 = apply now). The
 * edit is due at the earlier of debounce (lastEditMs + 200) and max-wait
 * (firstPendingEditMs + 600), but never before lastApplyStartMs + 300. A null
 * or omitted lastApplyStartMs means no live apply has started yet. Like the
 * flash policy, an anchor later than nowMs (clock went backwards) yields at
 * most the full wait from nowMs, never a wait until the old clock catches up.
 * @param {{nowMs: number, lastEditMs: number, firstPendingEditMs: number,
 *   lastApplyStartMs?: number | null}} input
 * @returns {number}
 */
export function nextApplyDelay({ nowMs, lastEditMs, firstPendingEditMs, lastApplyStartMs }) {
  const now = finiteMs(nowMs, 'nowMs');
  const editWait = Math.min(
    remaining(LIVE_DEBOUNCE_MS, now, finiteMs(lastEditMs, 'lastEditMs')),
    remaining(LIVE_MAX_WAIT_MS, now, finiteMs(firstPendingEditMs, 'firstPendingEditMs')),
  );
  const intervalWait =
    lastApplyStartMs === null || lastApplyStartMs === undefined
      ? 0
      : remaining(LIVE_MIN_INTERVAL_MS, now, finiteMs(lastApplyStartMs, 'lastApplyStartMs'));
  return Math.max(editWait, intervalWait);
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

/**
 * Decide whether a live apply must wait for the user. Returns null to send.
 * The comparison is always against ackLevelDb, the level the user last
 * confirmed, never against the previous live apply: many small +2.9 dB steps
 * therefore cannot creep past the threshold, because each is measured from the
 * same confirmed level and holds once the cumulative rise reaches 3 dB. The
 * threshold matches loudnessWarning, including its Q23 rounding tolerance.
 * Decreases never hold. An 'unknown' state, a missing or non-finite level, or
 * an overflowed difference holds as unknown-state.
 * @param {{levelDb: number, ackLevelDb?: number | null, state?: string | null}} input
 * @returns {LiveHold | null}
 */
export function liveHold({ levelDb, ackLevelDb, state }) {
  const deltaDb = typeof ackLevelDb === 'number' ? levelDb - ackLevelDb : NaN;
  if (
    state === 'unknown' ||
    !Number.isFinite(levelDb) ||
    !Number.isFinite(ackLevelDb) ||
    !Number.isFinite(deltaDb)
  ) {
    return { reason: 'unknown-state' };
  }
  if (deltaDb >= LOUDNESS_JUMP_DB - LOUDNESS_TOLERANCE_DB) {
    return { reason: 'loudness', deltaDb };
  }
  return null;
}
