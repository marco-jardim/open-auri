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
export type Band = import('../dsp/eq0xcb.mjs').Band;
export type Range = import('../safety/policy.mjs').Range;
export type Reason = import('../safety/gate.mjs').Reason;
export type SolverKind = 'PK' | 'LS' | 'HS';
export type SolverBand = {
    kind: SolverKind;
    freqHz: number;
    gainDb: number;
    qFactor: number;
};
export type TargetPoint = {
    freqHz: number;
    gainDb: number;
};
export type WeightMode = 'iso226' | 'flat';
export type RangeMode = 'abs' | 'soft';
export type StopReason = 'flat' | 'converged' | 'targetLoss' | 'time' | 'iterations';
export type Clock = {
    now: () => number;
};
export type Box = {
    fMin: number;
    fMax: number;
    qMin: number;
    qMax: number;
    gMin: number;
    gMax: number;
};
export type SolveOptions = {
    /**
     * desired correction in dB on `grid`; with
     * `measurement`, the target curve (the correction is target - measurement)
     */
    target: readonly number[];
    /**
     * strictly increasing frequencies (default GRID)
     */
    grid?: readonly number[];
    /**
     * measured response in dB on `grid`
     */
    measurement?: readonly number[];
    /**
     * sections the solver may use, 0–10 (default 10)
     */
    maxBands?: number;
    /**
     * with layer 'engenharia', allows HS
     */
    allowExperimental?: boolean;
    /**
     * UI layer (default 'ajustar')
     */
    layer?: import('../safety/policy.mjs').Layer;
    /**
     * D4 weighting (default 'iso226')
     */
    weights?: WeightMode;
    /**
     * loudness of the ISO 226 weights (default 60)
     */
    phon?: number;
    /**
     * parameter boxes (default 'abs')
     */
    ranges?: RangeMode;
    /**
     * D5 weight, dB² per dB² (default 0.005)
     */
    d5Weight?: number;
    /**
     * AutoEq sharpness penalty weight (default 1)
     */
    sharpnessWeight?: number;
    /**
     * weight 0–1 of the deviation from the >= 10 kHz mean
     * (0 = AutoEq's treble averaging, 1 = plain error; default 0.5)
     */
    trebleDetail?: number;
    /**
     * correction speed 0–100 (default 50)
     */
    speed?: number;
    /**
     * remove the weighted mean error (default true)
     */
    levelMatch?: boolean;
    /**
     * best-effort optimization time budget (default 1200),
     * only effective when `clock` advances during synchronous execution
     */
    maxTimeMs?: number;
    /**
     * nondecreasing finite milliseconds from now(); defaults to
     * performance.now() when available, otherwise Date.now()
     */
    clock?: Clock;
    /**
     * primary LM trial bound, a positive safe integer
     * shared across re-seeding rounds (default 400)
     */
    maxIterations?: number;
    /**
     * std of the last 8 accepted losses to stop (default 0.002)
     */
    minStd?: number;
    /**
     * stop when the loss is at or below this value
     */
    targetLoss?: number;
    /**
     * integer, reserved (the solver uses no randomness)
     */
    seed?: number;
};
export type SolveResult = {
    /**
     * exactly 10 sections (PK/LS/OFF; HS only if allowed)
     */
    bands: Band[];
    /**
     * automatic preamp (`autoPreamp`)
     */
    preampDb: number;
    /**
     * level-matched unweighted RMS of fit - correction, 20 Hz–20 kHz
     */
    rmsDb: number;
    /**
     * sqrt of the objective at the returned bands
     */
    loss: number;
    /**
     * LM trials
     */
    iterations: number;
    /**
     * whole-solve duration measured by `clock`
     */
    elapsedMs: number;
    stopReason: StopReason;
    /**
     * `gateForWrite` verdict of the result
     */
    gate: {
        ok: true;
        reasons: Reason[];
    };
};
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
export declare const SOLVER_DEFAULTS: Readonly<{
    maxBands: 10;
    weights: WeightMode;
    phon: 60;
    ranges: RangeMode;
    d5Weight: 0.005;
    sharpnessWeight: 1;
    trebleDetail: 0.5;
    speed: 50;
    maxTimeMs: 1200;
    maxIterations: 400;
    minStd: 0.002;
}>;
/**
 * Regularization derived from the correction speed (0–100): `regularization` is
 * the weight λ of Σ (gain/10 dB)² in the objective, `pruneDb` the smallest
 * |gain| a section may keep.
 * @param {number} speed
 * @returns {{regularization: number, pruneDb: number}}
 */
export declare function speedParameters(speed: number): {
    regularization: number;
    pruneDb: number;
};
/**
 * Parameter box of a section of `kind` (with its current Q and gain, which select
 * the sub-range): ABS_RANGES or SOFT_RANGES, D7 included.
 * @param {SolverKind} kind
 * @param {boolean} soft
 * @param {number} qFactor
 * @param {number} gainDb
 * @returns {Box}
 */
export declare function parameterBox(kind: SolverKind, soft: boolean, qFactor: number, gainDb: number): Box;
/**
 * Sharpness coefficient of a peaking section (AutoEq): ~0 below the gain limit
 * of its Q, ~1 above.
 * @param {number} gainDb
 * @param {number} qFactor
 */
export declare function sharpnessCoefficient(gainDb: number, qFactor: number): number;
/**
 * D5 opposition score Σ (1 - d)² |g_a g_b| (dB²) over sections adjacent in
 * frequency with opposite-sign gains whose centres are d < 1 octave apart.
 * OFF and gainless sections are ignored.
 * @param {readonly Band[]} bands
 */
export declare function oppositeNeighbourScore(bands: readonly Band[]): number;
export type Terms = {
    uRe: Float64Array;
    uIm: Float64Array;
    u2Re: Float64Array;
    u2Im: Float64Array;
};
export type Context = {
    grid: readonly number[];
    n: number;
    target: Float64Array;
    /**
     * log2 of the grid
     */
    logf: Float64Array;
    /**
     * indices with 20 Hz <= f < 10 kHz
     */
    lo: number[];
    /**
     * indices with 10 kHz <= f <= 20 kHz
     */
    hi: number[];
    /**
     * lo then hi (contiguous, ascending)
     */
    inRange: number[];
    /**
     * normalized weights (sum 1 over inRange, 0 elsewhere)
     */
    w: Float64Array;
    /**
     * sum of the weights over hi
     */
    wHi: number;
    levelMatch: boolean;
    soft: boolean;
    allowHs: boolean;
    maxBands: number;
    trebleDetail: number;
    sharpness: number;
    d5: number;
    regularization: number;
    pruneDb: number;
    terms: Terms;
    feasible: (band: SolverBand) => boolean;
};
export type State = {
    bands: readonly SolverBand[];
    resp: Float64Array[];
    rms: Float64Array;
    fit: Float64Array;
    rows: Float64Array;
    /**
     * objective (loss²)
     */
    f: number;
};
export type Budget = {
    clock: Clock;
    deadline: number;
    maxIterations: number;
    iterations: number;
    targetLoss: number | undefined;
    minStd: number;
};
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
export declare function finalizeBands(bands: readonly Band[], { experimental, ranges }?: {
    experimental?: boolean;
    ranges?: RangeMode;
}): {
    bands: Band[];
    preampDb: number;
    gate: {
        ok: true;
        reasons: Reason[];
    };
};
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
export declare function solvePeq(options: SolveOptions): SolveResult;
/**
 * C2: target curve drawn as points, interpolated on `grid` by a monotone cubic
 * (Fritsch–Carlson) spline in log-frequency, flat outside the points. The
 * result never overshoots: between two points it stays between their gains.
 * @param {readonly TargetPoint[]} points
 * @param {readonly number[]} [grid]
 * @returns {number[]}
 */
export declare function targetFromPoints(points: readonly TargetPoint[], grid?: readonly number[]): number[];
