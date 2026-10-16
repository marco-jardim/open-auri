/**
 * Regularization derived from the correction speed (0–100): `regularization` is
 * the weight λ of Σ (gain/10 dB)² in the objective, `pruneDb` the smallest
 * |gain| a section may keep.
 * @param {number} speed
 * @returns {{regularization: number, pruneDb: number}}
 */
export function speedParameters(speed: number): {
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
export function parameterBox(kind: SolverKind, soft: boolean, qFactor: number, gainDb: number): Box;
/**
 * Sharpness coefficient of a peaking section (AutoEq): ~0 below the gain limit
 * of its Q, ~1 above.
 * @param {number} gainDb
 * @param {number} qFactor
 */
export function sharpnessCoefficient(gainDb: number, qFactor: number): number;
/**
 * D5 opposition score Σ (1 - d)² |g_a g_b| (dB²) over sections adjacent in
 * frequency with opposite-sign gains whose centres are d < 1 octave apart.
 * OFF and gainless sections are ignored.
 * @param {readonly Band[]} bands
 */
export function oppositeNeighbourScore(bands: readonly Band[]): number;
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
export function finalizeBands(bands: readonly Band[], { experimental, ranges }?: {
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
export function solvePeq(options: SolveOptions): SolveResult;
/**
 * C2: target curve drawn as points, interpolated on `grid` by a monotone cubic
 * (Fritsch–Carlson) spline in log-frequency, flat outside the points. The
 * result never overshoots: between two points it stays between their gains.
 * @param {readonly TargetPoint[]} points
 * @param {readonly number[]} [grid]
 * @returns {number[]}
 */
export function targetFromPoints(points: readonly TargetPoint[], grid?: readonly number[]): number[];
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
export const SOLVER_DEFAULTS: Readonly<{
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
export type Band = import("../dsp/eq0xcb.mjs").Band;
export type Range = import("../safety/policy.mjs").Range;
export type Reason = import("../safety/gate.mjs").Reason;
export type SolverKind = "PK" | "LS" | "HS";
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
export type WeightMode = "iso226" | "flat";
export type RangeMode = "abs" | "soft";
export type StopReason = "flat" | "converged" | "targetLoss" | "time" | "iterations";
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
    grid?: readonly number[] | undefined;
    /**
     * measured response in dB on `grid`
     */
    measurement?: readonly number[] | undefined;
    /**
     * sections the solver may use, 0–10 (default 10)
     */
    maxBands?: number | undefined;
    /**
     * with layer 'engenharia', allows HS
     */
    allowExperimental?: boolean | undefined;
    /**
     * UI layer (default 'ajustar')
     */
    layer?: import("../safety/policy.mjs").Layer | undefined;
    /**
     * D4 weighting (default 'iso226')
     */
    weights?: WeightMode | undefined;
    /**
     * loudness of the ISO 226 weights (default 60)
     */
    phon?: number | undefined;
    /**
     * parameter boxes (default 'abs')
     */
    ranges?: RangeMode | undefined;
    /**
     * D5 weight, dB² per dB² (default 0.005)
     */
    d5Weight?: number | undefined;
    /**
     * AutoEq sharpness penalty weight (default 1)
     */
    sharpnessWeight?: number | undefined;
    /**
     * weight 0–1 of the deviation from the >= 10 kHz mean
     * (0 = AutoEq's treble averaging, 1 = plain error; default 0.5)
     */
    trebleDetail?: number | undefined;
    /**
     * correction speed 0–100 (default 50)
     */
    speed?: number | undefined;
    /**
     * remove the weighted mean error (default true)
     */
    levelMatch?: boolean | undefined;
    /**
     * best-effort optimization time budget (default 1200),
     * only effective when `clock` advances during synchronous execution
     */
    maxTimeMs?: number | undefined;
    /**
     * nondecreasing finite milliseconds from now(); defaults to
     * performance.now() when available, otherwise Date.now()
     */
    clock?: Clock | undefined;
    /**
     * primary LM trial bound, a positive safe integer
     * shared across re-seeding rounds (default 400)
     */
    maxIterations?: number | undefined;
    /**
     * std of the last 8 accepted losses to stop (default 0.002)
     */
    minStd?: number | undefined;
    /**
     * stop when the loss is at or below this value
     */
    targetLoss?: number | undefined;
    /**
     * integer, reserved (the solver uses no randomness)
     */
    seed?: number | undefined;
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
