/** Pure warning policy. Level estimates are supplied by the caller, not computed here. */
export declare const LOUDNESS_JUMP_DB = 3;
/**
 * Over the allowed preamp range (-25.5 to -0.5 dB), Q23 rounding is worst at
 * word_min = round(10 ** (-25.5 / 20) * 2 ** 23). Each level can round by half
 * a word, so the difference error is bounded by
 * 2 * 20 * log10(1 + 0.5 / word_min), approximately 1.95e-5 dB.
 * Use a round tolerance comfortably above this bound and far below audibility.
 * @type {number}
 */
export declare const LOUDNESS_TOLERANCE_DB: number;
export declare const LOUDNESS_WARNING_TEXT = "A nova curva pode soar mais alta. Abaixe o volume antes de gravar.";
/**
 * deltaDb is null when either level or their difference is non-finite. Reasons
 * have stable order: jump first, then unknown-state. A warning is advisory.
 * @param {{newLevelDb: number, lastWrittenLevelDb?: number | null,
 *   sessionWriteCount: number, lastJournalStatus?: string | null}} input
 * @returns {{warn: boolean, reasons: ('jump' | 'unknown-state')[], deltaDb: number | null}}
 */
export declare function loudnessWarning({ newLevelDb, lastWrittenLevelDb, sessionWriteCount, lastJournalStatus, }: {
    newLevelDb: number;
    lastWrittenLevelDb?: number | null;
    sessionWriteCount: number;
    lastJournalStatus?: string | null;
}): {
    warn: boolean;
    reasons: ('jump' | 'unknown-state')[];
    deltaDb: number | null;
};
