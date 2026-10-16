/** Local calendar date, deliberately not UTC. The clock itself is always injected.
 * @param {number} nowMs @returns {string}
 */
export function localDateKey(nowMs: number): string;
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
export function observeFlashState(state: FlashState, nowMs: number): FlashState;
/**
 * A negative elapsed time or unknown timestamp returns a full 2000 ms wait
 * relative to this observation, never a wait until the old clock catches up.
 * This query does not mutate state: use observeFlashState to retain that anchor
 * across polling, or supply nowMs to parseFlashState when loading storage.
 * @param {FlashState} state
 * @param {number} nowMs
 * @returns {{ok: boolean, waitMs: number}}
 */
export function canWriteNow(state: FlashState, nowMs: number): {
    ok: boolean;
    waitMs: number;
};
/** Record an actual write, not a permission check. The caller must honor canWriteNow.
 * @param {FlashState} state
 * @param {number} nowMs
 * @param {(nowMs: number) => string} [dateKey]
 * @returns {FlashState}
 */
export function recordWrite(state: FlashState, nowMs: number, dateKey?: (nowMs: number) => string): FlashState;
/** @param {FlashState} state
 * @param {number} nowMs
 * @param {(nowMs: number) => string} [dateKey]
 * @returns {boolean}
 */
export function dailyNotice(state: FlashState, nowMs: number, dateKey?: (nowMs: number) => string): boolean;
/**
 * Invalid/missing lastWriteAt remains unknown, not zero. Pass the injected nowMs
 * to immediately anchor its cooldown, or call observeFlashState before polling.
 * @param {RawFlashState} raw
 * @param {number} [nowMs]
 * @returns {FlashState}
 */
export function parseFlashState(raw: RawFlashState, nowMs?: number): FlashState;
/** Raw strings use the storage contract's JSON object and JSON numbers.
 * Unknown timestamps serialize as JSON null, retaining the conservative wait.
 * @param {FlashState} state @returns {RawFlashState}
 */
export function serializeFlashState(state: FlashState): RawFlashState;
/** Pure flash-wear bookkeeping. Storage adapters read and write the raw strings. */
/** localStorage keys, except `session`, which belongs in sessionStorage. */
export const FLASH_STORAGE_KEYS: Readonly<{
    day: "oa.flash.day";
    total: "oa.flash.total";
    lastWriteAt: "oa.flash.lastWriteAt";
    session: "oa.flash.session";
}>;
export const MIN_INTERVAL_MS: 2000;
export const DAILY_NOTICE_THRESHOLD: 50;
export const FLASH_NOTICE_TEXT: "A mem\u00F3ria do cabo tem vida \u00FAtil desconhecida; mem\u00F3rias desse tipo costumam aguentar de 10 mil a 1 milh\u00E3o de grava\u00E7\u00F5es.";
/**
 * A null timestamp means unknown, never "no cooldown". A null date is a reset day.
 * Counters saturate at MAX_SAFE_INTEGER rather than lose integer precision; they
 * never impose a write limit.
 */
export type FlashDay = {
    date: string | null;
    count: number;
};
/**
 * A null timestamp means unknown, never "no cooldown". A null date is a reset day.
 * Counters saturate at MAX_SAFE_INTEGER rather than lose integer precision; they
 * never impose a write limit.
 */
export type FlashState = {
    day: FlashDay;
    total: number;
    lastWriteAt: number | null;
    session: number;
};
/**
 * A null timestamp means unknown, never "no cooldown". A null date is a reset day.
 * Counters saturate at MAX_SAFE_INTEGER rather than lose integer precision; they
 * never impose a write limit.
 */
export type RawFlashState = {
    day: string | null;
    total: string | null;
    lastWriteAt: string | null;
    session: string | null;
};
