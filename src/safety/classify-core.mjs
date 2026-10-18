// Curve classification, internal core of src/safety/classify.mjs (`classifyCurve`,
// the public entry, exported from `open-auri/safety`). Not part of the public
// API: the write gate is a parameter here only so tests can count its runs;
// `classifyCurve` always passes `gateForWrite`.
//
// Pure ESM: no DOM, no Node-only APIs.

import { YOLO_STORAGE_PREAMP_FLOOR_DB, YOLO_WAIVABLE } from './gate.mjs';

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
export const CLASSIFICATION_WAIVABLE = Object.freeze(
  YOLO_WAIVABLE.filter((code) => code !== 'k:kind-not-allowed'),
);

/** @type {ReadonlySet<string>} */
const WAIVED = new Set(CLASSIFICATION_WAIVABLE);

/**
 * Whether `reason` keeps a curve from being stored in any class: a code outside
 * {@link CLASSIFICATION_WAIVABLE} (class 1, `k:kind-not-allowed`, any unknown
 * code), or a `g:preamp` below the storage floor.
 * @param {Reason} reason
 * @returns {boolean}
 */
function blocks(reason) {
  if (!WAIVED.has(reason.code)) return true;
  if (reason.code !== 'g:preamp') return false;
  const value = reason.value;
  return !(typeof value === 'number' && value >= YOLO_STORAGE_PREAMP_FLOOR_DB);
}

/**
 * The codes of `reasons` that block, once each, in order of first appearance.
 * @param {readonly Reason[]} reasons
 * @returns {ReasonCode[]}
 */
function blockingCodes(reasons) {
  return [...new Set(reasons.filter(blocks).map((r) => r.code))];
}

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
export function classifyWith(write, bands, preampDb, experimental) {
  const standard = write(bands, preampDb, { experimental });
  if (standard.ok) return { class: 'standard', waived: [], reasons: [] };
  const hard = blockingCodes(standard.reasons);
  if (hard.length > 0) return { class: 'rejected', waived: [], reasons: hard };
  // No f:codec (class 1) above, so the codec accepted the curve and its frozen
  // snapshot is in the metrics: the YOLO run judges exactly what was read.
  const snapshot = /** @type {readonly Band[]} */ (standard.metrics.bands);
  // A YOLO result always carries `waived` and `waivedReasons`.
  const yolo = /** @type {Required<GateResult>} */ (
    write(snapshot, preampDb, { experimental, profile: 'yolo' })
  );
  // A YOLO blocking reason is outside YOLO_WAIVABLE, so it blocks here too.
  const blocking = blockingCodes([...yolo.reasons, ...yolo.waivedReasons]);
  if (blocking.length > 0) return { class: 'rejected', waived: [], reasons: blocking };
  return { class: 'yolo', waived: [...yolo.waived], reasons: [] };
}
