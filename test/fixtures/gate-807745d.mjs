// Frozen copy of src/safety/gate.mjs at 807745d (before filters above 20 kHz), used by the standard-verdict parity test. Only the import paths differ.
// Gate v2 ("observed envelope"): the safety check every curve must pass, on the
// real Q27/Q23 values that go on the wire, before it is written or published.
//
// IMPORTANT: this is a similarity policy with what the 11 official presets
// already make the chip compute (design/analysis/limites-v2.md), NOT a hardware
// safety proof. Marginal coefficient maxima, pole radius and sinusoidal peaks do
// not bound internal states, impulse-response norms, limit cycles, transients
// or unknown firmware arithmetic.
//
// Port of design/analysis/gate.mjs with the same math and the same order of
// summations: in `full` mode the metrics are bit-identical to the reference,
// with one deliberate exception (see GRID_INTERVALS): the first and last scan
// intervals are also refined, so a scan peak can only be higher (stricter) than
// the reference's, never lower. Two implementation details do not change any
// value: the per-frequency trigonometric terms of the scan grids are computed
// once, and prefix sums are accumulated incrementally (prefix k adds sections in
// the same order, starting from 0, as the reference's per-prefix reduce does).
//
// One read per field: gate() copies the bands once on entry (copyBands(): the
// reads of snapshotBands(), which then freezes the values read) and evaluates
// only that frozen copy (policy, codec, analysis). The copy
// and the exact payload bytes are returned in `metrics.bands` and
// `metrics.payload`, so a transport can send exactly what was gated.
//
// Reason order (deterministic):
//   0. `f:codec` alone when the bands cannot even be copied (not an array, not
//      10 elements, a hole, a non-object element, a throwing getter/trap);
//   1. `k:kind-not-allowed`, per stage in stage order;
//   2. `d7:pk-boost-above-16k` then `d7:boost-q`, per stage in stage order;
//   3. `f:codec` (if the codec refuses the curve, evaluation stops here);
//   4. `g:preamp`;
//   5. per stage, in stage order: `a:<position>` in wire order (b0, b2, -a1,
//      b1, -a2), then `b:pole-radius`, then `c:section-peak`;
//   6. `d:prefix-peak`, `d:prefix-peak-full` (YOLO profile only),
//      `e:output-audible`, `e:output-full`.
// Every comparison is written so that NaN fails (`!(x <= limit)`).
//
// UI control ranges are NOT enforced here (that is src/safety/policy.mjs),
// except the D7 boost rules and the filter kinds, which are part of the contract.
//
// Profiles (`options.profile`). The standard profile (the default, and what the
// server always uses) blocks on every reason above. The YOLO profile, selected
// only by an own data property holding exactly the string 'yolo' (see
// gateProfile), sorts the reasons in two classes:
//   - class 1, hard, blocking in every profile: `f:codec` (known kind, finite
//     values, 0 < f < 48 kHz, Q > 0, int32 Q27 words, quantized poles strictly
//     inside the unit circle, finite preamp <= 0), `a:-a1` and `a:-a2` (the
//     feedback words, i.e. the pole positions), `b:pole-radius`,
//     `d:prefix-peak`, `e:output-audible`, `e:output-full`, plus the YOLO-only
//     `d:prefix-peak-full` (every prefix, preamp included, over DC–48 kHz, at
//     most the presets' largest: it bounds the out-of-band energy that
//     `c:section-peak` bounded);
//   - class 2, waived (YOLO_WAIVABLE): `k:kind-not-allowed`, `d7:*`,
//     `g:preamp`, `a:b0`, `a:b2`, `a:b1` (feedforward words) and
//     `c:section-peak`.
// The classification is an allowlist of waivable codes: any other code blocks.
// In YOLO, waived reasons leave `reasons` for `waived` (codes) and
// `waivedReasons` (objects), the result carries `profile: 'yolo'`, and `ok`
// depends on the blocking reasons only. A standard result keeps exactly its
// former shape `{ok, reasons, metrics}` (no `waived` key: read a missing one as
// empty), so standard verdicts, metrics and reasons are bit-identical to a gate
// without profiles.
//
// Pure ESM: no DOM, no Node-only APIs.

import {
  BAND_COUNT,
  designSection,
  encodePayload,
  encodeSection,
  SAMPLE_RATE,
  snapshotBands,
} from '../../src/dsp/eq0xcb.mjs';
import {
  fromWords,
  isIdentitySection,
  quantizedPreampDb,
  sectionDb,
  sectionDbFromTerms,
} from '../../src/dsp/level.mjs';
import { ABS_RANGES, isKindAllowed } from '../../src/safety/policy.mjs';
import { THRESHOLDS, YOLO_THRESHOLDS } from '../../src/safety/thresholds.mjs';

export { levelDb, MEAN_FREQUENCIES, sectionDb } from '../../src/dsp/level.mjs';
export { THRESHOLDS, PROVENANCE, YOLO_THRESHOLDS } from '../../src/safety/thresholds.mjs';

/**
 * @typedef {import('../dsp/eq0xcb.mjs').Band} Band
 * @typedef {import('../dsp/eq0xcb.mjs').Section} Section
 * @typedef {import('./thresholds.mjs').Thresholds} Thresholds
 * @typedef {'drag' | 'full'} Grid
 * @typedef {'standard' | 'yolo'} GateProfile
 * @typedef {'a:b0' | 'a:b2' | 'a:-a1' | 'a:b1' | 'a:-a2' | 'b:pole-radius' | 'c:section-peak'
 *   | 'd:prefix-peak' | 'd:prefix-peak-full' | 'e:output-audible' | 'e:output-full' | 'f:codec'
 *   | 'g:preamp' | 'k:kind-not-allowed' | 'd7:pk-boost-above-16k' | 'd7:boost-q'} ReasonCode
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
 * }} GateMetrics
 * `prefixFull` and `internalFull` (DC–48 kHz prefix peaks) exist in the YOLO
 * profile only.
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
export const YOLO_WAIVABLE = Object.freeze([
  'k:kind-not-allowed',
  'd7:pk-boost-above-16k',
  'd7:boost-q',
  'g:preamp',
  'a:b0',
  'a:b2',
  'a:b1',
  'c:section-peak',
]);

/**
 * Reason codes that block in every profile (class 1), in reason order. Listed
 * for callers and tests; the gate itself blocks on anything not in
 * {@link YOLO_WAIVABLE}.
 * @type {readonly ReasonCode[]}
 */
export const HARD_REASONS = Object.freeze([
  'f:codec',
  'a:-a1',
  'a:-a2',
  'b:pole-radius',
  'd:prefix-peak',
  'd:prefix-peak-full',
  'e:output-audible',
  'e:output-full',
]);

/** @type {ReadonlySet<string>} */
const WAIVABLE = new Set(YOLO_WAIVABLE);

/**
 * Whether the YOLO profile waives `code` (class 2).
 * @param {unknown} code
 * @returns {boolean}
 */
export function isWaivable(code) {
  return typeof code === 'string' && WAIVABLE.has(code);
}

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
export function gateProfile(options) {
  if (options === null || typeof options !== 'object') return 'standard';
  try {
    const descriptor = Object.getOwnPropertyDescriptor(options, 'profile');
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return 'standard';
    return descriptor.value === 'yolo' ? 'yolo' : 'standard';
  } catch {
    // A throwing trap: nothing it threw is inspected.
    return 'standard';
  }
}

/**
 * The verdict for `reasons` under `profile`: standard blocks on all of them;
 * YOLO moves the waivable ones (class 2) to `waived`/`waivedReasons`.
 * @param {Reason[]} reasons
 * @param {GateMetrics} metrics
 * @param {GateProfile} profile
 * @returns {GateResult}
 */
function verdict(reasons, metrics, profile) {
  if (profile !== 'yolo') {
    // The former shape, key for key: a standard verdict is exactly what it was.
    return { ok: reasons.length === 0, reasons, metrics };
  }
  const blocking = reasons.filter((r) => !WAIVABLE.has(r.code));
  const waivedReasons = reasons.filter((r) => WAIVABLE.has(r.code));
  const waived = [...new Set(waivedReasons.map((r) => r.code))];
  const ok = blocking.length === 0;
  return { ok, reasons: blocking, waived, waivedReasons, profile: 'yolo', metrics };
}

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
export const GRID_INTERVALS = Object.freeze({ drag: 2048, full: 16384 });

const AUDIBLE_MIN_HZ = 20;
const AUDIBLE_MAX_HZ = 20000;
const FULL_MAX_HZ = SAMPLE_RATE / 2;

/**
 * Pole radius of `1 + a1 z^-1 + a2 z^-2`.
 * @param {Section} s
 * @returns {number}
 */
export function poleRadius(s) {
  const d = s.a1 * s.a1 - 4 * s.a2;
  return d < 0
    ? Math.sqrt(s.a2)
    : Math.max(Math.abs((-s.a1 + Math.sqrt(d)) / 2), Math.abs((-s.a1 - Math.sqrt(d)) / 2));
}

// |p(e^jw)|^2 is quadratic in t = sin²(w/2); the ratio's derivative is quadratic
// too. Evaluate endpoints and every real stationary point. The factored linear
// coefficient avoids cancellation near low-frequency poles.
/**
 * @param {number} p0
 * @param {number} p1
 * @param {number} p2
 * @returns {[number, number, number]}
 */
function powerPolynomial(p0, p1, p2) {
  const sum = p0 + p1 + p2;
  return [sum * sum, 4 * ((p0 - p2) ** 2 - sum * (p0 + p2)), 16 * p0 * p2];
}

/**
 * Exact (analytic) peaks of one section: `full` over DC–48 kHz and `audible`
 * over 20 Hz–20 kHz.
 * @param {Section} s
 * @returns {{full: Peak, audible: Peak}}
 */
export function sectionPeaks(s) {
  const n = powerPolynomial(s.b0, s.b1, s.b2);
  const d = powerPolynomial(1, s.a1, s.a2);
  const a = n[2] * d[1] - n[1] * d[2];
  const b = 2 * (n[2] * d[0] - n[0] * d[2]);
  const c = n[1] * d[0] - n[0] * d[1];
  /** @type {number[]} */
  const roots = [];
  if (a === 0) {
    if (b !== 0) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const q = -0.5 * (b + (b >= 0 ? 1 : -1) * Math.sqrt(discriminant));
      if (q !== 0) roots.push(q / a, c / q);
      else roots.push(-b / (2 * a));
    }
  }
  const stationaryHz = roots
    .filter((t) => t > 0 && t < 1)
    .map((t) => (Math.asin(Math.sqrt(t)) * SAMPLE_RATE) / Math.PI);
  /** @param {number[]} frequencies */
  const maximum = (frequencies) =>
    frequencies
      .map((f) => ({ db: sectionDb(s, f), frequencyHz: f }))
      .reduce((best, p) => (p.db > best.db ? p : best));
  return {
    full: maximum([0, FULL_MAX_HZ, ...stationaryHz]),
    audible: maximum([
      AUDIBLE_MIN_HZ,
      AUDIBLE_MAX_HZ,
      ...stationaryHz.filter((f) => f >= AUDIBLE_MIN_HZ && f <= AUDIBLE_MAX_HZ),
    ]),
  };
}

/**
 * Per-section checks (a, b, c) on the quantized section of `band`, with its
 * analytic peaks. Port of the reference `analyseSection`; reasons carry
 * `value` and `limit` (limits without tolerance). Throws like the codec on
 * bands it cannot encode.
 * @param {Band} band
 * @returns {SectionAnalysis}
 */
export function sectionAnalysis(band) {
  const words = encodeSection(designSection(band));
  const section = fromWords(words);
  const radius = poleRadius(section);
  const peaks = sectionPeaks(section);
  /** @type {Reason[]} */
  const reasons = [];
  words.forEach((word, i) => {
    const limit = THRESHOLDS.coefficientAbsWords[i];
    if (!(Math.abs(word) <= limit)) {
      const code = /** @type {ReasonCode} */ (`a:${THRESHOLDS.coefficientPositions[i]}`);
      reasons.push({ code, value: Math.abs(word), limit });
    }
  });
  if (!(radius <= THRESHOLDS.poleRadius + THRESHOLDS.radiusNumericalTolerance)) {
    reasons.push({ code: 'b:pole-radius', value: radius, limit: THRESHOLDS.poleRadius });
  }
  if (!(peaks.full.db <= THRESHOLDS.sectionPeakDb + THRESHOLDS.dbNumericalTolerance)) {
    reasons.push({ code: 'c:section-peak', value: peaks.full.db, limit: THRESHOLDS.sectionPeakDb });
  }
  return {
    words,
    section,
    poleRadius: radius,
    fullPeak: peaks.full,
    audiblePeak: peaks.audible,
    reasons,
  };
}

/**
 * Highest Q23-representable preamp (dB) satisfying d and e for a curve made of
 * this section and nine OFF, or `null` below the preamp floor. Port of the
 * reference `autoPreampForSection` (NaN metrics give `null`).
 * @param {{audiblePeak: Peak, fullPeak: Peak}} metrics
 * @returns {number | null}
 */
export function autoPreampForSection(metrics) {
  const cap = Math.min(
    THRESHOLDS.internalAudibleDb - Math.max(0, metrics.audiblePeak.db),
    THRESHOLDS.outputAudibleDb - metrics.audiblePeak.db,
    THRESHOLDS.outputFullDb - metrics.fullPeak.db,
  );
  const maximumWord = preampQ23(THRESHOLDS.preampMaxDb);
  const word = Math.min(maximumWord, Math.floor(10 ** (cap / 20) * 2 ** 23));
  if (!(word >= preampQ23(THRESHOLDS.preampMinDb))) return null;
  if (word === maximumWord) return THRESHOLDS.preampMaxDb;
  const db = 20 * Math.log10(word / 2 ** 23);
  return Math.max(THRESHOLDS.preampMinDb, db);
}

/**
 * Q23 word of a (valid) preamp, as the codec computes it.
 * @param {number} db
 */
function preampQ23(db) {
  return Math.round(Math.pow(10, db / 20) * 2 ** 23);
}

/**
 * Golden-section refinement of a local maximum in [a, b].
 * @param {(f: number) => number} fn
 * @param {number} a
 * @param {number} b
 * @returns {Peak}
 */
function refine(fn, a, b) {
  const r = (Math.sqrt(5) - 1) / 2;
  let c = b - r * (b - a);
  let d = a + r * (b - a);
  let fc = fn(c);
  let fd = fn(d);
  for (let i = 0; i < 70 && b - a > 1e-8; i++) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - r * (b - a);
      fc = fn(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + r * (b - a);
      fd = fn(d);
    }
  }
  return fc > fd ? { db: fc, frequencyHz: c } : { db: fd, frequencyHz: d };
}

/**
 * @typedef {{
 *   fs: readonly number[],
 *   re: Float64Array, im: Float64Array, u2re: Float64Array, u2im: Float64Array,
 * }} ScanGrid
 */

/** @type {Map<string, ScanGrid>} */
const scanGrids = new Map();

/**
 * Scan grid of the reference responsePeak (log from `minHz || 0.001` to
 * `maxHz`, exact ends, plus DC when `minHz` is 0), with the per-frequency terms
 * of `sectionDb` precomputed. Cached: grids are immutable.
 * @param {number} intervals
 * @param {number} minHz
 * @param {number} maxHz
 * @returns {ScanGrid}
 */
function scanGrid(intervals, minHz, maxHz) {
  const key = `${intervals}:${minHz}:${maxHz}`;
  const cached = scanGrids.get(key);
  if (cached) return cached;
  const lo = minHz || 0.001;
  const fs = Array.from({ length: intervals + 1 }, (_, i) => lo * (maxHz / lo) ** (i / intervals));
  fs[0] = lo;
  fs[intervals] = maxHz;
  if (minHz === 0) fs.unshift(0);
  const n = fs.length;
  const grid = {
    fs: Object.freeze(fs),
    re: new Float64Array(n),
    im: new Float64Array(n),
    u2re: new Float64Array(n),
    u2im: new Float64Array(n),
  };
  for (let j = 0; j < n; j++) {
    const w = (2 * Math.PI * fs[j]) / SAMPLE_RATE;
    const re = 2 * Math.sin(w / 2) ** 2;
    const im = Math.sin(w);
    grid.re[j] = re;
    grid.im[j] = im;
    grid.u2re[j] = re * re - im * im;
    grid.u2im[j] = 2 * re * im;
  }
  scanGrids.set(key, grid);
  return grid;
}

/**
 * Incremental cascade response on a scan grid: `add` appends a section, `peak`
 * returns the reference responsePeak of the sections added so far.
 */
class CascadeScan {
  /**
   * @param {number} intervals
   * @param {number} minHz
   * @param {number} maxHz
   * @param {boolean} scan whether the grid is needed (more than one section will be added)
   */
  constructor(intervals, minHz, maxHz, scan) {
    this.minHz = minHz;
    this.grid = scan ? scanGrid(intervals, minHz, maxHz) : null;
    this.values = new Float64Array(this.grid ? this.grid.fs.length : 0);
    /** @type {Section[]} */
    this.sections = [];
  }

  /** @param {Section} s */
  add(s) {
    this.sections.push(s);
    if (!this.grid) return;
    const { re, im, u2re, u2im } = this.grid;
    const values = this.values;
    for (let j = 0; j < values.length; j++) {
      values[j] = values[j] + sectionDbFromTerms(s, re[j], im[j], u2re[j], u2im[j]);
    }
  }

  /** @returns {Peak} */
  peak() {
    const sections = this.sections;
    if (!sections.length) return { db: 0, frequencyHz: this.minHz };
    if (sections.length === 1) {
      const p = sectionPeaks(sections[0]);
      return this.minHz === 0 ? p.full : p.audible;
    }
    /** @param {number} f */
    const fn = (f) => sections.reduce((db, section) => db + sectionDb(section, f), 0);
    const fs = /** @type {ScanGrid} */ (this.grid).fs;
    const values = this.values;
    let best = { db: values[0], frequencyHz: fs[0] };
    for (let i = 1; i < fs.length; i++) {
      if (values[i] > best.db) best = { db: values[i], frequencyHz: fs[i] };
      if (i < fs.length - 1 && values[i] > values[i - 1] && values[i] >= values[i + 1]) {
        const candidate = refine(fn, fs[i - 1], fs[i + 1]);
        if (candidate.db > best.db) best = candidate;
      }
    }
    // Not in the reference (see GRID_INTERVALS): a peak inside the first or last
    // interval has no bracketing interior grid point, so refine both edges too.
    // A candidate only replaces `best` when strictly higher: never laxer.
    const last = fs.length - 1;
    for (const [a, b] of [
      [0, 1],
      [last - 1, last],
    ]) {
      const candidate = refine(fn, fs[a], fs[b]);
      if (candidate.db > best.db) best = candidate;
    }
    return best;
  }
}

/**
 * Policy reasons (kinds and D7) for each band of a snapshot, in stage order.
 * @param {readonly Readonly<Band>[]} bands Output of `snapshotBands` (plain, frozen).
 * @param {boolean} experimental
 * @returns {Reason[]}
 */
function policyReasons(bands, experimental) {
  /** @type {Reason[]} */
  const kinds = [];
  /** @type {Reason[]} */
  const d7 = [];
  const layer = experimental ? 'engenharia' : 'ajustar';
  // Non-numbers count as NaN (they fail every check) and are never converted, so
  // no caller code (valueOf, Symbol coercion) runs here; the codec rejects them.
  const numeric = (/** @type {unknown} */ value) => (typeof value === 'number' ? value : NaN);
  // Reasons carry only JSON-safe primitives, never a caller object whose toJSON
  // or toString a consumer (e.g. an error message) would end up running.
  const shown = (/** @type {unknown} */ value) => {
    switch (typeof value) {
      case 'number':
      case 'string':
      case 'boolean':
      case 'undefined':
        return value;
      case 'bigint':
        return `${String(value)}n`;
      default:
        return value === null ? null : `(${typeof value})`;
    }
  };
  for (let i = 0; i < bands.length; i++) {
    const stage = i + 1;
    const band = /** @type {Record<string, unknown>} */ (bands[i]);
    const kind = band.kind;
    if (!isKindAllowed(kind, layer)) {
      kinds.push({ code: 'k:kind-not-allowed', stage, value: shown(kind) });
    }
    if (kind !== 'PK' && kind !== 'LS' && kind !== 'HS') continue;
    if (!(numeric(band.gainDb) <= 0)) {
      if (kind === 'PK' && !(numeric(band.freqHz) <= ABS_RANGES.pkBoostMaxHz)) {
        d7.push({
          code: 'd7:pk-boost-above-16k',
          stage,
          value: shown(band.freqHz),
          limit: ABS_RANGES.pkBoostMaxHz,
        });
      }
      if (!(numeric(band.qFactor) <= ABS_RANGES.boostQMax)) {
        const value = shown(band.qFactor);
        d7.push({ code: 'd7:boost-q', stage, value, limit: ABS_RANGES.boostQMax });
      }
    }
  }
  return [...kinds, ...d7];
}

/**
 * @param {readonly number[]} payload
 * @returns {string}
 */
function payloadCrc(payload) {
  const hex = (/** @type {number} */ byte) => byte.toString(16).padStart(2, '0');
  return `0x${hex(payload[payload.length - 1])}${hex(payload[payload.length - 2])}`;
}

// `f:codec` text when the copy fails because of something it did not throw
// itself. The caller's getters and Proxy traps run during the copy, so such a
// value may be theirs: it is never inspected (no `instanceof`, `message`,
// `String` or `toString`, all of which can run caller code).
const UNREADABLE = 'the bands could not be read';
// Same text as `snapshotBands`, checked by the gate itself (`Array.isArray`
// runs no Proxy trap), so this refusal keeps its message.
const NOT_AN_ARRAY = 'bands must be an array';
// The errors `copyBands` throws itself, and only those. `WeakSet.prototype.has`
// compares identity only: it runs no getter, Proxy trap or conversion, whatever
// the value (a primitive is simply absent), so it is safe on a caller's value.
/** @type {WeakSet<Error>} */
const COPY_ERRORS = new WeakSet();

/**
 * Registers an error of the copy step's own, whose `message` (a plain data
 * property set by the constructor) the gate may report.
 * @param {Error} error
 * @returns {Error}
 */
function copyError(error) {
  COPY_ERRORS.add(error);
  return error;
}

/**
 * The gate's one-read copy of `bands`, with `snapshotBands`'s reads, order and
 * messages: `length` once, then for each index `in`, the element, and its
 * `kind`, `freqHz`, `gainDb` and `qFactor` once each, in that order. The values
 * read are put in plain records that `snapshotBands` then normalizes and
 * freezes; it runs no caller code on them (plain data, compared with `===`
 * only) and cannot refuse them. The structural refusals (`expected 10 bands`,
 * `band <i>: missing (hole in a sparse array)`, `band <i>: not an object`) are
 * registered in {@link COPY_ERRORS}; anything else that escapes was thrown by
 * caller code (a getter or a Proxy trap).
 * @param {readonly unknown[]} bands Already checked with `Array.isArray`.
 * @returns {readonly Readonly<Band>[]}
 */
function copyBands(bands) {
  const length = bands.length;
  if (length !== BAND_COUNT) throw copyError(new RangeError(`expected ${BAND_COUNT} bands`));
  /** @type {Record<string, unknown>[]} */
  const records = [];
  for (let index = 0; index < BAND_COUNT; index++) {
    if (!(index in bands)) {
      throw copyError(new TypeError(`band ${index}: missing (hole in a sparse array)`));
    }
    /** @type {unknown} */
    const band = bands[index];
    if (band === null || typeof band !== 'object') {
      throw copyError(new TypeError(`band ${index}: not an object`));
    }
    const { kind, freqHz, gainDb, qFactor } = /** @type {Record<string, unknown>} */ (band);
    records.push({ kind, freqHz, gainDb, qFactor });
  }
  return snapshotBands(records, BAND_COUNT);
}

/**
 * Message of a codec refusal of the frozen copy; never throws.
 *
 * `encodePayload` only sees the gate's frozen copy and a `preampDb` it checks
 * without coercion (non-primitive values kept by reference are described by
 * their type only), so it runs no caller code and throws only the codec's own
 * errors, whose `message` is a plain data property.
 * @param {unknown} error
 * @returns {string}
 */
function codecMessage(error) {
  try {
    return error instanceof Error && typeof error.message === 'string' ? error.message : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

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
export function gate(bands, preampDb, options = {}) {
  const profile = gateProfile(options);
  const { experimental = false, grid = 'full' } = options;
  if (!Object.hasOwn(GRID_INTERVALS, grid)) {
    throw new RangeError(`grid must be 'drag' or 'full', got ${JSON.stringify(grid)}`);
  }
  const yolo = profile === 'yolo';
  const intervals = GRID_INTERVALS[grid];
  /** @type {GateMetrics} */
  const metrics = { thresholds: THRESHOLDS, grid };
  /** @type {readonly Readonly<Band>[]} */
  let snapshot;
  try {
    if (!Array.isArray(bands)) {
      return verdict([{ code: 'f:codec', value: NOT_AN_ARRAY }], metrics, profile);
    }
    snapshot = copyBands(bands);
  } catch (error) {
    // Only the copy step's own errors keep their message; `COPY_ERRORS.has`
    // runs no caller code. Anything else may be the caller's and is never read.
    const own = COPY_ERRORS.has(/** @type {Error} */ (error));
    const value = own ? /** @type {Error} */ (error).message : UNREADABLE;
    return verdict([{ code: 'f:codec', value }], metrics, profile);
  }
  const reasons = policyReasons(snapshot, experimental === true);
  /** @type {number[]} */
  let payload;
  try {
    payload = encodePayload(snapshot, preampDb);
  } catch (error) {
    reasons.push({ code: 'f:codec', value: codecMessage(error) });
    return verdict(reasons, metrics, profile);
  }
  metrics.payloadCrc = payloadCrc(payload);
  metrics.payload = Uint8Array.from(payload);
  metrics.bands = snapshot;
  if (!(preampDb >= THRESHOLDS.preampMinDb && preampDb <= THRESHOLDS.preampMaxDb)) {
    const limit =
      preampDb < THRESHOLDS.preampMinDb ? THRESHOLDS.preampMinDb : THRESHOLDS.preampMaxDb;
    reasons.push({ code: 'g:preamp', value: preampDb, limit });
  }
  const preamp = quantizedPreampDb(preampDb);
  metrics.preampDb = preampDb;
  metrics.quantizedPreampDb = preamp;
  /** @type {SectionAnalysis[]} */
  const sections = [];
  for (let i = 0; i < snapshot.length; i++) {
    const s = sectionAnalysis(snapshot[i]);
    for (const { code, value, limit } of s.reasons) {
      reasons.push({ code, stage: i + 1, value, limit });
    }
    sections.push(s);
  }
  metrics.sections = sections;

  // Identity sections (OFF) are skipped, as in the reference. The scan grids
  // are only built when more than one section is active (one active section
  // always uses the analytic peak).
  const active = sections.map((s) => s.section).filter((s) => !isIdentitySection(s));
  const scan = active.length > 1;
  const audible = new CascadeScan(intervals, AUDIBLE_MIN_HZ, AUDIBLE_MAX_HZ, scan);
  /** @type {PrefixPeak[]} */
  const prefixAudible = [{ stage: 0, db: preamp, frequencyHz: null }];
  /** @type {Peak | null} */
  let peak = null;
  for (const [i, item] of sections.entries()) {
    if (!isIdentitySection(item.section)) {
      audible.add(item.section);
      peak = null;
    }
    // An unchanged prefix has the same (deterministic) peak: reuse it.
    if (peak === null) peak = audible.peak();
    prefixAudible.push({ stage: i + 1, db: peak.db + preamp, frequencyHz: peak.frequencyHz });
  }
  metrics.prefixAudible = prefixAudible;
  const internalAudible = prefixAudible.reduce((a, b) => (b.db > a.db ? b : a));
  const outputAudible = prefixAudible[prefixAudible.length - 1];
  metrics.internalAudible = internalAudible;
  metrics.outputAudible = outputAudible;
  const fullScan = new CascadeScan(intervals, 0, FULL_MAX_HZ, scan);
  /** @type {PrefixPeak[] | null} */
  let prefixFull = null;
  if (yolo) {
    // YOLO only (d:prefix-peak-full): every prefix over DC–48 kHz. The sections
    // are added in the same order as below, so the last prefix's scan is the
    // very scan `outputFull` reads.
    prefixFull = [{ stage: 0, db: preamp, frequencyHz: null }];
    /** @type {Peak | null} */
    let fullPeak = null;
    for (const [i, item] of sections.entries()) {
      if (!isIdentitySection(item.section)) {
        fullScan.add(item.section);
        fullPeak = null;
      }
      if (fullPeak === null) fullPeak = fullScan.peak();
      prefixFull.push({ stage: i + 1, db: fullPeak.db + preamp, frequencyHz: fullPeak.frequencyHz });
    }
  } else {
    for (const s of active) fullScan.add(s);
  }
  const full = fullScan.peak();
  const outputFull = { db: full.db + preamp, frequencyHz: full.frequencyHz };
  metrics.outputFull = outputFull;
  /** @type {PrefixPeak | null} */
  let internalFull = null;
  if (prefixFull) {
    internalFull = prefixFull.reduce((a, b) => (b.db > a.db ? b : a));
    metrics.prefixFull = prefixFull;
    metrics.internalFull = internalFull;
  }

  const tolerance = THRESHOLDS.dbNumericalTolerance;
  if (!(internalAudible.db <= THRESHOLDS.internalAudibleDb + tolerance)) {
    // Where it first happens: the earliest prefix over the limit (0 = the preamp alone).
    const first = prefixAudible.find((p) => !(p.db <= THRESHOLDS.internalAudibleDb + tolerance));
    reasons.push({
      code: 'd:prefix-peak',
      stage: first ? first.stage : internalAudible.stage,
      value: internalAudible.db,
      limit: THRESHOLDS.internalAudibleDb,
    });
  }
  if (prefixFull && internalFull) {
    const limit = YOLO_THRESHOLDS.internalFullDb;
    if (!(internalFull.db <= limit + tolerance)) {
      const first = prefixFull.find((p) => !(p.db <= limit + tolerance));
      reasons.push({
        code: 'd:prefix-peak-full',
        stage: first ? first.stage : internalFull.stage,
        value: internalFull.db,
        limit,
      });
    }
  }
  if (!(outputAudible.db <= THRESHOLDS.outputAudibleDb + tolerance)) {
    reasons.push({
      code: 'e:output-audible',
      value: outputAudible.db,
      limit: THRESHOLDS.outputAudibleDb,
    });
  }
  if (!(outputFull.db <= THRESHOLDS.outputFullDb + tolerance)) {
    reasons.push({ code: 'e:output-full', value: outputFull.db, limit: THRESHOLDS.outputFullDb });
  }
  return verdict(reasons, metrics, profile);
}

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
export function gateForWrite(bands, preampDb, options = {}) {
  const profile = gateProfile(options);
  const { experimental = false } = options ?? {};
  return gate(bands, preampDb, { experimental, grid: 'full', profile });
}

const PREAMP_STEPS_PER_DB = 10;

/**
 * Lowest preamp on the 0.1 dB grid whose Q23 word is not zero: the codec floor,
 * the YOLO profile's only lower bound (g:preamp is waived there). About
 * −144.4 dB, where the preamp is practically silence.
 */
export const CODEC_PREAMP_FLOOR_DB =
  Math.ceil(20 * Math.log10(0.5 / 2 ** 23) * PREAMP_STEPS_PER_DB) / PREAMP_STEPS_PER_DB;

/**
 * Highest preamp on the 0.1 dB UI grid within [preampMinDb, preampMaxDb] for
 * which `gateForWrite` accepts the curve, or `null` when none does (including
 * curves failing checks a preamp cannot fix: kinds, D7, codec, a, b, c).
 *
 * In the YOLO profile (`options.profile`, read like {@link gateProfile}) the
 * lower bound is {@link CODEC_PREAMP_FLOOR_DB} instead, `d:prefix-peak-full` is
 * fixable too, and only class-1 reasons count (class 2 is waived).
 *
 * A candidate is derived analytically from the metrics at the top preamp,
 * rounded down to the grid, then verified with the gate and stepped down by
 * 0.1 dB while refused (the verdict is monotone in the preamp). The bands are
 * read once: every later verification runs on the first verdict's snapshot.
 * @param {readonly Band[]} bands
 * @param {{experimental?: boolean, profile?: GateProfile}} [options]
 * @returns {number | null}
 */
export function autoPreamp(bands, options = {}) {
  const profile = gateProfile(options);
  const { experimental = false } = options ?? {};
  const yolo = profile === 'yolo';
  const top = gateForWrite(bands, THRESHOLDS.preampMaxDb, { experimental, profile });
  if (top.ok) return THRESHOLDS.preampMaxDb;
  const fixable = new Set(['d:prefix-peak', 'e:output-audible', 'e:output-full']);
  if (yolo) fixable.add('d:prefix-peak-full');
  if (!top.reasons.every((r) => fixable.has(r.code))) return null;
  const m = /** @type {Required<GateMetrics>} */ (top.metrics);
  const snapshot = m.bands;
  const relative = (/** @type {number} */ db) => db - m.quantizedPreampDb;
  const internalPeak = Math.max(0, ...m.prefixAudible.slice(1).map((p) => relative(p.db)));
  let cap = Math.min(
    THRESHOLDS.internalAudibleDb - internalPeak,
    THRESHOLDS.outputAudibleDb - relative(m.outputAudible.db),
    THRESHOLDS.outputFullDb - relative(m.outputFull.db),
  );
  if (yolo) {
    const internalFullPeak = Math.max(0, ...m.prefixFull.slice(1).map((p) => relative(p.db)));
    cap = Math.min(cap, YOLO_THRESHOLDS.internalFullDb - internalFullPeak);
  }
  const floorDb = yolo ? CODEC_PREAMP_FLOOR_DB : THRESHOLDS.preampMinDb;
  const minStep = Math.round(floorDb * PREAMP_STEPS_PER_DB);
  const maxStep = Math.round(THRESHOLDS.preampMaxDb * PREAMP_STEPS_PER_DB);
  // Slightly optimistic start (Q23 rounding and the dB tolerance can admit a
  // grid point just above the analytic cap); the gate decides.
  let step = Math.min(maxStep - 1, Math.floor((cap + 1e-6) * PREAMP_STEPS_PER_DB));
  if (!(step >= minStep)) return null;
  for (; step >= minStep; step--) {
    const preampDb = step / PREAMP_STEPS_PER_DB;
    if (gateForWrite(snapshot, preampDb, { experimental, profile }).ok) return preampDb;
  }
  return null;
}
