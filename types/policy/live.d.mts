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
export function nextApplyDelay({ nowMs, lastEditMs, firstPendingEditMs, lastApplyStartMs }: {
    nowMs: number;
    lastEditMs: number;
    firstPendingEditMs: number;
    lastApplyStartMs?: number | null;
}): number;
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
export function coalesce<T>(pending: T | null | undefined, next: T): T;
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
export function liveHold({ levelDb, ackLevelDb, state }: {
    levelDb: number;
    ackLevelDb?: number | null;
    state?: string | null;
}): LiveHold | null;
/** Wait after the last edit before applying it. */
export const LIVE_DEBOUNCE_MS: 200;
/** Cap on the wait while edits keep coming, measured from the first pending edit. */
export const LIVE_MAX_WAIT_MS: 600;
/**
 * Minimum spacing between the starts of two live applies. One sequence sends
 * 9 reports at about 16 ms each (144 ms) and then lets the cable settle for
 * 150 ms: 294 ms, rounded up to 300 ms so a new apply never overlaps the
 * settle of the previous one.
 * @type {number}
 */
export const LIVE_MIN_INTERVAL_MS: number;
/** At most 1 apply in flight plus this many pending; the newest pending wins. */
export const LIVE_MAX_PENDING: 1;
export type LiveHold = {
    reason: "loudness";
    deltaDb: number;
} | {
    reason: "unknown-state";
};
