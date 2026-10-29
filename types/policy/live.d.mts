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
export function nextApplyDelay(input: {
    nowMs: number;
    lastEditMs: number;
    firstPendingEditMs: number;
    lastApplyStartMs?: number | null;
    lastCommitMs?: number | null;
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
export function liveHold(input: {
    levelDb: number;
    ackLevelDb?: number | null;
    state?: string | null;
}): LiveHold | null;
/** Wait after the last edit before applying it. */
export const LIVE_DEBOUNCE_MS: 200;
/** Cap on the wait while edits keep coming, measured from the first pending edit. */
export const LIVE_MAX_WAIT_MS: 600;
/**
 * Lower bound on the spacing between the starts of two live applies, start to
 * start only. It is not the length of an apply: a real one takes
 * 9 × (sendReport I/O latency + 16 ms) + 150 ms of settle, which is more than
 * 294 ms whenever the I/O takes any time at all. The scheduler must therefore
 * also wait for the apply in flight to finish (the transport refuses a second
 * one on the same device with ConcurrentWriteError) before it starts the next;
 * this interval never replaces that wait.
 */
export const LIVE_MIN_INTERVAL_MS: 300;
/**
 * Minimum time from the last commit (a flash write) to the start of a live
 * apply. Unverified hardware fact: nobody has measured whether the chip is
 * still busy with its flash write when new data reports arrive, so this is
 * deliberately conservative and reuses the flash policy's own spacing
 * between writes (MIN_INTERVAL_MS) rather than a separate guess.
 */
export const LIVE_AFTER_COMMIT_MS: 2000;
/** At most 1 apply in flight plus this many pending; the newest pending wins. */
export const LIVE_MAX_PENDING: 1;
export type LiveHold = {
    reason: "loudness";
    deltaDb: number;
} | {
    reason: "unknown-state";
};
