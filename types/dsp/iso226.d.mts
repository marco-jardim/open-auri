/**
 * SPL at any 20–20000 Hz. Table parameters, NOT computed SPLs, are interpolated
 * in log-frequency. The constant extension above 12.5 kHz is non-normative and
 * always flagged extrapolated. Exact preferred points reproduce equation (1).
 * @param {number} phon
 * @param {number} freqHz
 * @returns {SplResult}
 */
export function equalLoudnessSpl(phon: number, freqHz: number): SplResult;
/**
 * Sample SPL on the shared grid (or a supplied nonempty grid). The overall
 * validity is the least normative sample: extrapolated > informative > normative.
 * The default GRID includes the non-normative extension, so its flag is extrapolated.
 * @param {number} phon
 * @param {readonly number[]} [grid]
 * @returns {ContourResult}
 */
export function contour(phon: number, grid?: readonly number[]): ContourResult;
/**
 * The 29 SPLs, in ISO226_TABLE order, plus their combined validity.
 * @param {number} phon
 * @returns {ContourResult}
 */
export function splAtPreferred(phon: number): ContourResult;
/**
 * Static gain to preserve the reference balance at an actual listening level.
 * Positive means boost: listening quieter (e.g. reference 80, actual 40 phon)
 * requires positive bass gain. This is the inverse of the sensitivity change:
 * (Lp(actual) - actual) - (Lp(reference) - reference), normalized to exactly
 * 0 dB at 1 kHz using the equation there, even when the grid omits 1 kHz.
 * This is a relative EQ curve, not an absolute listening-level calibration.
 * @param {number} referencePhon
 * @param {number} actualPhon
 * @param {readonly number[]} [grid]
 * @returns {CompensationResult}
 */
export function loudnessCompensationDb(referencePhon: number, actualPhon: number, grid?: readonly number[]): CompensationResult;
/**
 * Amplitude-sensitivity weights: 10^(-(Lp(f) - phon)/20), normalized to the
 * maximum on the requested grid, THEN floored at 0.05. This keeps all frequencies
 * represented without letting low-sensitivity extremes dominate D4/D6. These
 * are relative perceptual weights, not an SPL calibration or ISO weighting filter.
 * @param {readonly number[]} [grid]
 * @param {number} [phon]
 * @returns {WeightsResult}
 */
export function perceptualWeights(grid?: readonly number[], phon?: number): WeightsResult;
/**
 * @typedef {'normative' | 'informative' | 'extrapolated'} Validity
 * @typedef {Readonly<{freqHz: number, alphaF: number, luDb: number, tfDb: number}>} Iso226Row
 * @typedef {{splDb: number, validity: Validity}} SplResult
 * @typedef {{splDb: number[], validity: Validity}} ContourResult
 * @typedef {{compensationDb: number[], validity: Validity}} CompensationResult
 * @typedef {{weights: number[], validity: Validity}} WeightsResult
 */
/**
 * ISO 226:2003 Table 1. alphaF = alpha_f, luDb = L_U, tfDb = T_f.
 * Rows and the containing array are immutable.
 * @type {readonly Iso226Row[]}
 */
export const ISO226_TABLE: readonly Iso226Row[];
export type Validity = "normative" | "informative" | "extrapolated";
export type Iso226Row = Readonly<{
    freqHz: number;
    alphaF: number;
    luDb: number;
    tfDb: number;
}>;
export type SplResult = {
    splDb: number;
    validity: Validity;
};
export type ContourResult = {
    splDb: number[];
    validity: Validity;
};
export type CompensationResult = {
    compensationDb: number[];
    validity: Validity;
};
export type WeightsResult = {
    weights: number[];
    validity: Validity;
};
