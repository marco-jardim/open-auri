/** Pure warning policy. Level estimates are supplied by the caller, not computed here. */
export declare const LOUDNESS_JUMP_DB = 3;
/** Allow for Q23 quantization of the preamp when comparing level differences. */
export declare const LOUDNESS_TOLERANCE_DB = 0.000001;
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
