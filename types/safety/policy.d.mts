/**
 * Whether `kind` may be used in `layer`. Unknown layers allow nothing.
 * @param {unknown} kind
 * @param {string} layer
 * @returns {boolean}
 */
export function isKindAllowed(kind: unknown, layer: string): boolean;
/**
 * Whether `kind` is experimental (HS, LP, HP).
 * @param {unknown} kind
 * @returns {boolean}
 */
export function isExperimentalKind(kind: unknown): boolean;
/**
 * Band rounded to the UI grid (gain 0.1 dB, frequency 1 Hz, Q 0.01). OFF and
 * non-object values are returned unchanged; missing keys stay missing.
 * @template {Band} T
 * @param {T} band
 * @returns {T}
 */
export function roundToGrid<T extends Band>(band: T): T;
/**
 * Band clamped to ABS_RANGES, D7 included: a PK/LS/HS boost has its Q clamped to
 * `boostQMax`, and a PK boost above `pkBoostMaxHz` has its frequency clamped to
 * `pkBoostMaxHz` (gain is kept). OFF and non-objects are returned unchanged.
 * Non-finite parameters are kept as is (the gate rejects them).
 * @template {Band} T
 * @param {T} band
 * @returns {T}
 */
export function clampToAbs<T extends Band>(band: T): T;
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
export function interpolateLinear<T>(from: T, to: T, t: number): T;
/**
 * Band interpolation recommended for dragging: gain linear, frequency and Q on a
 * log scale; other keys keep the value of `from`. Falls back to linear for
 * non-positive frequencies or Qs (which the gate rejects anyway).
 * @param {Band} from
 * @param {Band} to
 * @param {number} t
 * @returns {Band}
 */
export function interpolateBand(from: Band, to: Band, t: number): Band;
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
export function boundarySearch<T>(from: T, to: T, predicate: (state: T) => boolean, { iterations, interpolate }?: {
    iterations?: number;
    interpolate?: (from: T, to: T, t: number) => T;
}): T;
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
export function snapToGridAccepted<T extends Band>(value: T, from: T, predicate: (state: T) => boolean, { maxSteps }?: {
    maxSteps?: number;
}): T;
/**
 * Conservative single-section boxes (design/analysis/limites-v2.md §4), sampled
 * with automatic preamp and zero violations. Sampling is not an interval proof:
 * the gate stays mandatory.
 * @type {Readonly<Record<SoftRangeId, Readonly<SoftRange>>>}
 */
export const SOFT_RANGES: Readonly<Record<SoftRangeId, Readonly<SoftRange>>>;
/**
 * Absolute control ranges (any layer) and the D7 boost rules: a boost (gain > 0)
 * on PK/LS/HS needs Q <= `boostQMax`, and no PK may boost above `pkBoostMaxHz`.
 * @type {Readonly<AbsRanges>}
 */
export const ABS_RANGES: Readonly<AbsRanges>;
/** Kinds that exist only behind the `experimental` flag (engineering layer). */
export const EXPERIMENTAL_KINDS: readonly string[];
/**
 * Filter kinds offered by each UI layer. The engineering layer adds the
 * experimental kinds (see `isExperimentalKind`).
 * @type {Readonly<Record<Layer, readonly string[]>>}
 */
export const LAYER_KINDS: Readonly<Record<Layer, readonly string[]>>;
/** Rounding grid: gain 0.1 dB, frequency 1 Hz, Q 0.01. */
export const GRID_STEPS: Readonly<{
    gainDb: 0.1;
    freqHz: 1;
    qFactor: 0.01;
}>;
export type Band = import("../dsp/eq0xcb.mjs").Band;
export type Range = {
    readonly min: number;
    readonly max: number;
};
export type Layer = "ouvir" | "ajustar" | "engenharia";
export type SoftRangeId = "PK-main" | "PK-narrow" | "LS" | "HS-cut" | "HS-boost" | "LP" | "HP";
export type SoftRange = {
    kind: "PK" | "LS" | "HS" | "LP" | "HP";
    freqHz: Range;
    /**
     * absent for LP/HP (no gain)
     */
    gainDb?: Range | undefined;
    qFactor: Range;
};
export type AbsRanges = {
    freqHz: Range;
    gainDb: Range;
    qFactor: Range;
    /**
     * highest Q of a PK/LS/HS boost (D7)
     */
    boostQMax: number;
    /**
     * highest frequency of a PK boost (D7)
     */
    pkBoostMaxHz: number;
};
