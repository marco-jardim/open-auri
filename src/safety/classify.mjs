// Curve classifier: the class under which a curve may be stored and published.
//
//   - `standard`: the standard write gate accepts it (`gateForWrite`);
//   - `yolo`: the standard gate refuses it on waivable reasons only, and the
//     YOLO profile accepts it; `waived` lists the codes it waived;
//   - `rejected`: neither; `reasons` lists the codes that block it.
//
// The classification waives the YOLO profile's class 2 except
// `k:kind-not-allowed`: experimental kinds (HS, LP, HP) are allowed by the
// `experimental` flag alone, which callers set from the curve itself (whether
// it has an HS, LP or HP section). A preamp below −25.5 dB (the floor S1 and
// S5 encode, `YOLO_STORAGE_PREAMP_FLOOR_DB`) is never stored, YOLO included.
// See classify-core.mjs for the steps and why the shortcut is sound.
//
// Like the gate, a similarity policy with what the 11 official presets make the
// chip compute, not a hardware safety proof.
//
// Pure ESM: no DOM, no Node-only APIs.

import { CLASSIFICATION_WAIVABLE, classifyWith } from './classify-core.mjs';
import { gateForWrite } from './gate.mjs';
import { THRESHOLDS, YOLO_THRESHOLDS } from './thresholds.mjs';

/**
 * @typedef {import('../dsp/eq0xcb.mjs').Band} Band
 * @typedef {import('./classify-core.mjs').Classification} Classification
 * @typedef {import('./classify-core.mjs').CurveClass} CurveClass
 */

/**
 * Whether `options` has an own data property `experimental` holding exactly
 * `true`, read as `gateProfile` reads `profile`: one
 * `Object.getOwnPropertyDescriptor`, never a getter, an inherited property or
 * a coercion; anything else (and a throwing trap) is `false`.
 * @param {unknown} options
 * @returns {boolean}
 */
function experimentalFlag(options) {
  if (options === null || typeof options !== 'object') return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(options, 'experimental');
    return (
      descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.value === true
    );
  } catch {
    // A throwing trap: nothing it threw is inspected.
    return false;
  }
}

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
export function classifyCurve(bands, preampDb, options) {
  return classifyWith(gateForWrite, bands, preampDb, experimentalFlag(options));
}

/**
 * Serializes `value` as JSON with the keys of every object sorted (arrays keep
 * their order), so equal data always gives the same text.
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Stable JSON of everything the classifier's verdicts depend on besides its
 * code: `THRESHOLDS`, `YOLO_THRESHOLDS` and the classification's waivable codes
 * (`YOLO_WAIVABLE` without `k:kind-not-allowed`), keys sorted. Hash it, with
 * the implementation version, into the classifier's version: it changes when
 * any of them does. The storage floor is `THRESHOLDS.preampMinDb`.
 * @returns {string}
 */
export function classifierVersionInput() {
  return stableJson({
    thresholds: THRESHOLDS,
    yoloThresholds: YOLO_THRESHOLDS,
    waivable: CLASSIFICATION_WAIVABLE,
  });
}
