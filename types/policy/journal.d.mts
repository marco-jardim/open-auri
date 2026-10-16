/** Pure write journal. `at` is a nonnegative integer epoch timestamp in milliseconds.
 * This validates record structure, not acoustic safety or permission to write.
 */
/** localStorage JSON array, oldest entry first. */
export declare const JOURNAL_STORAGE_KEY = "oa.journal";
export declare const JOURNAL_MAX = 500;
export type JournalBand = {
    kind: 'PK' | 'LS' | 'HS' | 'LP' | 'HP';
    freqHz: number;
    gainDb: number;
    qFactor: number;
} | {
    kind: 'OFF';
};
export type JournalEntry = {
    schema: 1;
    at: number;
    name: string;
    crc: number;
    preampDb: number;
    bands: JournalBand[];
    status: 'ok' | 'interrupted' | 'simulated';
    device: string | null;
};
/**
 * Active bands require all four fields, positive freqHz/qFactor and finite
 * gainDb. Supported kinds are PK, LS, HS, LP, HP and OFF. No safety-gate limits
 * are applied. Extra properties are ignored and stripped when storing records.
 * @param {unknown} entry
 * @returns {{ok: boolean, errors: string[]}}
 */
export declare function validateEntry(entry: unknown): {
    ok: boolean;
    errors: string[];
};
/** Throws TypeError for an invalid new entry; never mutates either argument.
 * @param {readonly JournalEntry[]} entries
 * @param {unknown} entry
 * @returns {JournalEntry[]}
 */
export declare function appendEntry(entries: readonly JournalEntry[], entry: unknown): JournalEntry[];
/**
 * Invalid JSON/non-arrays return no entries and dropped = 0 (no enumerable
 * records). For arrays, dropped counts invalid records plus FIFO overflow.
 * @param {string | null} raw
 * @returns {{entries: JournalEntry[], dropped: number}}
 */
export declare function parseJournal(raw: string | null): {
    entries: JournalEntry[];
    dropped: number;
};
/** Validate and serialize at most the newest 500 entries. Invalid entries throw.
 * @param {readonly JournalEntry[]} entries @returns {string}
 */
export declare function serializeJournal(entries: readonly JournalEntry[]): string;
/** @param {readonly JournalEntry[]} entries @returns {JournalEntry | null} */
export declare function lastEntry(entries: readonly JournalEntry[]): JournalEntry | null;
