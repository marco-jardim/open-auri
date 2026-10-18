/**
 * @typedef {object} Thresholds
 * @property {readonly string[]} coefficientPositions Wire order of the section words.
 * @property {readonly number[]} coefficientAbsWords Largest |Q27 word| per wire position.
 * @property {readonly number[]} coefficientAbs Same limits as normalized coefficients.
 * @property {number} poleRadius Largest quantized pole radius.
 * @property {number} sectionPeakDb Largest single-section peak, DC–48 kHz (dB).
 * @property {number} internalAudibleDb Largest prefix peak with preamp, 20 Hz–20 kHz (dB).
 * @property {number} outputAudibleDb Largest output peak with preamp, 20 Hz–20 kHz (dB).
 * @property {number} outputFullDb Largest output peak with preamp, DC–48 kHz (dB).
 * @property {number} preampMaxDb Highest nominal preamp (dB).
 * @property {number} preampMinDb Lowest nominal preamp (dB).
 * @property {number} dbNumericalTolerance Computation tolerance on dB limits.
 * @property {number} radiusNumericalTolerance Computation tolerance on the pole radius.
 */
/**
 * @typedef {object} Provenance
 * @property {string} source Repository-relative path of the source data.
 * @property {string} sha256 SHA-256 of the source text, line endings normalized to LF.
 * @property {string} generatedBy Repository-relative path of the generator.
 */
/** @type {Readonly<Thresholds>} */
export const THRESHOLDS: Readonly<Thresholds>;
/** @type {Readonly<Provenance>} */
export const PROVENANCE: Readonly<Provenance>;
/**
 * @typedef {object} YoloThresholds
 * @property {number} internalFullDb Largest prefix peak with preamp, DC–48 kHz (dB): the
 *   `d:prefix-peak-full` limit.
 * @property {number} internalExtendedDb Largest prefix peak with preamp, 20 Hz–48 kHz (dB):
 *   the `d:prefix-peak-extended` limit.
 * @property {number} outputExtendedDb Largest output peak with preamp, 20 Hz–48 kHz (dB): the
 *   `e:output-extended` limit.
 */
/** @type {Readonly<YoloThresholds>} */
export const YOLO_THRESHOLDS: Readonly<YoloThresholds>;
export type Thresholds = {
    /**
     * Wire order of the section words.
     */
    coefficientPositions: readonly string[];
    /**
     * Largest |Q27 word| per wire position.
     */
    coefficientAbsWords: readonly number[];
    /**
     * Same limits as normalized coefficients.
     */
    coefficientAbs: readonly number[];
    /**
     * Largest quantized pole radius.
     */
    poleRadius: number;
    /**
     * Largest single-section peak, DC–48 kHz (dB).
     */
    sectionPeakDb: number;
    /**
     * Largest prefix peak with preamp, 20 Hz–20 kHz (dB).
     */
    internalAudibleDb: number;
    /**
     * Largest output peak with preamp, 20 Hz–20 kHz (dB).
     */
    outputAudibleDb: number;
    /**
     * Largest output peak with preamp, DC–48 kHz (dB).
     */
    outputFullDb: number;
    /**
     * Highest nominal preamp (dB).
     */
    preampMaxDb: number;
    /**
     * Lowest nominal preamp (dB).
     */
    preampMinDb: number;
    /**
     * Computation tolerance on dB limits.
     */
    dbNumericalTolerance: number;
    /**
     * Computation tolerance on the pole radius.
     */
    radiusNumericalTolerance: number;
};
export type Provenance = {
    /**
     * Repository-relative path of the source data.
     */
    source: string;
    /**
     * SHA-256 of the source text, line endings normalized to LF.
     */
    sha256: string;
    /**
     * Repository-relative path of the generator.
     */
    generatedBy: string;
};
export type YoloThresholds = {
    /**
     * Largest prefix peak with preamp, DC–48 kHz (dB): the
     * `d:prefix-peak-full` limit.
     */
    internalFullDb: number;
    /**
     * Largest prefix peak with preamp, 20 Hz–48 kHz (dB):
     * the `d:prefix-peak-extended` limit.
     */
    internalExtendedDb: number;
    /**
     * Largest output peak with preamp, 20 Hz–48 kHz (dB): the
     * `e:output-extended` limit.
     */
    outputExtendedDb: number;
};
