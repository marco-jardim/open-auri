// Editing policy around the gate v2: control ranges, filter kinds per UI layer,
// the D7 boost rules, the rounding grid and the pure helpers used while
// dragging (boundary search and grid snapping).
//
// Ranges here are UI policy, not the safety check: every curve, even one fully
// inside a soft range, must still pass `gateForWrite` (src/safety/gate.mjs)
// before it is written or published. Like the gate, this is a similarity policy
// with what the 11 official presets already make the chip compute, not a
// hardware safety proof.
//
// Pure ESM: no DOM, no Node-only APIs.

/**
 * @typedef {import('../dsp/eq0xcb.mjs').Band} Band
 * @typedef {{readonly min: number, readonly max: number}} Range
 * @typedef {'ouvir' | 'ajustar' | 'engenharia'} Layer
 * @typedef {'PK-main' | 'PK-narrow' | 'LS' | 'HS-cut' | 'HS-boost' | 'LP' | 'HP'} SoftRangeId
 */

/**
 * @typedef {object} SoftRange
 * @property {'PK' | 'LS' | 'HS' | 'LP' | 'HP'} kind
 * @property {Range} freqHz
 * @property {Range} [gainDb] absent for LP/HP (no gain)
 * @property {Range} qFactor
 */

/**
 * @typedef {object} AbsRanges
 * @property {Range} freqHz
 * @property {Range} gainDb
 * @property {Range} qFactor
 * @property {number} boostQMax highest Q of a PK/LS/HS boost (D7)
 * @property {number} pkBoostMaxHz highest frequency of a PK boost (D7)
 */

/**
 * @param {number} min
 * @param {number} max
 * @returns {Range}
 */
const range = (min, max) => Object.freeze({ min, max });

/**
 * Conservative single-section boxes (design/analysis/limites-v2.md §4), sampled
 * with automatic preamp and zero violations. Sampling is not an interval proof:
 * the gate stays mandatory.
 * @type {Readonly<Record<SoftRangeId, Readonly<SoftRange>>>}
 */
export const SOFT_RANGES = Object.freeze({
  'PK-main': Object.freeze({
    kind: 'PK',
    freqHz: range(150, 20000),
    gainDb: range(-24, 6),
    qFactor: range(1, 2),
  }),
  'PK-narrow': Object.freeze({
    kind: 'PK',
    freqHz: range(300, 20000),
    gainDb: range(-24, 9),
    qFactor: range(2, 4),
  }),
  LS: Object.freeze({
    kind: 'LS',
    freqHz: range(80, 1000),
    gainDb: range(-24, 6),
    qFactor: range(0.5, 0.7),
  }),
  'HS-cut': Object.freeze({
    kind: 'HS',
    freqHz: range(80, 20000),
    gainDb: range(-24, 0),
    qFactor: range(0.5, 0.7),
  }),
  'HS-boost': Object.freeze({
    kind: 'HS',
    freqHz: range(8000, 20000),
    gainDb: range(-24, 2),
    qFactor: range(0.5, 0.7),
  }),
  LP: Object.freeze({ kind: 'LP', freqHz: range(30, 20000), qFactor: range(0.5, 0.7) }),
  HP: Object.freeze({ kind: 'HP', freqHz: range(50, 20000), qFactor: range(0.5, 0.7) }),
});

/**
 * Absolute control ranges (any layer) and the D7 boost rules: a boost (gain > 0)
 * on PK/LS/HS needs Q <= `boostQMax`, and no PK may boost above `pkBoostMaxHz`.
 *
 * `freqHz` stays [20, 20000]: the solver, the Ouvir and Ajustar layers and
 * `clampToAbs` rely on it. Engenharia and Modo YOLO may go higher, up to
 * `ULTRA_MAX_HZ`, through `freqMaxFor` only.
 * @type {Readonly<AbsRanges>}
 */
export const ABS_RANGES = Object.freeze({
  freqHz: range(20, 20000),
  gainDb: range(-24, 9.2),
  qFactor: range(0.1, 20),
  boostQMax: 4,
  pkBoostMaxHz: 16000,
});

/** Top of the audible band (Hz): the highest frequency of Ouvir and Ajustar. */
export const AUDIBLE_MAX_HZ = 20000;

/**
 * Highest frequency of a section above the audible band (Hz): Engenharia, for
 * sections that never amplify, and Modo YOLO, for every kind (`freqMaxFor`).
 */
export const ULTRA_MAX_HZ = 32000;

/**
 * Highest Q of an LS/HS cut and of an LP/HP placed above `AUDIBLE_MAX_HZ`
 * outside Modo YOLO: up to it the section has no resonant bump above 0 dB.
 */
export const ULTRA_CUT_Q_MAX = 0.71;

/** Filter kinds that are sections (OFF is identity, anything else is not a filter). */
const SECTION_KINDS = Object.freeze(['PK', 'LS', 'HS', 'LP', 'HP']);

/**
 * Non-numbers count as NaN (they fail every comparison) and are never converted,
 * so no caller code (valueOf, Symbol coercion) runs.
 * @param {unknown} value
 * @returns {number}
 */
const numeric = (value) => (typeof value === 'number' ? value : NaN);

/**
 * Whether `band` is a filter section (PK, LS, HS, LP or HP) above the audible
 * band: `freqHz` > `AUDIBLE_MAX_HZ`. NaN-safe like the gate's D7 checks: a
 * section whose `freqHz` is not a number at most `AUDIBLE_MAX_HZ` (NaN, a
 * non-number, missing) counts as above. OFF, unknown kinds and non-objects
 * never do. Each field is read once and never coerced.
 * @param {unknown} band
 * @returns {boolean}
 */
export function isUltrasonic(band) {
  if (band === null || typeof band !== 'object') return false;
  const { kind, freqHz } = /** @type {Record<string, unknown>} */ (band);
  if (!SECTION_KINDS.includes(/** @type {string} */ (kind))) return false;
  return !(numeric(freqHz) <= AUDIBLE_MAX_HZ);
}

/**
 * Whether `band` is a section that never amplifies, wherever it sits: a PK with
 * gain <= 0 (any Q), an LS or HS with gain <= 0 and Q <= `ULTRA_CUT_Q_MAX`, an
 * LP or HP with Q <= `ULTRA_CUT_Q_MAX`. NaN-safe: a missing, non-number or NaN
 * gain or Q never qualifies. OFF, unknown kinds and non-objects do not either.
 * @param {unknown} band
 * @returns {boolean}
 */
function isNonAmplifying(band) {
  if (band === null || typeof band !== 'object') return false;
  const { kind, gainDb, qFactor } = /** @type {Record<string, unknown>} */ (band);
  switch (kind) {
    case 'PK':
      return numeric(gainDb) <= 0;
    case 'LS':
    case 'HS':
      return numeric(gainDb) <= 0 && numeric(qFactor) <= ULTRA_CUT_Q_MAX;
    case 'LP':
    case 'HP':
      return numeric(qFactor) <= ULTRA_CUT_Q_MAX;
    default:
      return false;
  }
}

/**
 * Highest frequency (Hz) `band` may take in `layer`:
 * - Ouvir and Ajustar (and any other layer): `AUDIBLE_MAX_HZ`;
 * - Engenharia: `ULTRA_MAX_HZ` for a section that never amplifies (PK with
 *   gain <= 0, any Q; LS/HS with gain <= 0 and Q <= `ULTRA_CUT_Q_MAX`; LP/HP
 *   with Q <= `ULTRA_CUT_Q_MAX`), else `AUDIBLE_MAX_HZ`;
 * - Engenharia with `yolo: true` (Modo YOLO exists only there):
 *   `ULTRA_MAX_HZ` for every kind.
 * UI policy like the other ranges: above `AUDIBLE_MAX_HZ` the gate refuses
 * whatever Engenharia would not allow (`d7:boost-above-20k`, waived by its YOLO
 * profile only). Only `yolo === true` counts.
 * @param {unknown} band
 * @param {{layer?: string, yolo?: boolean}} [options]
 * @returns {number}
 */
export function freqMaxFor(band, { layer, yolo } = {}) {
  if (layer !== 'engenharia') return AUDIBLE_MAX_HZ;
  if (yolo === true) return ULTRA_MAX_HZ;
  return isNonAmplifying(band) ? ULTRA_MAX_HZ : AUDIBLE_MAX_HZ;
}

/** Kinds that exist only behind the `experimental` flag (engineering layer). */
export const EXPERIMENTAL_KINDS = Object.freeze(['HS', 'LP', 'HP']);

/**
 * Filter kinds offered by each UI layer. The engineering layer adds the
 * experimental kinds (see `isExperimentalKind`).
 * @type {Readonly<Record<Layer, readonly string[]>>}
 */
export const LAYER_KINDS = Object.freeze({
  ouvir: Object.freeze(['PK', 'LS', 'OFF']),
  ajustar: Object.freeze(['PK', 'LS', 'OFF']),
  engenharia: Object.freeze(['PK', 'LS', 'OFF', ...EXPERIMENTAL_KINDS]),
});

/** Rounding grid: gain 0.1 dB, frequency 1 Hz, Q 0.01. */
export const GRID_STEPS = Object.freeze({ gainDb: 0.1, freqHz: 1, qFactor: 0.01 });

/**
 * Whether `kind` may be used in `layer`. Unknown layers allow nothing.
 * @param {unknown} kind
 * @param {string} layer
 * @returns {boolean}
 */
export function isKindAllowed(kind, layer) {
  if (!Object.hasOwn(LAYER_KINDS, layer)) return false;
  return LAYER_KINDS[/** @type {Layer} */ (layer)].includes(/** @type {string} */ (kind));
}

/**
 * Whether `kind` is experimental (HS, LP, HP).
 * @param {unknown} kind
 * @returns {boolean}
 */
export function isExperimentalKind(kind) {
  return EXPERIMENTAL_KINDS.includes(/** @type {string} */ (kind));
}

/**
 * Rounds `value` to a multiple of `1 / scale` (integer arithmetic, so the result
 * is the canonical double of k / scale); -0 becomes 0, non-finite stays as is.
 * @param {number} value
 * @param {number} scale
 */
function roundTo(value, scale) {
  return Math.round(value * scale) / scale + 0;
}

/**
 * Band rounded to the UI grid (gain 0.1 dB, frequency 1 Hz, Q 0.01). OFF and
 * non-object values are returned unchanged; missing keys stay missing.
 * @template {Band} T
 * @param {T} band
 * @returns {T}
 */
export function roundToGrid(band) {
  if (band === null || typeof band !== 'object' || band.kind === 'OFF') return band;
  /** @type {Record<string, unknown>} */
  const out = { ...band };
  if (typeof out.gainDb === 'number') out.gainDb = roundTo(out.gainDb, 10);
  if (typeof out.freqHz === 'number') out.freqHz = roundTo(out.freqHz, 1);
  if (typeof out.qFactor === 'number') out.qFactor = roundTo(out.qFactor, 100);
  return /** @type {T} */ (out);
}

/**
 * Clamps `value` to `[r.min, r.max]`; non-finite values are returned unchanged
 * so the gate still rejects them (clamping Infinity would make it look valid).
 * @param {number} value
 * @param {Range} r
 */
function clamp(value, r) {
  if (!Number.isFinite(value)) return value;
  return Math.min(r.max, Math.max(r.min, value)) + 0;
}

/**
 * Band clamped to ABS_RANGES, D7 included: a PK/LS/HS boost has its Q clamped to
 * `boostQMax`, and a PK boost above `pkBoostMaxHz` has its frequency clamped to
 * `pkBoostMaxHz` (gain is kept). OFF and non-objects are returned unchanged.
 * Non-finite parameters are kept as is (the gate rejects them).
 * @template {Band} T
 * @param {T} band
 * @returns {T}
 */
export function clampToAbs(band) {
  if (band === null || typeof band !== 'object' || band.kind === 'OFF') return band;
  /** @type {Record<string, unknown>} */
  const out = { ...band };
  if (typeof out.freqHz === 'number') out.freqHz = clamp(out.freqHz, ABS_RANGES.freqHz);
  if (typeof out.qFactor === 'number') out.qFactor = clamp(out.qFactor, ABS_RANGES.qFactor);
  const hasGain = band.kind === 'PK' || band.kind === 'LS' || band.kind === 'HS';
  if (hasGain && typeof out.gainDb === 'number') {
    out.gainDb = clamp(out.gainDb, ABS_RANGES.gainDb);
    if (/** @type {number} */ (out.gainDb) > 0) {
      if (typeof out.qFactor === 'number' && out.qFactor > ABS_RANGES.boostQMax) {
        out.qFactor = ABS_RANGES.boostQMax;
      }
      if (band.kind === 'PK' && typeof out.freqHz === 'number') {
        if (out.freqHz > ABS_RANGES.pkBoostMaxHz) out.freqHz = ABS_RANGES.pkBoostMaxHz;
      }
    }
  }
  return /** @type {T} */ (out);
}

/**
 * Default interpolation for `boundarySearch`: numbers are interpolated linearly;
 * arrays and plain objects recursively, key by key; anything else (e.g. `kind`)
 * keeps the value of `from`. Callers moving a band should pass `interpolateBand`
 * (log frequency and Q) instead.
 * @template T
 * @param {T} from
 * @param {T} to
 * @param {number} t
 * @returns {T}
 */
export function interpolateLinear(from, to, t) {
  const result = (/** @type {unknown} */ value) => /** @type {T} */ (value);
  /** @type {unknown} */
  const a = from;
  /** @type {unknown} */
  const b = to;
  if (typeof a === 'number' && typeof b === 'number') return result(a + (b - a) * t);
  if (Array.isArray(a) && Array.isArray(b)) {
    return result(a.map((value, i) => interpolateLinear(value, b[i], t)));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const x = /** @type {Record<string, unknown>} */ (a);
    const y = /** @type {Record<string, unknown>} */ (b);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(x)) out[key] = interpolateLinear(x[key], y[key], t);
    return result(out);
  }
  return from;
}

/**
 * Band interpolation recommended for dragging: gain linear, frequency and Q on a
 * log scale; other keys keep the value of `from`. Falls back to linear for
 * non-positive frequencies or Qs (which the gate rejects anyway).
 * @param {Band} from
 * @param {Band} to
 * @param {number} t
 * @returns {Band}
 */
export function interpolateBand(from, to, t) {
  /** @type {Record<string, unknown>} */
  const out = interpolateLinear(from, to, t);
  /** @type {Record<string, unknown>} */
  const a = from;
  /** @type {Record<string, unknown>} */
  const b = to;
  for (const key of ['freqHz', 'qFactor']) {
    const x = a[key];
    const y = b[key];
    if (typeof x === 'number' && typeof y === 'number' && x > 0 && y > 0) {
      out[key] = x * (y / x) ** t;
    }
  }
  return /** @type {Band} */ (out);
}

/**
 * Bisection between an accepted state `from` and a target `to`: returns the last
 * accepted point found (`to` itself when it is accepted). Pure; the result
 * always satisfies `predicate`. Never jumps over a refused zone to an accepted
 * island further on, but bisection does not prove the segment is monotone either.
 *
 * The default interpolation is per-numeric-key linear (`interpolateLinear`);
 * pass `interpolateBand` to move frequency and Q on a log scale.
 * @template T
 * @param {T} from accepted state (precondition: `predicate(from)` is true)
 * @param {T} to target state
 * @param {(state: T) => boolean} predicate
 * @param {{iterations?: number, interpolate?: (from: T, to: T, t: number) => T}} [options]
 * @returns {T}
 */
export function boundarySearch(from, to, predicate, { iterations = 24, interpolate } = {}) {
  if (!predicate(from)) throw new RangeError('boundarySearch: predicate(from) must be true');
  if (predicate(to)) return to;
  const lerp = interpolate ?? interpolateLinear;
  let best = from;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const candidate = lerp(from, to, mid);
    if (predicate(candidate)) {
      lo = mid;
      best = candidate;
    } else {
      hi = mid;
    }
  }
  return best;
}

const SNAP_KEYS = /** @type {const} */ (['gainDb', 'freqHz', 'qFactor']);
const SNAP_SCALE = Object.freeze({ gainDb: 10, freqHz: 1, qFactor: 100 });

/**
 * Rounds `value` to the UI grid; if rounding breaks acceptance, steps back toward
 * `from` (rounded) one grid step at a time on every parameter, at most
 * `maxSteps` times. Returns `from` itself when no snapped point is accepted, so
 * the result always satisfies `predicate` (precondition: `predicate(from)`).
 * @template {Band} T
 * @param {T} value
 * @param {T} from accepted state
 * @param {(state: T) => boolean} predicate
 * @param {{maxSteps?: number}} [options]
 * @returns {T}
 */
export function snapToGridAccepted(value, from, predicate, { maxSteps = 100 } = {}) {
  let current = roundToGrid(value);
  if (predicate(current)) return current;
  /** @type {Record<string, unknown>} */
  const target = roundToGrid(from);
  for (let step = 0; step < maxSteps; step++) {
    /** @type {Record<string, unknown>} */
    const next = { ...current };
    let moved = false;
    for (const key of SNAP_KEYS) {
      const x = next[key];
      const goal = target[key];
      if (typeof x !== 'number' || typeof goal !== 'number' || x === goal) continue;
      const scale = SNAP_SCALE[key];
      const k = Math.round(x * scale);
      const g = Math.round(goal * scale);
      if (!Number.isFinite(k) || !Number.isFinite(g)) continue;
      next[key] = (k + Math.sign(g - k)) / scale + 0;
      moved = true;
    }
    if (!moved) break;
    current = /** @type {T} */ (next);
    if (predicate(current)) return current;
  }
  return from;
}
