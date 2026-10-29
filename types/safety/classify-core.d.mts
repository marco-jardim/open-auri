/**
 * The class of a curve, judged by `write` (the full-grid write gate):
 * 1. the standard profile; a pass is `standard`;
 * 2. a standard failure that blocks the classification (`blocks`: class 1,
 *    `k:kind-not-allowed`, a preamp below the storage floor) is `rejected`
 *    with those codes, without a YOLO run: the YOLO profile reports every
 *    class-1 reason of the standard one (and only waives class 2), so it would
 *    fail too;
 * 3. otherwise the YOLO profile, on the standard run's frozen snapshot
 *    (`metrics.bands`, read once): a pass is `yolo` with the codes it waived;
 *    a failure is `rejected` with its blocking codes.
 * @param {WriteGate} write
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {boolean} experimental
 * @returns {Classification}
 */
export function classifyWith(write: WriteGate, bands: readonly Band[], preampDb: number, experimental: boolean): Classification;
/**
 * @typedef {import('../dsp/eq0xcb.mjs').Band} Band
 * @typedef {import('./gate.mjs').GateOptions} GateOptions
 * @typedef {import('./gate.mjs').GateResult} GateResult
 * @typedef {import('./gate.mjs').Reason} Reason
 * @typedef {import('./gate.mjs').ReasonCode} ReasonCode
 * @typedef {(
 *   bands: readonly Band[], preampDb: number, options: GateOptions
 * ) => GateResult} WriteGate
 * @typedef {'standard' | 'yolo' | 'rejected'} CurveClass
 * @typedef {{class: CurveClass, waived: ReasonCode[], reasons: ReasonCode[]}} Classification
 */
/**
 * Codes the classification waives for a `yolo` curve: the YOLO gate's class 2
 * (`YOLO_WAIVABLE`) except `k:kind-not-allowed`. Experimental kinds are decided
 * by the `experimental` flag alone, never waived. `g:preamp` is waived above
 * the range only: below {@link YOLO_STORAGE_PREAMP_FLOOR_DB} it blocks.
 * @type {readonly ReasonCode[]}
 */
export const CLASSIFICATION_WAIVABLE: readonly ReasonCode[];
export type Band = import("../dsp/eq0xcb.mjs").Band;
export type GateOptions = import("./gate.mjs").GateOptions;
export type GateResult = import("./gate.mjs").GateResult;
export type Reason = import("./gate.mjs").Reason;
export type ReasonCode = import("./gate.mjs").ReasonCode;
export type WriteGate = (bands: readonly Band[], preampDb: number, options: GateOptions) => GateResult;
export type CurveClass = "standard" | "yolo" | "rejected";
export type Classification = {
    class: CurveClass;
    waived: ReasonCode[];
    reasons: ReasonCode[];
};
