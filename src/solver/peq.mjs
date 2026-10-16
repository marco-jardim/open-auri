/**
 * Parametric EQ solver: C1 ("sound like X": measurement + target), C2 (drawn
 * target), D4 (ISO 226 perceptual weights) and D5 (opposite-neighbour penalty).
 * Every result passes `gateForWrite` (src/safety/gate.mjs).
 *
 * Initialization and loss are derived from AutoEq
 * (https://github.com/jaakkopasanen/AutoEq, autoeq/peq.py, file commit
 * 853360a1626b387e1d3d87f3f7ad8c7514d30839, 2023-10-29), Copyright (c) 2018-2022
 * Jaakko Pasanen, MIT License — see THIRD_PARTY_NOTICES.md. Only the published
 * formulas are reimplemented here (no code is copied):
 * - peaking init: the largest positive peak of clip(target, 0) or clip(-target, 0)
 *   by width × height; fc = f[ix]; bw = peak width at half prominence in octaves
 *   (= width_bins · log2(f[1]/f[0]) on a uniform log grid); Q = sqrt(2^bw)/(2^bw - 1);
 *   gain = ±height. Filters are initialized sequentially, each one's response
 *   being subtracted from the remaining target before the next;
 * - shelf init: split ix with 40 Hz <= f < 10 kHz maximizing |mean(target[:ix+1])|
 *   (low shelf) or |mean(target[ix:])| (high shelf); Q = 0.7; gain = mean of the
 *   target weighted by the shelf's own (unit-gain) response;
 * - loss: above 10 kHz target and fit are replaced by their mean over >= 10 kHz;
 *   loss = sqrt(mean((target - fit)^2) over 20 Hz–20 kHz + Σ penalties), with the
 *   peaking sharpness penalty gain_limit = -0.09503189270199464 + 20.575128011847003/Q,
 *   x = gain/gain_limit - 1, coef = 1/(1 + e^(-100x)), penalty = mean((fr·coef)^2).
 *
 * Differences from AutoEq (this project's own work):
 * - the squared error is weighted (D4, `weights: 'iso226'`, normalized to sum 1;
 *   `'flat'` = AutoEq's plain mean) and, by default, level-matched (the weighted
 *   mean error is removed: the overall level is set by the automatic preamp);
 * - treble: AutoEq's averaged >= 10 kHz error is kept, plus the deviation of each
 *   >= 10 kHz sample from that mean with weight `trebleDetail` (0 = AutoEq exactly,
 *   1 = the plain error, since Σ w(e - c)² ≈ Σ w(e - ē)² + W(ē - c)²; default 0.5),
 *   so the treble shape of drawn or preset targets is not ignored;
 * - feature edges: clipped targets are padded with one 0 dB sample at each end of
 *   20 Hz–20 kHz, so a feature at the edge of the band can seed a filter;
 * - extra squared terms (D5, speed), and a Levenberg–Marquardt optimizer with
 *   boxes and gate projection instead of SLSQP (below).
 *
 * Objective F = loss² = Σ r², with residuals
 *   r_i  = sqrt(w_i) (e_i - c)    f < 10 kHz      e = target - fit, c = Σ w e (level match)
 *   r_hi = sqrt(Σ_hi w) (ē - c),  r_j = sqrt(trebleDetail · w_j) (e_j - ē)   f >= 10 kHz
 *   r_k  = sqrt(sharpnessWeight) · coef_k · rms(fr_k)      (PK only; = AutoEq's mean)
 *   r_D5 = sqrt(d5Weight · Σ (1 - d)² |g_a g_b|)  over sections adjacent in frequency,
 *          with opposite-sign gains, centres d < 1 octave apart (dB², d in octaves)
 *   r_g  = sqrt(λ(speed)) · g_k / 10              (speed regularization)
 * "Correction speed" s in [0, 100] (see `speedParameters`): λ = 0.02·((100 - s)/50)²
 * per (10 dB)², and sections with |gain| < pruneDb = 0.1 + 0.008·(100 - s) dB are
 * dropped (peaks lower than pruneDb are not initialized). s = 100 corrects most
 * aggressively (λ = 0, prune 0.1 dB); s = 0 prefers fewer, smaller filters.
 *
 * Optimizer: Levenberg–Marquardt over (log10 f, log10 Q, gain) per section, with a
 * forward-difference Jacobian on the grid (481 points by default; per-section
 * responses are precomputed, the gate is never called in the inner loop),
 * Marquardt diagonal damping, and an active set that freezes variables pushed
 * against their box. Boxes are `ABS_RANGES` (default, `ranges: 'abs'`) or
 * `SOFT_RANGES` (`ranges: 'soft'`: PK-main / PK-narrow by Q, LS, HS-cut / HS-boost
 * by gain sign), always with D7 (no PK boost above 16 kHz, boost Q <= 4). Each
 * candidate section is projected into the box and, if the section analysis of the
 * gate refuses it (a, b, c on the quantized section), pulled back with
 * `boundarySearch` along the step; when the fit peaks above 18 dB the whole curve
 * is projected with `gate(..., {grid: 'drag'})` at the lowest preamp, again with
 * `boundarySearch` along the step. Stopping: `maxIterations` (the primary,
 * deterministic work bound; default 400 LM trials), `maxTimeMs`,
 * `targetLoss`, or the AutoEq rule (std of the last 8 accepted losses < `minStd`).
 * After convergence small sections are pruned and free sections are re-seeded
 * from the residual (at most 3 rounds). No randomness is used: the result is
 * deterministic when `stopReason !== 'time'` (except `elapsedMs`); a time-limited
 * result depends on CPU load. `seed` is validated and reserved. All searches,
 * re-seeding and finalization loops also have finite bounds independent of time.
 * The injectable `clock` defaults to performance.now(), or Date.now() if absent.
 * In Cloudflare Workers, time does not advance during synchronous execution:
 * servers must rely on `maxIterations`, not `maxTimeMs`, and should not run this
 * solver per request.
 *
 * Output (`finalizeBands`): bands rounded to the UI grid (`roundToGrid`, then
 * `snapToGridAccepted` against the section predicate), ordered cuts first then
 * boosts, each by frequency. If that order fails the gate at the lowest preamp,
 * the other orders (by frequency; boosts first) are tried and the first passing
 * one is used; otherwise boost gains are scaled toward 0 by `boundarySearch`, and
 * as a last resort sections are dropped to OFF (Neutro always passes). The
 * preamp is `autoPreamp`; the final curve is verified with `gateForWrite`.
 *
 * Pure ESM: no DOM, no Node-only APIs.
 */

import { BAND_COUNT, designSection, SAMPLE_RATE } from '../dsp/eq0xcb.mjs';
import { curveResponseDb } from '../dsp/distance.mjs';
import { GRID } from '../dsp/grid.mjs';
import { perceptualWeights } from '../dsp/iso226.mjs';
import { autoPreamp, gate, gateForWrite, sectionAnalysis, THRESHOLDS } from '../safety/gate.mjs';
import {
  ABS_RANGES,
  boundarySearch,
  interpolateBand,
  LAYER_KINDS,
  roundToGrid,
  snapToGridAccepted,
  SOFT_RANGES,
} from '../safety/policy.mjs';

/**
 * @typedef {import('../dsp/eq0xcb.mjs').Band} Band
 * @typedef {import('../safety/policy.mjs').Range} Range
 * @typedef {import('../safety/gate.mjs').Reason} Reason
 * @typedef {'PK' | 'LS' | 'HS'} SolverKind
 * @typedef {{kind: SolverKind, freqHz: number, gainDb: number, qFactor: number}} SolverBand
 * @typedef {{freqHz: number, gainDb: number}} TargetPoint
 * @typedef {'iso226' | 'flat'} WeightMode
 * @typedef {'abs' | 'soft'} RangeMode
 * @typedef {'flat' | 'converged' | 'targetLoss' | 'time' | 'iterations'} StopReason
 * @typedef {{now: () => number}} Clock
 * @typedef {{fMin: number, fMax: number, qMin: number, qMax: number, gMin: number,
 *   gMax: number}} Box
 */

/**
 * @typedef {object} SolveOptions
 * @property {readonly number[]} target desired correction in dB on `grid`; with
 *   `measurement`, the target curve (the correction is target - measurement)
 * @property {readonly number[]} [grid] strictly increasing frequencies (default GRID)
 * @property {readonly number[]} [measurement] measured response in dB on `grid`
 * @property {number} [maxBands] sections the solver may use, 0–10 (default 10)
 * @property {boolean} [allowExperimental] with layer 'engenharia', allows HS
 * @property {import('../safety/policy.mjs').Layer} [layer] UI layer (default 'ajustar')
 * @property {WeightMode} [weights] D4 weighting (default 'iso226')
 * @property {number} [phon] loudness of the ISO 226 weights (default 60)
 * @property {RangeMode} [ranges] parameter boxes (default 'abs')
 * @property {number} [d5Weight] D5 weight, dB² per dB² (default 0.005)
 * @property {number} [sharpnessWeight] AutoEq sharpness penalty weight (default 1)
 * @property {number} [trebleDetail] weight 0–1 of the deviation from the >= 10 kHz mean
 *   (0 = AutoEq's treble averaging, 1 = plain error; default 0.5)
 * @property {number} [speed] correction speed 0–100 (default 50)
 * @property {boolean} [levelMatch] remove the weighted mean error (default true)
 * @property {number} [maxTimeMs] best-effort optimization time budget (default 1200),
 *   only effective when `clock` advances during synchronous execution
 * @property {Clock} [clock] nondecreasing finite milliseconds from now(); defaults to
 *   performance.now() when available, otherwise Date.now()
 * @property {number} [maxIterations] primary LM trial bound, a positive safe integer
 *   shared across re-seeding rounds (default 400)
 * @property {number} [minStd] std of the last 8 accepted losses to stop (default 0.002)
 * @property {number} [targetLoss] stop when the loss is at or below this value
 * @property {number} [seed] integer, reserved (the solver uses no randomness)
 */

/**
 * @typedef {object} SolveResult
 * @property {Band[]} bands exactly 10 sections (PK/LS/OFF; HS only if allowed)
 * @property {number} preampDb automatic preamp (`autoPreamp`)
 * @property {number} rmsDb level-matched unweighted RMS of fit - correction, 20 Hz–20 kHz
 * @property {number} loss sqrt of the objective at the returned bands
 * @property {number} iterations LM trials
 * @property {number} elapsedMs whole-solve duration measured by `clock`
 * @property {StopReason} stopReason
 * @property {{ok: true, reasons: Reason[]}} gate `gateForWrite` verdict of the result
 */

/** Default values of the tuning options. */
export const SOLVER_DEFAULTS = Object.freeze({
  maxBands: BAND_COUNT,
  weights: /** @type {WeightMode} */ ('iso226'),
  phon: 60,
  ranges: /** @type {RangeMode} */ ('abs'),
  d5Weight: 0.005,
  sharpnessWeight: 1,
  trebleDetail: 0.5,
  speed: 50,
  maxTimeMs: 1200,
  maxIterations: 400,
  minStd: 0.002,
});

const AUDIBLE_MIN_HZ = 20;
const AUDIBLE_MAX_HZ = 20000;
const AVERAGE_ABOVE_HZ = 10000;
const SHELF_SPLIT_MIN_HZ = 40;
const SHELF_INIT_Q = 0.7;
const SHARPNESS_INTERCEPT = -0.09503189270199464;
const SHARPNESS_SLOPE = 20.575128011847003;
const CASCADE_CHECK_DB = 18;
const FD_STEPS = Object.freeze([1e-6, 1e-6, 1e-5]);
const STD_WINDOW = 8;
const REFILL_ROUNDS = 3;
const LINE_ITERATIONS = 10;
const CASCADE_ITERATIONS = 8;
const SHRINK_ITERATIONS = 12;
const FINALIZE_ITERATIONS = 24;
const SNAP_STEPS = 100;
const BOX_TOLERANCE = 1e-9;

const DEFAULT_CLOCK = Object.freeze({
  now: () => globalThis.performance?.now?.() ?? Date.now(),
});

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// --- Policy helpers ---------------------------------------------------------------

/**
 * Regularization derived from the correction speed (0–100): `regularization` is
 * the weight λ of Σ (gain/10 dB)² in the objective, `pruneDb` the smallest
 * |gain| a section may keep.
 * @param {number} speed
 * @returns {{regularization: number, pruneDb: number}}
 */
export function speedParameters(speed) {
  const slowness = 100 - speed;
  return { regularization: 0.02 * (slowness / 50) ** 2, pruneDb: 0.1 + 0.008 * slowness };
}

/**
 * Parameter box of a section of `kind` (with its current Q and gain, which select
 * the sub-range): ABS_RANGES or SOFT_RANGES, D7 included.
 * @param {SolverKind} kind
 * @param {boolean} soft
 * @param {number} qFactor
 * @param {number} gainDb
 * @returns {Box}
 */
export function parameterBox(kind, soft, qFactor, gainDb) {
  const boost = gainDb > 0;
  const pkBoost = kind === 'PK' && boost;
  if (!soft) {
    return {
      fMin: ABS_RANGES.freqHz.min,
      fMax: pkBoost ? ABS_RANGES.pkBoostMaxHz : ABS_RANGES.freqHz.max,
      qMin: ABS_RANGES.qFactor.min,
      qMax: boost ? ABS_RANGES.boostQMax : ABS_RANGES.qFactor.max,
      gMin: ABS_RANGES.gainDb.min,
      gMax: ABS_RANGES.gainDb.max,
    };
  }
  if (kind === 'PK') {
    const main = SOFT_RANGES['PK-main'];
    const narrow = SOFT_RANGES['PK-narrow'];
    const r = qFactor > main.qFactor.max ? narrow : main;
    return {
      fMin: r.freqHz.min,
      fMax: pkBoost ? ABS_RANGES.pkBoostMaxHz : r.freqHz.max,
      qMin: main.qFactor.min,
      qMax: narrow.qFactor.max,
      gMin: /** @type {Range} */ (r.gainDb).min,
      gMax: /** @type {Range} */ (r.gainDb).max,
    };
  }
  const r = kind === 'LS' ? SOFT_RANGES.LS : SOFT_RANGES[boost ? 'HS-boost' : 'HS-cut'];
  const gainMax = kind === 'LS' ? SOFT_RANGES.LS : SOFT_RANGES['HS-boost'];
  return {
    fMin: r.freqHz.min,
    fMax: r.freqHz.max,
    qMin: r.qFactor.min,
    qMax: r.qFactor.max,
    gMin: /** @type {Range} */ (r.gainDb).min,
    gMax: /** @type {Range} */ (gainMax.gainDb).max,
  };
}

/**
 * Projects (log10 f, log10 Q, gain) into the box of `kind`.
 * @param {SolverKind} kind
 * @param {boolean} soft
 * @param {number} u
 * @param {number} v
 * @param {number} g
 * @returns {SolverBand}
 */
function projectToBox(kind, soft, u, v, g) {
  let box = parameterBox(kind, soft, 10 ** v, g);
  v = clamp(v, Math.log10(box.qMin), Math.log10(box.qMax));
  box = parameterBox(kind, soft, 10 ** v, g);
  g = clamp(g, box.gMin, box.gMax);
  box = parameterBox(kind, soft, 10 ** v, g);
  v = clamp(v, Math.log10(box.qMin), Math.log10(box.qMax));
  u = clamp(u, Math.log10(box.fMin), Math.log10(box.fMax));
  return { kind, freqHz: 10 ** u, gainDb: g, qFactor: 10 ** v };
}

/**
 * @param {SolverBand} band
 * @param {boolean} soft
 */
function inBox(band, soft) {
  const box = parameterBox(band.kind, soft, band.qFactor, band.gainDb);
  const lo = 1 - BOX_TOLERANCE;
  const hi = 1 + BOX_TOLERANCE;
  return (
    band.freqHz >= box.fMin * lo &&
    band.freqHz <= box.fMax * hi &&
    band.qFactor >= box.qMin * lo &&
    band.qFactor <= box.qMax * hi &&
    band.gainDb >= box.gMin - BOX_TOLERANCE &&
    band.gainDb <= box.gMax + BOX_TOLERANCE
  );
}

/**
 * Section predicate: inside the box (D7 included) and accepted by the gate's
 * per-section checks (a, b, c on the quantized section).
 * @param {boolean} soft
 * @returns {(band: SolverBand) => boolean}
 */
function sectionPredicate(soft) {
  return (band) => inBox(band, soft) && sectionAnalysis(band).reasons.length === 0;
}

/**
 * @param {SolverBand} a
 * @param {SolverBand} b
 * @param {number} t
 * @returns {SolverBand}
 */
const lerpBand = (a, b, t) => /** @type {SolverBand} */ (interpolateBand(a, b, t));

/**
 * @param {readonly SolverBand[]} a
 * @param {readonly SolverBand[]} b
 * @param {number} t
 * @returns {readonly SolverBand[]}
 */
const lerpBands = (a, b, t) => a.map((band, i) => lerpBand(band, b[i], t));

/**
 * Zero-gain band at the same frequency with the smallest Q of the box: the
 * feasible starting point of boundary searches.
 * @param {SolverBand} band
 * @param {boolean} soft
 * @returns {SolverBand}
 */
function anchorOf(band, soft) {
  const box = parameterBox(band.kind, soft, band.qFactor, 0);
  return {
    kind: band.kind,
    freqHz: clamp(Math.round(band.freqHz), box.fMin, box.fMax),
    gainDb: 0,
    qFactor: box.qMin,
  };
}

/**
 * Sections ordered cuts (gain < 0) first, then boosts, each by frequency.
 * @param {readonly SolverBand[]} bands
 * @returns {SolverBand[]}
 */
function defaultOrder(bands) {
  const byFrequency = (/** @type {SolverBand} */ a, /** @type {SolverBand} */ b) =>
    a.freqHz - b.freqHz;
  return [
    ...bands.filter((b) => b.gainDb < 0).sort(byFrequency),
    ...bands.filter((b) => !(b.gainDb < 0)).sort(byFrequency),
  ];
}

/**
 * @param {readonly SolverBand[]} bands
 * @returns {Band[]}
 */
function pad(bands) {
  const off = () => /** @type {Band} */ ({ kind: 'OFF' });
  return [...bands, ...Array.from({ length: BAND_COUNT - bands.length }, off)];
}

/**
 * Sharpness coefficient of a peaking section (AutoEq): ~0 below the gain limit
 * of its Q, ~1 above.
 * @param {number} gainDb
 * @param {number} qFactor
 */
export function sharpnessCoefficient(gainDb, qFactor) {
  const limit = SHARPNESS_INTERCEPT + SHARPNESS_SLOPE / qFactor;
  return 1 / (1 + Math.exp(-100 * (gainDb / limit - 1)));
}

/**
 * D5 opposition score Σ (1 - d)² |g_a g_b| (dB²) over sections adjacent in
 * frequency with opposite-sign gains whose centres are d < 1 octave apart.
 * OFF and gainless sections are ignored.
 * @param {readonly Band[]} bands
 */
export function oppositeNeighbourScore(bands) {
  const sorted = bands
    .filter((b) => b.kind === 'PK' || b.kind === 'LS' || b.kind === 'HS')
    .map((b) => /** @type {SolverBand} */ (b))
    .sort((a, b) => a.freqHz - b.freqHz);
  let score = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const d = Math.log2(b.freqHz / a.freqHz);
    if (a.gainDb * b.gainDb < 0 && d < 1) score += (1 - d) ** 2 * Math.abs(a.gainDb * b.gainDb);
  }
  return score;
}

// --- Fast response evaluator ------------------------------------------------------

/**
 * @typedef {{uRe: Float64Array, uIm: Float64Array, u2Re: Float64Array, u2Im: Float64Array}} Terms
 */

/**
 * Per-frequency terms of the 0xCB magnitude evaluator (u = 1 - e^-jw).
 * @param {readonly number[]} grid
 * @returns {Terms}
 */
function makeTerms(grid) {
  const n = grid.length;
  const terms = {
    uRe: new Float64Array(n),
    uIm: new Float64Array(n),
    u2Re: new Float64Array(n),
    u2Im: new Float64Array(n),
  };
  grid.forEach((freqHz, j) => {
    const omega = (2 * Math.PI * freqHz) / SAMPLE_RATE;
    const halfSin = Math.sin(omega / 2);
    const re = 2 * halfSin * halfSin;
    const im = Math.sin(omega);
    terms.uRe[j] = re;
    terms.uIm[j] = im;
    terms.u2Re[j] = re * re - im * im;
    terms.u2Im[j] = 2 * re * im;
  });
  return terms;
}

/**
 * Writes the dB response of one section on the grid into `out` (same math as
 * eq0xcb `magnitudeDb`).
 * @param {Terms} terms
 * @param {SolverBand} band
 * @param {Float64Array} out
 * @returns {Float64Array}
 */
function responseInto(terms, band, out) {
  const { b0, b1, b2, a1, a2 } = designSection(band);
  const sb = b0 + b1 + b2;
  const tb = b1 + 2 * b2;
  const sa = 1 + a1 + a2;
  const ta = a1 + 2 * a2;
  const { uRe, uIm, u2Re, u2Im } = terms;
  for (let j = 0; j < out.length; j++) {
    const nr = sb - tb * uRe[j] + b2 * u2Re[j];
    const ni = -tb * uIm[j] + b2 * u2Im[j];
    const dr = sa - ta * uRe[j] + a2 * u2Re[j];
    const di = -ta * uIm[j] + a2 * u2Im[j];
    out[j] = 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return out;
}

// --- Problem context and objective -----------------------------------------------

/**
 * @typedef {object} Context
 * @property {readonly number[]} grid
 * @property {number} n
 * @property {Float64Array} target
 * @property {Float64Array} logf log2 of the grid
 * @property {number[]} lo indices with 20 Hz <= f < 10 kHz
 * @property {number[]} hi indices with 10 kHz <= f <= 20 kHz
 * @property {number[]} inRange lo then hi (contiguous, ascending)
 * @property {Float64Array} w normalized weights (sum 1 over inRange, 0 elsewhere)
 * @property {number} wHi sum of the weights over hi
 * @property {boolean} levelMatch
 * @property {boolean} soft
 * @property {boolean} allowHs
 * @property {number} maxBands
 * @property {number} trebleDetail
 * @property {number} sharpness
 * @property {number} d5
 * @property {number} regularization
 * @property {number} pruneDb
 * @property {Terms} terms
 * @property {(band: SolverBand) => boolean} feasible
 */

/**
 * @typedef {object} State
 * @property {readonly SolverBand[]} bands
 * @property {Float64Array[]} resp
 * @property {Float64Array} rms
 * @property {Float64Array} fit
 * @property {Float64Array} rows
 * @property {number} f objective (loss²)
 */

/**
 * @param {Context} ctx
 * @param {Float64Array} values
 */
function rmsOf(ctx, values) {
  let sum = 0;
  for (const i of ctx.inRange) sum += values[i] * values[i];
  return Math.sqrt(sum / ctx.inRange.length);
}

/**
 * Mean error over the >= 10 kHz block (0 without such points).
 * @param {Context} ctx
 * @param {Float64Array} err
 */
function hiMean(ctx, err) {
  let sum = 0;
  for (const i of ctx.hi) sum += err[i];
  return ctx.hi.length ? sum / ctx.hi.length : 0;
}

/**
 * Level-matching offset c = Σ w e with the >= 10 kHz block averaged (0 when
 * level matching is off).
 * @param {Context} ctx
 * @param {Float64Array} err
 */
function levelOffset(ctx, err) {
  if (!ctx.levelMatch) return 0;
  let c = ctx.wHi * hiMean(ctx, err);
  for (const i of ctx.lo) c += ctx.w[i] * err[i];
  return c;
}

/**
 * @param {Context} ctx
 * @param {number} sections
 */
function rowCount(ctx, sections) {
  return ctx.lo.length + (ctx.hi.length ? 1 + ctx.hi.length : 0) + 2 * sections + 1;
}

/**
 * Residual vector of the objective (see the module comment).
 * @param {Context} ctx
 * @param {readonly SolverBand[]} bands
 * @param {Float64Array} rms
 * @param {Float64Array} fit
 * @param {Float64Array} out
 * @returns {Float64Array}
 */
function buildRows(ctx, bands, rms, fit, out) {
  const err = new Float64Array(ctx.n);
  for (const i of ctx.inRange) err[i] = ctx.target[i] - fit[i];
  const c = levelOffset(ctx, err);
  let r = 0;
  for (const i of ctx.lo) out[r++] = Math.sqrt(ctx.w[i]) * (err[i] - c);
  if (ctx.hi.length) {
    const mean = hiMean(ctx, err);
    out[r++] = Math.sqrt(ctx.wHi) * (mean - c);
    for (const i of ctx.hi) out[r++] = Math.sqrt(ctx.trebleDetail * ctx.w[i]) * (err[i] - mean);
  }
  const sharp = Math.sqrt(ctx.sharpness);
  const reg = Math.sqrt(ctx.regularization);
  bands.forEach((band, k) => {
    out[r++] =
      band.kind === 'PK' ? sharp * sharpnessCoefficient(band.gainDb, band.qFactor) * rms[k] : 0;
    out[r++] = (reg * band.gainDb) / 10;
  });
  out[r] = Math.sqrt(ctx.d5 * oppositeNeighbourScore(bands));
  return out;
}

/** @param {Float64Array} rows */
function sumSquares(rows) {
  let s = 0;
  for (const value of rows) s += value * value;
  return s;
}

/**
 * @param {Context} ctx
 * @param {readonly SolverBand[]} bands
 * @returns {State}
 */
function evaluateState(ctx, bands) {
  const fit = new Float64Array(ctx.n);
  const rms = new Float64Array(bands.length);
  const resp = bands.map((band, k) => {
    const r = responseInto(ctx.terms, band, new Float64Array(ctx.n));
    rms[k] = rmsOf(ctx, r);
    for (let j = 0; j < ctx.n; j++) fit[j] += r[j];
    return r;
  });
  const rows = buildRows(ctx, bands, rms, fit, new Float64Array(rowCount(ctx, bands.length)));
  return { bands, resp, rms, fit, rows, f: sumSquares(rows) };
}

/**
 * Level-matched error target - fit (for seeding filters on the residual).
 * @param {Context} ctx
 * @param {Float64Array} fit
 */
function residualOf(ctx, fit) {
  const err = new Float64Array(ctx.n);
  for (const i of ctx.inRange) err[i] = ctx.target[i] - fit[i];
  const c = levelOffset(ctx, err);
  for (const i of ctx.inRange) err[i] -= c;
  return err;
}

/**
 * Weighted, level-matched squared error of `err` (fit rows only).
 * @param {Context} ctx
 * @param {Float64Array} err
 */
function errorEnergy(ctx, err) {
  const c = levelOffset(ctx, err);
  const mean = hiMean(ctx, err);
  let s = ctx.wHi * (mean - c) ** 2;
  for (const i of ctx.lo) s += ctx.w[i] * (err[i] - c) ** 2;
  for (const i of ctx.hi) s += ctx.trebleDetail * ctx.w[i] * (err[i] - mean) ** 2;
  return s;
}

// --- Initialization (AutoEq-derived) -----------------------------------------------

/**
 * Local maxima of `y` (scipy-style plateau handling, edges excluded) with
 * their height and width at half prominence, in octaves of `logf`.
 * @param {Float64Array} y
 * @param {Float64Array} logf
 * @returns {{index: number, height: number, octaves: number}[]}
 */
function findPeaks(y, logf) {
  const last = y.length - 1;
  /** @param {number} t fractional index */
  const position = (t) => {
    const i = Math.min(Math.floor(t), last - 1);
    return logf[i] + (t - i) * (logf[i + 1] - logf[i]);
  };
  /** @type {{index: number, height: number, octaves: number}[]} */
  const peaks = [];
  let i = 1;
  while (i < last) {
    if (y[i - 1] < y[i]) {
      let ahead = i + 1;
      while (ahead < last && y[ahead] === y[i]) ahead++;
      if (y[ahead] < y[i]) {
        const p = Math.floor((i + ahead - 1) / 2);
        const h = y[p];
        let leftMin = h;
        let leftBase = p;
        for (let k = p; k >= 0 && y[k] <= h; k--) {
          if (y[k] < leftMin) [leftMin, leftBase] = [y[k], k];
        }
        let rightMin = h;
        let rightBase = p;
        for (let k = p; k <= last && y[k] <= h; k++) {
          if (y[k] < rightMin) [rightMin, rightBase] = [y[k], k];
        }
        const level = h - (h - Math.max(leftMin, rightMin)) / 2;
        // Crossings of the half-prominence level, interpolated (y[l] <= level < y[l + 1]).
        let l = p;
        while (l > leftBase && y[l] > level) l--;
        const left = l + (level - y[l]) / (y[l + 1] - y[l]);
        let r = p;
        while (r < rightBase && y[r] > level) r++;
        const right = r - (level - y[r]) / (y[r - 1] - y[r]);
        peaks.push({ index: p, height: h, octaves: position(right) - position(left) });
      }
      i = ahead;
    } else {
      i++;
    }
  }
  return peaks;
}

/**
 * Peaks of clip(±remaining, 0) over 20 Hz–20 kHz, highest width × height first.
 * @param {Context} ctx
 * @param {Float64Array} remaining
 * @returns {{index: number, gainDb: number, octaves: number}[]}
 */
function peakCandidates(ctx, remaining) {
  const first = ctx.inRange[0];
  const m = ctx.inRange.length;
  const logf = new Float64Array(m + 2);
  for (let k = 0; k < m; k++) logf[k + 1] = ctx.logf[first + k];
  logf[0] = 2 * logf[1] - logf[2];
  logf[m + 1] = 2 * logf[m] - logf[m - 1];
  /** @type {{index: number, gainDb: number, octaves: number}[]} */
  const out = [];
  for (const sign of [1, -1]) {
    const y = new Float64Array(m + 2);
    for (let k = 0; k < m; k++) y[k + 1] = Math.max(0, sign * remaining[first + k]);
    for (const p of findPeaks(y, logf)) {
      if (p.height >= ctx.pruneDb) {
        out.push({ index: first + p.index - 1, gainDb: sign * p.height, octaves: p.octaves });
      }
    }
  }
  const size = (/** @type {{gainDb: number, octaves: number}} */ c) =>
    c.octaves * Math.abs(c.gainDb);
  return out.sort((a, b) => size(b) - size(a) || a.index - b.index);
}

/**
 * Projects a seed into the box and, if the gate's section checks refuse it,
 * pulls it back toward the zero-gain anchor (always accepted: zero gain at the
 * box's lowest Q).
 * @param {Context} ctx
 * @param {SolverKind} kind
 * @param {number} freqHz
 * @param {number} gainDb
 * @param {number} qFactor
 * @returns {SolverBand}
 */
function feasibleSeed(ctx, kind, freqHz, gainDb, qFactor) {
  const band = projectToBox(kind, ctx.soft, Math.log10(freqHz), Math.log10(qFactor), gainDb);
  return boundarySearch(anchorOf(band, ctx.soft), band, ctx.feasible, {
    iterations: 16,
    interpolate: lerpBand,
  });
}

/**
 * AutoEq peaking init on `remaining`, skipping peaks already used.
 * @param {Context} ctx
 * @param {Float64Array} remaining
 * @param {number[]} used
 * @returns {SolverBand | null}
 */
function seedPeaking(ctx, remaining, used) {
  for (const c of peakCandidates(ctx, remaining)) {
    if (used.some((i) => Math.abs(i - c.index) <= 1)) continue;
    used.push(c.index);
    const ratio = 2 ** c.octaves;
    const qFactor = Math.sqrt(ratio) / (ratio - 1);
    return feasibleSeed(ctx, 'PK', ctx.grid[c.index], c.gainDb, qFactor);
  }
  return null;
}

/**
 * AutoEq shelf init on `remaining`; kept only if it lowers the weighted error.
 * @param {Context} ctx
 * @param {Float64Array} remaining
 * @param {'LS' | 'HS'} kind
 * @returns {SolverBand | null}
 */
function seedShelf(ctx, remaining, kind) {
  const values = ctx.inRange.map((i) => remaining[i]);
  let best = -1;
  let bestMean = 0;
  ctx.inRange.forEach((i, k) => {
    const f = ctx.grid[i];
    if (f < SHELF_SPLIT_MIN_HZ || f >= AVERAGE_ABOVE_HZ) return;
    const part = kind === 'LS' ? values.slice(0, k + 1) : values.slice(k);
    const mean = part.reduce((s, v) => s + v, 0) / part.length;
    if (Math.abs(mean) > Math.abs(bestMean)) [best, bestMean] = [i, mean];
  });
  if (best < 0) return null;
  const unitBand = { kind, freqHz: ctx.grid[best], gainDb: 1, qFactor: SHELF_INIT_Q };
  const unit = responseInto(ctx.terms, unitBand, new Float64Array(ctx.n));
  let num = 0;
  let den = 0;
  for (const i of ctx.inRange) {
    num += remaining[i] * unit[i];
    den += unit[i];
  }
  const gainDb = num / den;
  if (!(Math.abs(gainDb) >= ctx.pruneDb)) return null;
  const band = feasibleSeed(ctx, kind, ctx.grid[best], gainDb, SHELF_INIT_Q);
  const resp = responseInto(ctx.terms, band, new Float64Array(ctx.n));
  const after = remaining.map((v, i) => v - resp[i]);
  return errorEnergy(ctx, after) < errorEnergy(ctx, remaining) ? band : null;
}

/**
 * Sequential AutoEq-style initialization: shelves first, then peaks.
 * @param {Context} ctx
 * @returns {SolverBand[]}
 */
function initialize(ctx) {
  const remaining = Float64Array.from(ctx.target);
  /** @type {SolverBand[]} */
  const bands = [];
  /**
   * Adds a seed unless the cascade would fail the gate at the lowest preamp.
   * @param {SolverBand} band
   */
  const take = (band) => {
    const resp = responseInto(ctx.terms, band, new Float64Array(ctx.n));
    let peak = -Infinity;
    for (const i of ctx.inRange) peak = Math.max(peak, ctx.target[i] - remaining[i] + resp[i]);
    if (peak > CASCADE_CHECK_DB && !cascadeAccepted(ctx, [...bands, band])) return false;
    for (let j = 0; j < ctx.n; j++) remaining[j] -= resp[j];
    bands.push(band);
    return true;
  };
  /** @type {('LS' | 'HS')[]} */
  const shelves = ctx.allowHs ? ['LS', 'HS'] : ['LS'];
  for (const kind of shelves) {
    const band = bands.length < ctx.maxBands ? seedShelf(ctx, remaining, kind) : null;
    if (band) take(band);
  }
  /** @type {number[]} */
  const used = [];
  for (let slot = bands.length; slot < ctx.maxBands; slot++) {
    const band = seedPeaking(ctx, remaining, used);
    if (!band || !take(band)) break;
  }
  return bands;
}

// --- Levenberg–Marquardt with boxes and gate projection -------------------------

/**
 * @typedef {object} Budget
 * @property {Clock} clock
 * @property {number} deadline
 * @property {number} maxIterations
 * @property {number} iterations
 * @property {number | undefined} targetLoss
 * @property {number} minStd
 */

/**
 * @param {Budget} budget
 * @param {number} f
 * @returns {StopReason | null}
 */
function budgetStop(budget, f) {
  if (budget.targetLoss !== undefined && Math.sqrt(f) <= budget.targetLoss) return 'targetLoss';
  if (budget.clock.now() >= budget.deadline) return 'time';
  return null;
}

/**
 * @param {SolverBand} band
 * @param {number} p 0 = log10 f, 1 = log10 Q, 2 = gain
 * @param {number} h
 * @returns {SolverBand}
 */
function perturb(band, p, h) {
  if (p === 0) return { ...band, freqHz: band.freqHz * 10 ** h };
  if (p === 1) return { ...band, qFactor: band.qFactor * 10 ** h };
  return { ...band, gainDb: band.gainDb + h };
}

/**
 * Variables (log10 f, log10 Q, gain) of a band and their box bounds.
 * @param {Context} ctx
 * @param {SolverBand} band
 */
function variables(ctx, band) {
  const box = parameterBox(band.kind, ctx.soft, band.qFactor, band.gainDb);
  return {
    values: [Math.log10(band.freqHz), Math.log10(band.qFactor), band.gainDb],
    lower: [Math.log10(box.fMin), Math.log10(box.qMin), box.gMin],
    upper: [Math.log10(box.fMax), Math.log10(box.qMax), box.gMax],
  };
}

/**
 * Forward-difference Jacobian columns of the residual vector.
 * @param {Context} ctx
 * @param {State} state
 * @returns {Float64Array[]}
 */
function jacobian(ctx, state) {
  const rows = new Float64Array(state.rows.length);
  const fit = new Float64Array(ctx.n);
  const rms = Float64Array.from(state.rms);
  const resp = new Float64Array(ctx.n);
  /** @type {Float64Array[]} */
  const columns = [];
  state.bands.forEach((band, k) => {
    const { values, upper } = variables(ctx, band);
    for (let p = 0; p < 3; p++) {
      const h = values[p] + FD_STEPS[p] > upper[p] ? -FD_STEPS[p] : FD_STEPS[p];
      const bands = state.bands.slice();
      bands[k] = perturb(band, p, h);
      responseInto(ctx.terms, bands[k], resp);
      for (let j = 0; j < ctx.n; j++) fit[j] = state.fit[j] - state.resp[k][j] + resp[j];
      rms[k] = rmsOf(ctx, resp);
      buildRows(ctx, bands, rms, fit, rows);
      columns.push(rows.map((value, m) => (value - state.rows[m]) / h));
      rms[k] = state.rms[k];
    }
  });
  return columns;
}

/**
 * Cholesky solve of the damped SPD system B x = b (row-major P×P). A pivot lost
 * to rounding is floored: the resulting step is projected and, if worse,
 * rejected by the LM loop like any other.
 * @param {Float64Array} B
 * @param {Float64Array} b
 * @param {number} P
 * @returns {Float64Array}
 */
function choleskySolve(B, b, P) {
  const L = new Float64Array(P * P);
  for (let i = 0; i < P; i++) {
    for (let j = 0; j <= i; j++) {
      let s = B[i * P + j];
      for (let k = 0; k < j; k++) s -= L[i * P + k] * L[j * P + k];
      L[i * P + j] = i === j ? Math.sqrt(Math.max(s, 1e-30)) : s / L[j * P + j];
    }
  }
  const y = new Float64Array(P);
  for (let i = 0; i < P; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * P + k] * y[k];
    y[i] = s / L[i * P + i];
  }
  const x = new Float64Array(P);
  for (let i = P - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < P; k++) s -= L[k * P + i] * x[k];
    x[i] = s / L[i * P + i];
  }
  return x;
}

/**
 * @param {Context} ctx
 * @param {readonly SolverBand[]} bands
 */
function cascadeAccepted(ctx, bands) {
  return gate(pad(defaultOrder(bands)), THRESHOLDS.preampMinDb, {
    experimental: ctx.allowHs,
    grid: 'drag',
  }).ok;
}

/**
 * Candidate state for a step `delta`: per-section box projection and gate
 * section projection; whole-curve drag-gate projection when the fit peaks high.
 * `null` when the step cannot be projected.
 * @param {Context} ctx
 * @param {State} state
 * @param {Float64Array} delta
 * @returns {State | null}
 */
function candidateState(ctx, state, delta) {
  const bands = state.bands.map((band, k) => {
    const next = projectToBox(
      band.kind,
      ctx.soft,
      Math.log10(band.freqHz) + delta[3 * k],
      Math.log10(band.qFactor) + delta[3 * k + 1],
      band.gainDb + delta[3 * k + 2],
    );
    return ctx.feasible(next)
      ? next
      : boundarySearch(band, next, ctx.feasible, {
          iterations: LINE_ITERATIONS,
          interpolate: lerpBand,
        });
  });
  const next = evaluateState(ctx, bands);
  let peak = -Infinity;
  for (const i of ctx.inRange) peak = Math.max(peak, next.fit[i]);
  if (peak <= CASCADE_CHECK_DB || cascadeAccepted(ctx, bands)) return next;
  if (!cascadeAccepted(ctx, state.bands)) return null;
  const projected = boundarySearch(
    state.bands,
    bands,
    (list) => list.every(ctx.feasible) && cascadeAccepted(ctx, list),
    { iterations: CASCADE_ITERATIONS, interpolate: lerpBands },
  );
  return evaluateState(ctx, projected);
}

/**
 * Box-constrained Levenberg–Marquardt from `state`.
 * @param {Context} ctx
 * @param {State} state
 * @param {Budget} budget
 * @returns {{state: State, stopReason: StopReason}}
 */
function optimize(ctx, state, budget) {
  const P = 3 * state.bands.length;
  let mu = 1e-2;
  const history = [Math.sqrt(state.f)];
  // Each outer step consumes at least one trial from the shared finite budget.
  while (budget.iterations < budget.maxIterations) {
    const stop = budgetStop(budget, state.f);
    if (stop) return { state, stopReason: stop };
    const columns = jacobian(ctx, state);
    const A = new Float64Array(P * P);
    const grad = new Float64Array(P);
    for (let a = 0; a < P; a++) {
      let g = 0;
      for (let m = 0; m < state.rows.length; m++) g += columns[a][m] * state.rows[m];
      grad[a] = g;
      for (let b = 0; b <= a; b++) {
        let s = 0;
        for (let m = 0; m < state.rows.length; m++) s += columns[a][m] * columns[b][m];
        A[a * P + b] = s;
        A[b * P + a] = s;
      }
    }
    const frozen = new Uint8Array(P);
    state.bands.forEach((band, k) => {
      const { values, lower, upper } = variables(ctx, band);
      for (let p = 0; p < 3; p++) {
        const j = 3 * k + p;
        const atLower = values[p] <= lower[p] + 1e-12 && grad[j] > 0;
        const atUpper = values[p] >= upper[p] - 1e-12 && grad[j] < 0;
        frozen[j] = atLower || atUpper ? 1 : 0;
      }
    });
    /** @type {State | null} */
    let accepted = null;
    while (accepted === null && budget.iterations < budget.maxIterations) {
      const stop = budgetStop(budget, state.f);
      if (stop) return { state, stopReason: stop };
      budget.iterations++;
      const B = new Float64Array(P * P);
      const rhs = new Float64Array(P);
      for (let a = 0; a < P; a++) {
        for (let b = 0; b < P; b++) B[a * P + b] = frozen[a] || frozen[b] ? 0 : A[a * P + b];
        B[a * P + a] = frozen[a] ? 1 : A[a * P + a] + mu * Math.max(A[a * P + a], 1e-12);
        rhs[a] = frozen[a] ? 0 : -grad[a];
      }
      const candidate = candidateState(ctx, state, choleskySolve(B, rhs, P));
      if (candidate && candidate.f < state.f) {
        accepted = candidate;
        mu = Math.max(mu / 3, 1e-9);
      } else {
        mu *= 4;
        if (mu > 1e8) return { state, stopReason: 'converged' };
      }
    }
    if (accepted === null) break;
    state = accepted;
    history.push(Math.sqrt(state.f));
    if (history.length >= STD_WINDOW) {
      const last = history.slice(-STD_WINDOW);
      const mean = last.reduce((s, v) => s + v, 0) / STD_WINDOW;
      const std = Math.sqrt(last.reduce((s, v) => s + (v - mean) ** 2, 0) / STD_WINDOW);
      if (std < budget.minStd) return { state, stopReason: 'converged' };
    }
  }
  return { state, stopReason: 'iterations' };
}

// --- Finalization -----------------------------------------------------------------

/**
 * Rounds a section to the UI grid while keeping it accepted by `feasible`;
 * `null` when only a zero-gain section remains.
 * @param {SolverBand} band
 * @param {boolean} soft
 * @param {(band: SolverBand) => boolean} feasible
 * @returns {SolverBand | null}
 */
function snapBand(band, soft, feasible) {
  const rounded = roundToGrid(band);
  if (feasible(rounded) && rounded.gainDb !== 0) return rounded;
  const anchor = anchorOf(band, soft);
  const near = feasible(band)
    ? band
    : boundarySearch(anchor, band, feasible, {
        iterations: FINALIZE_ITERATIONS,
        interpolate: lerpBand,
      });
  const snapped = snapToGridAccepted(near, anchor, feasible, { maxSteps: SNAP_STEPS });
  return snapped.gainDb !== 0 ? snapped : null;
}

/**
 * Turns gain sections into a gate-approved 10-section curve: rounding to the UI
 * grid (kept inside the boxes and the gate's section checks), default order
 * (cuts first, then boosts, by frequency) or the first passing alternative
 * order, boost shrinking by boundary search, dropping to OFF as a last resort,
 * and `autoPreamp`. HS needs `experimental`; LP/HP/OFF inputs are dropped; more
 * than 10 sections keep the 10 largest |gain|.
 * @param {readonly Band[]} bands
 * @param {{experimental?: boolean, ranges?: RangeMode}} [options]
 * @returns {{bands: Band[], preampDb: number, gate: {ok: true, reasons: Reason[]}}}
 */
export function finalizeBands(bands, { experimental = false, ranges = 'abs' } = {}) {
  const soft = ranges === 'soft';
  const feasible = sectionPredicate(soft);
  /** @type {SolverBand[]} */
  const snapped = [];
  for (const band of bands) {
    const allowed =
      band.kind === 'PK' || band.kind === 'LS' || (experimental && band.kind === 'HS');
    const s = allowed ? snapBand(/** @type {SolverBand} */ (band), soft, feasible) : null;
    if (s) snapped.push(s);
  }
  snapped.sort((a, b) => Math.abs(b.gainDb) - Math.abs(a.gainDb));
  const kept = snapped.slice(0, BAND_COUNT);
  const atFloor = (/** @type {readonly SolverBand[]} */ list) =>
    gate(pad(list), THRESHOLDS.preampMinDb, { experimental }).ok;
  const base = defaultOrder(kept);
  const byFrequency = [...kept].sort((a, b) => a.freqHz - b.freqHz);
  const cuts = base.filter((b) => b.gainDb < 0);
  const boosts = base.filter((b) => !(b.gainDb < 0));
  let chosen = [base, byFrequency, [...boosts, ...cuts]].find(atFloor);
  if (!chosen) {
    /** @param {number} t */
    const scaled = (t) =>
      base.flatMap((band) => {
        if (band.gainDb < 0) return [band];
        const next = roundToGrid({ ...band, gainDb: band.gainDb * t });
        return next.gainDb > 0 && feasible(next) ? [next] : [];
      });
    const shrink = (/** @type {number} */ t) => atFloor(scaled(t));
    const t = shrink(0) ? boundarySearch(0, 1, shrink, { iterations: SHRINK_ITERATIONS }) : 0;
    chosen = scaled(t);
  }
  for (let size = chosen.length; size >= 0; size--) {
    const padded = pad(chosen.slice(0, size));
    const preampDb = autoPreamp(padded, { experimental });
    if (preampDb !== null) {
      const verdict = gateForWrite(padded, preampDb, { experimental });
      if (verdict.ok) {
        return { bands: padded, preampDb, gate: { ok: true, reasons: verdict.reasons } };
      }
    }
  }
  throw new Error('gate refused the neutral preset');
}

// --- Public API ---------------------------------------------------------------

/**
 * @param {unknown} values
 * @param {number} length
 * @param {string} name
 * @returns {asserts values is readonly number[]}
 */
function checkCurve(values, length, name) {
  if (!Array.isArray(values) || values.length !== length || !values.every(Number.isFinite)) {
    throw new RangeError(`${name} must contain one finite dB value per grid frequency`);
  }
}

/**
 * @param {unknown} grid
 * @returns {asserts grid is readonly number[]}
 */
function checkGrid(grid) {
  if (
    !Array.isArray(grid) ||
    grid.length < 2 ||
    !grid.every((f, i) => Number.isFinite(f) && f > 0 && (i === 0 || f > grid[i - 1]))
  ) {
    throw new RangeError('grid must contain at least 2 strictly increasing positive frequencies');
  }
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {string} name
 */
function checkNumber(value, min, max, name) {
  if (typeof value !== 'number' || !(value >= min && value <= max)) {
    throw new RangeError(`${name} must be a number in [${min}, ${max}], got ${value}`);
  }
}

/**
 * Solves a parametric EQ for `target` (see the module comment for the algorithm).
 * `target` is the desired correction in dB on `grid`; when `measurement` is
 * given, `target` is the target curve and the correction is target - measurement
 * (both on `grid`, e.g. from io/measurement `toGrid` + `normalize`). The result
 * always passes `gateForWrite(bands, preampDb)`.
 * Results (excluding `elapsedMs`) are deterministic when `stopReason !== 'time'`;
 * stopping on time depends on CPU load. `maxIterations` is the primary work bound,
 * shared across all LM/re-seeding rounds; other searches have fixed finite caps.
 * `clock` controls both the best-effort `maxTimeMs` budget and `elapsedMs`.
 * In Cloudflare Workers, time does not advance during synchronous code: servers
 * must rely on `maxIterations` and should not run this solver per request.
 * @param {SolveOptions} options
 * @returns {SolveResult}
 */
export function solvePeq(options) {
  const {
    target,
    grid = GRID,
    measurement,
    maxBands = SOLVER_DEFAULTS.maxBands,
    allowExperimental = false,
    layer = 'ajustar',
    weights = SOLVER_DEFAULTS.weights,
    phon = SOLVER_DEFAULTS.phon,
    ranges = SOLVER_DEFAULTS.ranges,
    d5Weight = SOLVER_DEFAULTS.d5Weight,
    sharpnessWeight = SOLVER_DEFAULTS.sharpnessWeight,
    trebleDetail = SOLVER_DEFAULTS.trebleDetail,
    speed = SOLVER_DEFAULTS.speed,
    levelMatch = true,
    maxTimeMs = SOLVER_DEFAULTS.maxTimeMs,
    clock = DEFAULT_CLOCK,
    maxIterations = SOLVER_DEFAULTS.maxIterations,
    minStd = SOLVER_DEFAULTS.minStd,
    targetLoss,
    seed = 1,
  } = options;
  if (clock === null || typeof clock.now !== 'function') {
    throw new TypeError('clock must provide now()');
  }
  const started = clock.now();
  checkGrid(grid);
  checkCurve(target, grid.length, 'target');
  if (measurement !== undefined) checkCurve(measurement, grid.length, 'measurement');
  if (!Number.isInteger(maxBands)) throw new RangeError('maxBands must be an integer');
  checkNumber(maxBands, 0, BAND_COUNT, 'maxBands');
  if (!Object.hasOwn(LAYER_KINDS, layer)) throw new RangeError(`unknown layer ${String(layer)}`);
  if (weights !== 'iso226' && weights !== 'flat') {
    throw new RangeError('weights must be iso226 or flat');
  }
  if (ranges !== 'abs' && ranges !== 'soft') throw new RangeError('ranges must be abs or soft');
  checkNumber(d5Weight, 0, Infinity, 'd5Weight');
  checkNumber(sharpnessWeight, 0, Infinity, 'sharpnessWeight');
  checkNumber(trebleDetail, 0, 1, 'trebleDetail');
  checkNumber(speed, 0, 100, 'speed');
  checkNumber(maxTimeMs, Number.MIN_VALUE, Infinity, 'maxTimeMs');
  checkNumber(maxIterations, 1, Number.MAX_SAFE_INTEGER, 'maxIterations');
  if (!Number.isSafeInteger(maxIterations)) {
    throw new RangeError('maxIterations must be a positive safe integer');
  }
  checkNumber(minStd, 0, Infinity, 'minStd');
  if (targetLoss !== undefined) checkNumber(targetLoss, 0, Infinity, 'targetLoss');
  if (!Number.isInteger(seed)) throw new RangeError('seed must be an integer');

  /** @type {number[]} */
  const lo = [];
  /** @type {number[]} */
  const hi = [];
  for (const [i, f] of grid.entries()) {
    if (f >= AUDIBLE_MIN_HZ && f <= AUDIBLE_MAX_HZ) (f < AVERAGE_ABOVE_HZ ? lo : hi).push(i);
  }
  const inRange = [...lo, ...hi];
  if (inRange.length < 2) throw new RangeError('grid needs at least 2 points in 20 Hz–20 kHz');
  const inRangeHz = inRange.map((i) => grid[i]);
  const raw =
    weights === 'iso226' ? perceptualWeights(inRangeHz, phon).weights : inRangeHz.map(() => 1);
  const total = raw.reduce((s, v) => s + v, 0);
  const w = new Float64Array(grid.length);
  inRange.forEach((i, k) => (w[i] = raw[k] / total));
  const correction = Float64Array.from(target, (v, i) => v - (measurement ? measurement[i] : 0));
  const soft = ranges === 'soft';
  const { regularization, pruneDb } = speedParameters(speed);
  /** @type {Context} */
  const ctx = {
    grid,
    n: grid.length,
    target: correction,
    logf: Float64Array.from(grid, (f) => Math.log2(f)),
    lo,
    hi,
    inRange,
    w,
    wHi: hi.reduce((s, i) => s + w[i], 0),
    levelMatch: levelMatch === true,
    trebleDetail,
    soft,
    allowHs: allowExperimental === true && layer === 'engenharia',
    maxBands,
    sharpness: sharpnessWeight,
    d5: d5Weight,
    regularization,
    pruneDb,
    terms: makeTerms(grid),
    feasible: sectionPredicate(soft),
  };
  /** @type {Budget} */
  const budget = {
    clock,
    deadline: started + maxTimeMs,
    maxIterations,
    iterations: 0,
    targetLoss,
    minStd,
  };

  let bands = initialize(ctx);
  /** @type {StopReason} */
  let stopReason = 'flat';
  if (bands.length > 0) {
    let state = evaluateState(ctx, bands);
    ({ state, stopReason } = optimize(ctx, state, budget));
    for (let round = 0; round < REFILL_ROUNDS && stopReason === 'converged'; round++) {
      const kept = state.bands.filter((b) => Math.abs(b.gainDb) >= pruneDb);
      const residual = residualOf(ctx, evaluateState(ctx, kept).fit);
      const added = kept.length < maxBands ? seedPeaking(ctx, residual, []) : null;
      if (added) kept.push(added);
      if (!added && kept.length === state.bands.length) break;
      ({ state, stopReason } = optimize(ctx, evaluateState(ctx, kept), budget));
    }
    bands = state.bands.filter((b) => Math.abs(b.gainDb) >= pruneDb);
  }

  const final = finalizeBands(bands, { experimental: ctx.allowHs, ranges });
  const active = /** @type {SolverBand[]} */ (final.bands.filter((b) => b.kind !== 'OFF'));
  const response = curveResponseDb({ bands: active }, grid);
  const diff = inRange.map((i) => response[i] - correction[i]);
  const mean = diff.reduce((s, v) => s + v, 0) / diff.length;
  const rmsDb = Math.sqrt(diff.reduce((s, v) => s + (v - mean) ** 2, 0) / diff.length);
  return {
    bands: final.bands,
    preampDb: final.preampDb,
    rmsDb,
    loss: Math.sqrt(evaluateState(ctx, active).f),
    iterations: budget.iterations,
    elapsedMs: clock.now() - started,
    stopReason,
    gate: final.gate,
  };
}

/**
 * C2: target curve drawn as points, interpolated on `grid` by a monotone cubic
 * (Fritsch–Carlson) spline in log-frequency, flat outside the points. The
 * result never overshoots: between two points it stays between their gains.
 * @param {readonly TargetPoint[]} points
 * @param {readonly number[]} [grid]
 * @returns {number[]}
 */
export function targetFromPoints(points, grid = GRID) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new RangeError('points must be a non-empty array');
  }
  checkGrid(grid);
  const sorted = points
    .map((p, i) => {
      if (
        p === null ||
        typeof p !== 'object' ||
        !(Number.isFinite(p.freqHz) && p.freqHz > 0 && Number.isFinite(p.gainDb))
      ) {
        throw new RangeError(`point ${i} needs a positive finite freqHz and a finite gainDb`);
      }
      return { x: Math.log10(p.freqHz), y: p.gainDb };
    })
    .sort((a, b) => a.x - b.x);
  const n = sorted.length;
  for (let k = 1; k < n; k++) {
    if (sorted[k].x === sorted[k - 1].x) throw new RangeError('points must have distinct freqHz');
  }
  const xs = sorted.map((p) => p.x);
  const ys = sorted.map((p) => p.y);
  const h = xs.slice(1).map((x, k) => x - xs[k]);
  const delta = h.map((hk, k) => (ys[k + 1] - ys[k]) / hk);
  const m = xs.map((_, k) => {
    if (k === 0) return delta[0] ?? 0;
    if (k === n - 1) return delta[n - 2];
    return delta[k - 1] * delta[k] > 0 ? (delta[k - 1] + delta[k]) / 2 : 0;
  });
  delta.forEach((d, k) => {
    if (d === 0) {
      m[k] = 0;
      m[k + 1] = 0;
      return;
    }
    // Fritsch–Carlson: (m_k/d)² + (m_k+1/d)² <= 9, written without dividing by d
    // (a subnormal secant would overflow the ratios).
    const norm = Math.hypot(m[k], m[k + 1]);
    if (norm > 3 * Math.abs(d)) {
      const t = (3 * Math.abs(d)) / norm;
      m[k] *= t;
      m[k + 1] *= t;
    }
  });
  return grid.map((freqHz) => {
    const x = Math.log10(freqHz);
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let k = 0;
    while (xs[k + 1] < x) k++;
    const t = (x - xs[k]) / h[k];
    const h00 = (1 + 2 * t) * (1 - t) ** 2;
    const h10 = t * (1 - t) ** 2;
    const h01 = t * t * (3 - 2 * t);
    const h11 = t * t * (t - 1);
    return h00 * ys[k] + h10 * h[k] * m[k] + h01 * ys[k + 1] + h11 * h[k] * m[k + 1];
  });
}
