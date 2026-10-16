/** Pure warning policy. Level estimates are supplied by the caller, not computed here. */

export const LOUDNESS_JUMP_DB = 3;
/** Allow for Q23 quantization of the preamp when comparing level differences. */
export const LOUDNESS_TOLERANCE_DB = 1e-6;
export const LOUDNESS_WARNING_TEXT =
  'A nova curva pode soar mais alta. Abaixe o volume antes de gravar.';

/**
 * deltaDb is null when either level or their difference is non-finite. Reasons
 * have stable order: jump first, then unknown-state. A warning is advisory.
 * @param {{newLevelDb: number, lastWrittenLevelDb?: number | null,
 *   sessionWriteCount: number, lastJournalStatus?: string | null}} input
 * @returns {{warn: boolean, reasons: ('jump' | 'unknown-state')[], deltaDb: number | null}}
 */
export function loudnessWarning({
  newLevelDb,
  lastWrittenLevelDb,
  sessionWriteCount,
  lastJournalStatus,
}) {
  const difference = typeof lastWrittenLevelDb === 'number' ? newLevelDb - lastWrittenLevelDb : NaN;
  const finiteLevels =
    Number.isFinite(newLevelDb) &&
    Number.isFinite(lastWrittenLevelDb) &&
    Number.isFinite(difference);
  const deltaDb = finiteLevels ? difference : null;
  /** @type {('jump' | 'unknown-state')[]} */
  const reasons = [];
  if (deltaDb !== null && deltaDb >= LOUDNESS_JUMP_DB - LOUDNESS_TOLERANCE_DB) {
    reasons.push('jump');
  }
  if (
    !finiteLevels ||
    !Number.isSafeInteger(sessionWriteCount) ||
    sessionWriteCount <= 0 ||
    lastJournalStatus === 'interrupted'
  ) {
    reasons.push('unknown-state');
  }
  return { warn: reasons.length > 0, reasons, deltaDb };
}
