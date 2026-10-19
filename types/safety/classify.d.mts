/**
 * The class of a curve (`bands` in wire order, `preampDb`), on the full-grid
 * write gate:
 * 1. the standard profile; a pass is `standard`;
 * 2. a standard failure on a reason the classification never waives (class 1,
 *    `k:kind-not-allowed`, a preamp below −25.5 dB) is `rejected` with those
 *    codes, without a YOLO run: a class-1 standard failure is a YOLO failure
 *    too;
 * 3. otherwise the YOLO profile, on the frozen bands of the first run
 *    (`metrics.bands`): a pass is `yolo` with the codes it waived, a failure
 *    is `rejected` with its blocking codes.
 *
 * `options.experimental` allows HS, LP and HP (pass whether the curve has one);
 * it counts only as an own data property holding exactly `true`. There is no
 * profile option: every other option is ignored. The bands are read once (one
 * read per field) and never changed; the result is a fresh object. Pure.
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {{experimental?: boolean}} [options]
 * @returns {Classification}
 */
export function classifyCurve(bands: readonly Band[], preampDb: number, options?: {
    experimental?: boolean;
}): Classification;
/**
 * Stable JSON of everything the classifier's verdicts depend on besides its
 * code: `THRESHOLDS`, `YOLO_THRESHOLDS` and the classification's waivable codes
 * (`YOLO_WAIVABLE` without `k:kind-not-allowed`), keys sorted. Hash it, with
 * the implementation version, into the classifier's version: it changes when
 * any of them does. The storage floor is `THRESHOLDS.preampMinDb`.
 * @returns {string}
 */
export function classifierVersionInput(): string;
export type Band = import("../dsp/eq0xcb.mjs").Band;
export type Classification = import("./classify-core.mjs").Classification;
export type CurveClass = import("./classify-core.mjs").CurveClass;
