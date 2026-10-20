/**
 * Active bands require positive finite freqHz/qFactor. PK/LS/HS require finite
 * gainDb; LP/HP may omit it, but it must be finite when present. OFF ignores all
 * other fields. No safety-gate limits are applied. Extra properties are ignored
 * and stripped when storing records. Text limits count Unicode code points.
 * @param {unknown} entry
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateEntry(entry: unknown): {
    ok: boolean;
    errors: string[];
};
/** Throws TypeError for an invalid new entry; never mutates either argument.
 * @param {readonly JournalEntry[]} entries
 * @param {unknown} entry
 * @returns {JournalEntry[]}
 */
export function appendEntry(entries: readonly JournalEntry[], entry: unknown): JournalEntry[];
/**
 * Invalid JSON/non-arrays return no entries and dropped = 0 (no enumerable
 * records). For arrays, dropped counts invalid records plus FIFO overflow.
 * @param {string | null} raw
 * @returns {{entries: JournalEntry[], dropped: number}}
 */
export function parseJournal(raw: string | null): {
    entries: JournalEntry[];
    dropped: number;
};
/** Validate and serialize at most the newest 500 entries. Invalid entries throw.
 * @param {readonly JournalEntry[]} entries @returns {string}
 */
export function serializeJournal(entries: readonly JournalEntry[]): string;
/** @param {readonly JournalEntry[]} entries @returns {JournalEntry | null} */
export function lastEntry(entries: readonly JournalEntry[]): JournalEntry | null;
/** Pure write journal. `at` is a nonnegative integer epoch timestamp in milliseconds.
 * This validates record structure, not acoustic safety or permission to write.
 */
/** localStorage JSON array, oldest entry first. */
export const JOURNAL_STORAGE_KEY: "oa.journal";
export const JOURNAL_MAX: 500;
/** Most waived codes one entry keeps (the gate has 8 waivable codes). */
export const JOURNAL_WAIVED_MAX: 16;
export type JournalBand = import("../dsp/eq0xcb.mjs").Band;
export type JournalEntry = {
    schema: 1;
    at: number;
    name: string;
    crc: number;
    preampDb: number;
    bands: JournalBand[];
    status: "ok" | "interrupted" | "simulated";
    device: string | null;
    profile?: "yolo";
    waived?: string[];
    freshness?: JournalFreshness;
};
/**
 * `profile: 'yolo'` marks a write made in Modo YOLO (gate profile 'yolo') and
 * `waived` lists the class-2 reason codes that write waived. `freshness` marks a
 * write from the Android app: `basis: 'live'` when the server confirmed the
 * deployed page just before it, `'last-good'` when the check was unavailable and
 * the write relied on the last confirmation of the same page, from `checkedAt`
 * (epoch ms). All are optional and absent on every other entry, so schema 1
 * records written before them stay valid and are stored byte for byte as before.
 */
export type JournalFreshness = {
    basis: "live" | "last-good";
    checkedAt: number;
};
