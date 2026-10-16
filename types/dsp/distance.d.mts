/**
 * Sum all section magnitudes in dB and add the preamp. Any number of bands is
 * accepted; this is analysis, not the ten-section wire encoder. Positive
 * preamps are also allowed here. The 0xCB magnitudeDb evaluator uses designSection.
 * @param {Curve} curve
 * @param {readonly number[]} [grid]
 * @returns {number[]}
 */
export function curveResponseDb({ bands, preampDb }: Curve, grid?: readonly number[]): number[];
/**
 * Symmetric RMS/maximum absolute difference, with contiguous runs strictly above
 * thresholdDb. Region endpoints are grid samples, not interpolated crossings;
 * peakDiffDb is unsigned. A maximum tie selects the lowest frequency.
 *
 * By default, subtract the unweighted mean of (a - b) over grid samples in the
 * inclusive 300 Hz–3 kHz window before comparison. If the grid has no samples in
 * that window, no level matching is applied. Set levelMatch: false to retain
 * absolute level/preamp differences. Inputs are never modified.
 *
 * Nonnegative finite weights affect only RMS and are normalized by their sum;
 * multiplying every weight by the same positive constant changes nothing.
 * At least one weight must be positive. Maxima and regions remain unweighted.
 * @param {ResponseOrCurve} a
 * @param {ResponseOrCurve} b
 * @param {DistanceOptions} [options]
 * @returns {CurveDistance}
 */
export function distance(a: ResponseOrCurve, b: ResponseOrCurve, { grid, thresholdDb, weights, levelMatch }?: DistanceOptions): CurveDistance;
export type Curve = {
    bands: readonly import("./eq0xcb.mjs").Band[];
    preampDb?: number;
};
export type ResponseOrCurve = readonly number[] | Curve;
export type DifferenceRegion = {
    fromHz: number;
    toHz: number;
    peakDiffDb: number;
};
export type CurveDistance = {
    rmsDb: number;
    maxDb: number;
    maxFreqHz: number;
    regions: DifferenceRegion[];
};
export type DistanceOptions = {
    grid?: readonly number[];
    thresholdDb?: number;
    weights?: readonly number[];
    levelMatch?: boolean;
};
