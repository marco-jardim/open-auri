export { levelDb, MEAN_FREQUENCIES, sectionDb } from '../dsp/level.mjs';
export { THRESHOLDS, PROVENANCE } from './thresholds.mjs';
export type Band = import('../dsp/eq0xcb.mjs').Band;
export type Section = import('../dsp/eq0xcb.mjs').Section;
export type Thresholds = import('./thresholds.mjs').Thresholds;
export type Grid = 'drag' | 'full';
export type ReasonCode = 'a:b0' | 'a:b2' | 'a:-a1' | 'a:b1' | 'a:-a2' | 'b:pole-radius' | 'c:section-peak' | 'd:prefix-peak' | 'e:output-audible' | 'e:output-full' | 'f:codec' | 'g:preamp' | 'k:kind-not-allowed' | 'd7:pk-boost-above-16k' | 'd7:boost-q';
export type Reason = {
    code: ReasonCode;
    stage?: number;
    value?: unknown;
    limit?: number;
};
export type Peak = {
    db: number;
    frequencyHz: number;
};
export type PrefixPeak = {
    stage: number;
    db: number;
    frequencyHz: number | null;
};
export type SectionAnalysis = {
    words: number[];
    section: Section;
    poleRadius: number;
    fullPeak: Peak;
    audiblePeak: Peak;
    reasons: Reason[];
};
export type GateMetrics = {
    thresholds: Readonly<Thresholds>;
    grid: Grid;
    payloadCrc?: string;
    payload?: Uint8Array;
    bands?: readonly Readonly<Band>[];
    preampDb?: number;
    quantizedPreampDb?: number;
    sections?: SectionAnalysis[];
    prefixAudible?: PrefixPeak[];
    internalAudible?: PrefixPeak;
    outputAudible?: PrefixPeak;
    outputFull?: Peak;
};
export type GateResult = {
    ok: boolean;
    reasons: Reason[];
    metrics: GateMetrics;
};
export type GateOptions = {
    experimental?: boolean;
    grid?: Grid;
};
/**
 * @typedef {import('../dsp/eq0xcb.mjs').Band} Band
 * @typedef {import('../dsp/eq0xcb.mjs').Section} Section
 * @typedef {import('./thresholds.mjs').Thresholds} Thresholds
 * @typedef {'drag' | 'full'} Grid
 * @typedef {'a:b0' | 'a:b2' | 'a:-a1' | 'a:b1' | 'a:-a2' | 'b:pole-radius' | 'c:section-peak'
 *   | 'd:prefix-peak' | 'e:output-audible' | 'e:output-full' | 'f:codec' | 'g:preamp'
 *   | 'k:kind-not-allowed' | 'd7:pk-boost-above-16k' | 'd7:boost-q'} ReasonCode
 * @typedef {{code: ReasonCode, stage?: number, value?: unknown, limit?: number}} Reason
 * @typedef {{db: number, frequencyHz: number}} Peak
 * @typedef {{stage: number, db: number, frequencyHz: number | null}} PrefixPeak
 * @typedef {{
 *   words: number[],
 *   section: Section,
 *   poleRadius: number,
 *   fullPeak: Peak,
 *   audiblePeak: Peak,
 *   reasons: Reason[],
 * }} SectionAnalysis
 * @typedef {{
 *   thresholds: Readonly<Thresholds>,
 *   grid: Grid,
 *   payloadCrc?: string,
 *   payload?: Uint8Array,
 *   bands?: readonly Readonly<Band>[],
 *   preampDb?: number,
 *   quantizedPreampDb?: number,
 *   sections?: SectionAnalysis[],
 *   prefixAudible?: PrefixPeak[],
 *   internalAudible?: PrefixPeak,
 *   outputAudible?: PrefixPeak,
 *   outputFull?: Peak,
 * }} GateMetrics
 * @typedef {{ok: boolean, reasons: Reason[], metrics: GateMetrics}} GateResult
 * @typedef {{experimental?: boolean, grid?: Grid}} GateOptions
 */
/**
 * Log intervals of the multi-section scans per grid mode (`full` = reference).
 *
 * Both modes scan the grid, refine every interior local maximum by
 * golden-section search (as the reference), and also always refine the first
 * and the last interval. The reference does not refine those two, so a peak
 * lying between a domain edge (DC, 20 Hz, 20 kHz, 48 kHz) and the nearest grid
 * point was reported at the edge value; here it is found. This makes the gate
 * stricter than the reference (never laxer), by at most ~1e-4 dB in practice;
 * test/safety/gate.test.mjs records the deltas on the parity corpus and builds
 * a resonant-LP curve where the difference shows.
 *
 * `drag` is advisory only: it matches `full` to ~1e-12 dB wherever a peak is
 * bracketed by the coarse grid, but it can still be laxer where two features
 * share one coarse interval. Writes must use `gateForWrite`.
 */
export declare const GRID_INTERVALS: Readonly<{
    drag: 2048;
    full: 16384;
}>;
/**
 * Pole radius of `1 + a1 z^-1 + a2 z^-2`.
 * @param {Section} s
 * @returns {number}
 */
export declare function poleRadius(s: Section): number;
/**
 * Exact (analytic) peaks of one section: `full` over DC–48 kHz and `audible`
 * over 20 Hz–20 kHz.
 * @param {Section} s
 * @returns {{full: Peak, audible: Peak}}
 */
export declare function sectionPeaks(s: Section): {
    full: Peak;
    audible: Peak;
};
/**
 * Per-section checks (a, b, c) on the quantized section of `band`, with its
 * analytic peaks. Port of the reference `analyseSection`; reasons carry
 * `value` and `limit` (limits without tolerance). Throws like the codec on
 * bands it cannot encode.
 * @param {Band} band
 * @returns {SectionAnalysis}
 */
export declare function sectionAnalysis(band: Band): SectionAnalysis;
/**
 * Highest Q23-representable preamp (dB) satisfying d and e for a curve made of
 * this section and nine OFF, or `null` below the preamp floor. Port of the
 * reference `autoPreampForSection` (NaN metrics give `null`).
 * @param {{audiblePeak: Peak, fullPeak: Peak}} metrics
 * @returns {number | null}
 */
export declare function autoPreampForSection(metrics: {
    audiblePeak: Peak;
    fullPeak: Peak;
}): number | null;
export type ScanGrid = {
    fs: readonly number[];
    re: Float64Array;
    im: Float64Array;
    u2re: Float64Array;
    u2im: Float64Array;
};
/**
 * Gate v2 verdict for `bands` (wire order) and `preampDb`.
 *
 * `grid: 'drag'` scans multi-section responses on 2048 log intervals (same
 * refinement) for interactive feedback; `'full'` (default) uses the reference
 * 16384. Single sections always use the analytic peak. Only `full` decides a
 * write: call `gateForWrite`. HS/LP/HP need `experimental: true`.
 *
 * The bands are copied once on entry (`snapshotBands`: one read per field) and
 * only that copy is evaluated. When the codec accepts it, `metrics.bands` is the
 * frozen copy and `metrics.payload` a copy of the exact 220 payload bytes, so
 * callers send what was gated. Never throws because of `bands` (anything that
 * cannot be copied or encoded is `f:codec`); only an invalid `grid` throws.
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {GateOptions} [options]
 * @returns {GateResult}
 */
export declare function gate(bands: readonly Band[], preampDb: number, { experimental, grid }?: GateOptions): GateResult;
/**
 * The gate transport and server MUST call before writing or publishing: always
 * the `full` grid, whatever `options.grid` says.
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {GateOptions} [options]
 * @returns {GateResult}
 */
export declare function gateForWrite(bands: readonly Band[], preampDb: number, options?: GateOptions): GateResult;
/**
 * Highest preamp on the 0.1 dB UI grid within [preampMinDb, preampMaxDb] for
 * which `gateForWrite` accepts the curve, or `null` when none does (including
 * curves failing checks a preamp cannot fix: kinds, D7, codec, a, b, c).
 *
 * A candidate is derived analytically from the metrics at the top preamp,
 * rounded down to the grid, then verified with the gate and stepped down by
 * 0.1 dB while refused (the verdict is monotone in the preamp). The bands are
 * read once: every later verification runs on the first verdict's snapshot.
 * @param {readonly Band[]} bands
 * @param {{experimental?: boolean}} [options]
 * @returns {number | null}
 */
export declare function autoPreamp(bands: readonly Band[], { experimental }?: {
    experimental?: boolean;
}): number | null;
