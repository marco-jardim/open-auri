/**
 * Whether the YOLO profile waives `code` (class 2).
 * @param {unknown} code
 * @returns {boolean}
 */
export function isWaivable(code: unknown): boolean;
/**
 * The gate profile `options` asks for, read once and never coerced. Only an own
 * data property `profile` holding exactly the string `'yolo'` selects YOLO.
 * Anything else is the standard profile: another string (`'YOLO'`, `' yolo'`),
 * `true` or any other truthy value, a String object, an inherited property, a
 * property behind a getter (the getter is never called) and an options value
 * that is not an object or cannot be inspected. The property descriptor is read
 * with one `Object.getOwnPropertyDescriptor` (one trap on a Proxy); the engine
 * returns a fresh plain descriptor, so no caller getter, `valueOf`, `toString`
 * or `Symbol.toPrimitive` runs on the value.
 * @param {unknown} options
 * @returns {GateProfile}
 */
export function gateProfile(options: unknown): GateProfile;
/**
 * Pole radius of `1 + a1 z^-1 + a2 z^-2`.
 * @param {Section} s
 * @returns {number}
 */
export function poleRadius(s: Section): number;
/**
 * Exact (analytic) peaks of one section: `full` over DC–48 kHz and `audible`
 * over 20 Hz–20 kHz.
 * @param {Section} s
 * @returns {{full: Peak, audible: Peak}}
 */
export function sectionPeaks(s: Section): {
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
export function sectionAnalysis(band: Band): SectionAnalysis;
/**
 * Highest Q23-representable preamp (dB) satisfying d and e for a curve made of
 * this section and nine OFF, or `null` below the preamp floor. Port of the
 * reference `autoPreampForSection` (NaN metrics give `null`).
 * @param {{audiblePeak: Peak, fullPeak: Peak}} metrics
 * @returns {number | null}
 */
export function autoPreampForSection(metrics: {
    audiblePeak: Peak;
    fullPeak: Peak;
}): number | null;
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
 * A copy that fails is `f:codec`: the gate's own refusals keep their message
 * (`bands must be an array`, `expected 10 bands`, `band <i>: missing (hole in a
 * sparse array)`, `band <i>: not an object`), and a value thrown by a getter or
 * trap is never inspected (fixed text). A codec refusal of the copy keeps the
 * codec's message.
 *
 * `options.profile` is read first, by {@link gateProfile} (only an own data
 * property equal to `'yolo'` selects YOLO); see the header for the classes.
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {GateOptions} [options]
 * @returns {GateResult}
 */
export function gate(bands: readonly Band[], preampDb: number, options?: GateOptions): GateResult;
/**
 * The gate transport and server MUST call before writing or publishing: always
 * the `full` grid, whatever `options.grid` says. `profile` is passed through
 * as {@link gateProfile} reads it (a getter or any value other than `'yolo'` is
 * the standard profile); the server never passes it.
 * @param {readonly Band[]} bands
 * @param {number} preampDb
 * @param {GateOptions} [options]
 * @returns {GateResult}
 */
export function gateForWrite(bands: readonly Band[], preampDb: number, options?: GateOptions): GateResult;
/**
 * Highest preamp on the 0.1 dB UI grid within [preampMinDb, preampMaxDb] for
 * which `gateForWrite` accepts the curve, or `null` when none does (including
 * curves failing checks a preamp cannot fix: kinds, D7, codec, a, b, c).
 *
 * In the YOLO profile (`options.profile`, read like {@link gateProfile}) the
 * range is [{@link CODEC_PREAMP_FLOOR_DB}, {@link YOLO_PREAMP_MAX_DB}] instead
 * (`g:preamp` is waived), `d:prefix-peak-full`, `d:prefix-peak-extended` and
 * `e:output-extended` are fixable too, and only class-1 reasons count (class 2
 * is waived).
 *
 * `storable: true` (an own data property holding exactly `true`, read like
 * `profile`: a getter is never called) asks for a preamp a stored curve may
 * keep: in YOLO the lower bound is then {@link YOLO_STORAGE_PREAMP_FLOOR_DB}
 * (−25.5 dB, S1's floor), so the range is [−25.5, 0] dB and a curve that needs
 * more attenuation gets `null`. Use it for every curve that is saved, shared or
 * published. It changes nothing in the standard profile, whose floor is already
 * −25.5 dB.
 *
 * A candidate is derived analytically from the metrics at the top preamp,
 * rounded down to the grid, then verified with the gate and stepped down by
 * 0.1 dB while refused (the verdict is monotone in the preamp). The bands are
 * read once: every later verification runs on the first verdict's snapshot.
 *
 * In YOLO the YOLO-only checks apply only to a verdict that relies on a waiver
 * (see the header). For bands that need one (k, d7, a:b*, c) that holds at
 * every preamp and the verdict stays monotone. For bands that need none, only
 * `g:preamp` can be waived: the YOLO-only checks apply above −0.5 dB and below
 * −25.5 dB, and inside [−25.5, −0.5] dB the verdict is the standard one. The
 * verdict is then monotone within each of those three ranges but not across
 * −25.5 dB (a preamp accepted at −25.5 dB may be refused at −25.6 dB). The rule:
 * the ranges are searched top-down, each from its own analytic cap (the
 * standard limits inside the range, the YOLO-only ones too outside it), and
 * the first accepted preamp is returned. It is the highest grid preamp the
 * YOLO gate accepts, so it is never below the standard profile's result.
 * @param {readonly Band[]} bands
 * @param {{experimental?: boolean, profile?: GateProfile, storable?: boolean}} [options]
 * @returns {number | null}
 */
export function autoPreamp(bands: readonly Band[], options?: {
    experimental?: boolean;
    profile?: GateProfile;
    storable?: boolean;
}): number | null;
/**
 * @typedef {import('../dsp/eq0xcb.mjs').Band} Band
 * @typedef {import('../dsp/eq0xcb.mjs').Section} Section
 * @typedef {import('./thresholds.mjs').Thresholds} Thresholds
 * @typedef {'drag' | 'full'} Grid
 * @typedef {'standard' | 'yolo'} GateProfile
 * @typedef {'a:b0' | 'a:b2' | 'a:-a1' | 'a:b1' | 'a:-a2' | 'b:pole-radius' | 'c:section-peak'
 *   | 'd:prefix-peak' | 'd:prefix-peak-full' | 'd:prefix-peak-extended' | 'e:output-audible'
 *   | 'e:output-extended' | 'e:output-full' | 'f:codec' | 'g:preamp' | 'k:kind-not-allowed'
 *   | 'd7:pk-boost-above-16k' | 'd7:boost-q' | 'd7:boost-above-20k'} ReasonCode
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
 *   prefixFull?: PrefixPeak[],
 *   internalFull?: PrefixPeak,
 *   prefixExtended?: PrefixPeak[],
 *   internalExtended?: PrefixPeak,
 *   outputExtended?: PrefixPeak,
 * }} GateMetrics
 * `prefixFull` and `internalFull` (DC–48 kHz prefix peaks), and
 * `prefixExtended`, `internalExtended` and `outputExtended` (20 Hz–48 kHz, the
 * extended checks), exist in YOLO results that rely on a waiver only (a
 * non-empty `waived`): the metrics of every other result are the standard ones.
 * @typedef {{
 *   ok: boolean,
 *   reasons: Reason[],
 *   waived?: ReasonCode[],
 *   waivedReasons?: Reason[],
 *   profile?: 'yolo',
 *   metrics: GateMetrics,
 * }} GateResult
 * `reasons` are the blocking reasons (all of them in the standard profile).
 * YOLO results only: `profile: 'yolo'`, `waived` lists, once each in order of
 * first appearance, the codes the YOLO profile waived, and `waivedReasons` the
 * waived reasons themselves. A standard result has none of these keys.
 * @typedef {{experimental?: boolean, grid?: Grid, profile?: GateProfile}} GateOptions
 */
/**
 * Reason codes the YOLO profile waives (class 2): engineering and similarity
 * limits of the editor, not limits of the chip's arithmetic. Every other code,
 * present or future, blocks in every profile.
 * @type {readonly ReasonCode[]}
 */
export const YOLO_WAIVABLE: readonly ReasonCode[];
/**
 * Reason codes that block in every profile (class 1), in reason order. Listed
 * for callers and tests; the gate itself blocks on anything not in
 * {@link YOLO_WAIVABLE}. `d:prefix-peak-full`, `d:prefix-peak-extended` and
 * `e:output-extended` are computed in the YOLO profile only, when the verdict
 * relies on a waiver.
 * @type {readonly ReasonCode[]}
 */
export const HARD_REASONS: readonly ReasonCode[];
/**
 * Log intervals of the multi-section scans per grid mode (`full` = reference).
 *
 * Both modes scan the grid, refine every interior local maximum by
 * golden-section search (as the reference), and also always refine the first
 * and the last interval. The reference does not refine those two, so a peak
 * lying between a domain edge (DC, 20 Hz, 20 kHz, 48 kHz) and the nearest grid
 * point was reported at the edge value; here it is found. This makes the gate
 * stricter than the reference, never laxer. Measured (test/safety/gate.test.mjs):
 * at most 4.4e-15 dB above the reference on the parity corpus (presets, reversed
 * and sorted, analytic single sections), and 3.06e-6 dB on a resonant LP built
 * to peak inside the last full-grid interval.
 *
 * `drag` is advisory only. Since the edge intervals are refined in both modes,
 * drag can no longer miss a peak next to a domain edge; interior peaks between
 * grid points are refined too, so drag and full differ only by the density of
 * the grid that brackets each peak before refinement. What remains: two
 * features sharing one coarse interval can still leave drag bracketing (and
 * refining) only one of them, so drag may be slightly laxer. On the sampled
 * corpus (11 presets in 3 orders, the counterexample and 200 random curves,
 * seed 20261016) the largest observed |full − drag| is 2.9e-14 dB, with the
 * same verdicts. Writes must use `gateForWrite`.
 */
export const GRID_INTERVALS: Readonly<{
    drag: 2048;
    full: 16384;
}>;
/**
 * Lowest preamp on the 0.1 dB grid whose Q23 word is not zero: the codec floor,
 * the YOLO profile's only lower bound (g:preamp is waived there). About
 * −144.4 dB, where the preamp is practically silence.
 */
export const CODEC_PREAMP_FLOOR_DB: number;
/**
 * Lowest preamp of a curve that is stored, published or classified, in every
 * profile, YOLO included: −25.5 dB (`THRESHOLDS.preampMinDb`), the floor S1 and
 * S5 encode and the editor keeps in YOLO. The YOLO gate itself waives
 * `g:preamp` down to {@link CODEC_PREAMP_FLOOR_DB}; `autoPreamp` stops here
 * with `storable: true`, and `classifyCurve` refuses a curve below it.
 */
export const YOLO_STORAGE_PREAMP_FLOOR_DB: number;
/**
 * Highest preamp the YOLO profile searches from: 0 dB, the codec ceiling (a
 * positive preamp does not encode) and the editor's YOLO maximum. `g:preamp`
 * is waived there, so only the hard limits (class 1) bound the preamp.
 */
export const YOLO_PREAMP_MAX_DB: 0;
export type Band = import("../dsp/eq0xcb.mjs").Band;
export type Section = import("../dsp/eq0xcb.mjs").Section;
export type Thresholds = import("./thresholds.mjs").Thresholds;
export type Grid = "drag" | "full";
export type GateProfile = "standard" | "yolo";
export type ReasonCode = "a:b0" | "a:b2" | "a:-a1" | "a:b1" | "a:-a2" | "b:pole-radius" | "c:section-peak" | "d:prefix-peak" | "d:prefix-peak-full" | "d:prefix-peak-extended" | "e:output-audible" | "e:output-extended" | "e:output-full" | "f:codec" | "g:preamp" | "k:kind-not-allowed" | "d7:pk-boost-above-16k" | "d7:boost-q" | "d7:boost-above-20k";
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
/**
 * `prefixFull` and `internalFull` (DC–48 kHz prefix peaks), and
 * `prefixExtended`, `internalExtended` and `outputExtended` (20 Hz–48 kHz, the
 * extended checks), exist in YOLO results that rely on a waiver only (a
 * non-empty `waived`): the metrics of every other result are the standard ones.
 */
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
    prefixFull?: PrefixPeak[];
    internalFull?: PrefixPeak;
    prefixExtended?: PrefixPeak[];
    internalExtended?: PrefixPeak;
    outputExtended?: PrefixPeak;
};
/**
 * `reasons` are the blocking reasons (all of them in the standard profile).
 * YOLO results only: `profile: 'yolo'`, `waived` lists, once each in order of
 * first appearance, the codes the YOLO profile waived, and `waivedReasons` the
 * waived reasons themselves. A standard result has none of these keys.
 */
export type GateResult = {
    ok: boolean;
    reasons: Reason[];
    waived?: ReasonCode[];
    waivedReasons?: Reason[];
    profile?: "yolo";
    metrics: GateMetrics;
};
export type GateOptions = {
    experimental?: boolean;
    grid?: Grid;
    profile?: GateProfile;
};
export type ScanGrid = {
    fs: readonly number[];
    re: Float64Array;
    im: Float64Array;
    u2re: Float64Array;
    u2im: Float64Array;
};
export { levelDb, MEAN_FREQUENCIES, sectionDb } from "../dsp/level.mjs";
export { THRESHOLDS, PROVENANCE, YOLO_THRESHOLDS } from "./thresholds.mjs";
