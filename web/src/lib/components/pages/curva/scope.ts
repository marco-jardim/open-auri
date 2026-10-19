/**
 * Geometry and cheap curve analysis for the Curva oscilloscope (pure, no DOM).
 *
 * - Plot space follows the v2 mock: 820 × 380 viewBox, ±15 dB, log frequency from 20 Hz to the
 *   Nyquist of core's 96 kHz evaluator (48 kHz). 20 Hz to 20 kHz is the audible, editable band;
 *   above it the scope only shows where the response really converges (shaded as inaudible).
 * - Responses come from core (`curveResponseDb`, one call per section, summed in dB, which is
 *   exactly how core sums a cascade), on the whole axis. Nothing here designs or evaluates a biquad.
 * - Readouts (preview peak, over/near zones) read the audible part of a grid only (`audiblePeak`,
 *   `audibleSpansAbove`): the band above 20 kHz never changes a reading.
 * - The prefix (internal) and output peaks are a drawing preview on a coarse grid. They show WHERE
 *   a curve gets close to or over the limits while a handle moves; the gate (full grid, worker)
 *   still decides every commit and write.
 * - Safe boxes come from SOFT_RANGES (conservative single-section boxes) and the hard limits from
 *   ABS_RANGES and the D7 rules of core policy.
 * - Frequency limits follow the layer (core `freqMaxFor`, `freqMax` here): Ouvir and Ajustar stop
 *   at 20 kHz; Engenharia goes to 32 kHz for sections that never amplify (a PK with gain <= 0, an
 *   LS/HS with gain <= 0 and Q <= 0.71, an LP/HP with Q <= 0.71); Modo YOLO (Engenharia only) to
 *   32 kHz for every kind. Readouts still read 20 Hz to 20 kHz only; 32 to 48 kHz is never
 *   editable.
 */
import { curveResponseDb, logGrid } from 'open-auri/dsp';
import {
	ABS_RANGES,
	AUDIBLE_MAX_HZ,
	freqMaxFor,
	SOFT_RANGES,
	THRESHOLDS,
	ULTRA_MAX_HZ
} from 'open-auri/safety';
import type { Layer } from './layers.ts';
import { hasGain, type Band, type Curve } from './model.ts';

export const VIEW_WIDTH = 820;
export const VIEW_HEIGHT = 380;
export const PLOT = { left: 66, right: 790, top: 26, bottom: 346 } as const;
export const DB_MIN = -15;
export const DB_MAX = 15;
export const F_MIN = 20;
/**
 * Top of the audible band: every readout ends here, and so does the editable range of Ouvir and
 * Ajustar (Engenharia edits up to 32 kHz, see `editableMaxHz` and `freqMax`).
 */
export const F_MAX = AUDIBLE_MAX_HZ;
/** Nyquist of core's 96 kHz evaluator (`SAMPLE_RATE / 2`): the plot's right edge. */
export const NYQUIST_HZ = 48000;
/** Output limit drawn on the scope (the gate's audible output threshold). */
export const OUTPUT_LIMIT_DB = THRESHOLDS.outputAudibleDb;
/** Internal (prefix) limit: clipping inside the chain. */
export const INTERNAL_LIMIT_DB = THRESHOLDS.internalAudibleDb;
/** How close to a limit counts as "near" (amber) on the scope. */
export const NEAR_MARGIN_DB = 1;

/**
 * Steps from 20 kHz to Nyquist: the audible density (64 per decade) over log10(2.4) decades,
 * rounded to an even count so DRAG_GRID (every other point) keeps both 20 kHz and Nyquist.
 */
const INAUDIBLE_STEPS = 24;

/**
 * Drawing grid: coarser than core's analysis GRID, enough for a smooth trace on every frame. The
 * audible part (20 Hz to 20 kHz, 193 points) is the grid the readouts have always used; the
 * inaudible band continues it up to Nyquist, both ends exact.
 */
export const SCOPE_GRID: readonly number[] = Object.freeze([
	...logGrid(193, F_MIN, F_MAX),
	...logGrid(INAUDIBLE_STEPS + 1, F_MAX, NYQUIST_HZ).slice(1)
]);

const span = PLOT.right - PLOT.left;
const height = PLOT.bottom - PLOT.top;
const decades = Math.log10(NYQUIST_HZ / F_MIN);

export const xOf = (freqHz: number): number =>
	PLOT.left + (Math.log10(freqHz / F_MIN) / decades) * span;
export const freqOf = (x: number): number =>
	F_MIN * (NYQUIST_HZ / F_MIN) ** ((x - PLOT.left) / span);
export const yOf = (db: number): number => PLOT.top + ((DB_MAX - db) / (DB_MAX - DB_MIN)) * height;
export const dbOf = (y: number): number => DB_MAX - ((y - PLOT.top) / height) * (DB_MAX - DB_MIN);

export const clamp = (value: number, min: number, max: number): number =>
	value < min ? min : value > max ? max : value;

/** Major frequency lines (labelled) and the minor 2…9 lines of each decade. */
export const MAJOR_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000] as const;
export const MINOR_FREQS: readonly number[] = [10, 100, 1000, 10000].flatMap((decade) =>
	[2, 3, 4, 5, 6, 7, 8, 9]
		.map((k) => decade * k)
		.filter((f) => f > F_MIN && f < F_MAX && !(MAJOR_FREQS as readonly number[]).includes(f))
);
/** Graticule lines inside the inaudible band (20 kHz to Nyquist). */
export const INAUDIBLE_FREQS = [30000, 40000] as const;

type Section = Exclude<Band, { kind: 'OFF' }>;

function evaluateSection(band: Section, grid: readonly number[]): readonly number[] | null {
	try {
		return Object.freeze(curveResponseDb({ bands: [band], preampDb: 0 }, grid));
	} catch (error) {
		// Core validates the band (range/type errors); such a band simply has no trace.
		if (error instanceof RangeError || error instanceof TypeError) return null;
		throw error;
	}
}

// While a handle moves, the scope redraws every frame but only one section changes: the other
// sections' core responses are remembered (per frozen grid, keyed by their exact parameters), so
// a frame evaluates one section instead of ten. The cached arrays are frozen and never shared
// mutable; a section whose fields are not plain numbers is always evaluated afresh.
const RESPONSE_CACHE_LIMIT = 128;
const responseCaches = new WeakMap<readonly number[], Map<string, readonly number[] | null>>();

/** Exact text of a number (`String` round-trips every double; −0 kept apart from 0). */
const numberKey = (value: number): string => (Object.is(value, -0) ? '-0' : String(value));

/** Exact key of a section's parameters, or null when one is not a plain number (not cached). */
function sectionKey(band: Section): string | null {
	const fields: { kind: unknown; freqHz: unknown; gainDb?: unknown; qFactor: unknown } = band;
	const { kind, freqHz, gainDb, qFactor } = fields;
	if (typeof kind !== 'string' || typeof freqHz !== 'number' || typeof qFactor !== 'number') {
		return null;
	}
	if (gainDb !== undefined && typeof gainDb !== 'number') return null;
	const gain = gainDb === undefined ? '' : numberKey(gainDb);
	return `${kind}|${numberKey(freqHz)}|${gain}|${numberKey(qFactor)}`;
}

/**
 * One section's response in dB on `grid` (frozen), or null for OFF and bands core cannot
 * evaluate. On a frozen grid the result is remembered for the section's exact parameters.
 */
export function bandResponse(
	band: Band,
	grid: readonly number[] = SCOPE_GRID
): readonly number[] | null {
	if (band.kind === 'OFF') return null;
	const key = Object.isFrozen(grid) ? sectionKey(band) : null;
	if (key === null) return evaluateSection(band, grid);
	let cache = responseCaches.get(grid);
	if (!cache) {
		cache = new Map();
		responseCaches.set(grid, cache);
	}
	const hit = cache.get(key);
	if (hit !== undefined) {
		// Most recently used last: the bound below drops the oldest entry.
		cache.delete(key);
		cache.set(key, hit);
		return hit;
	}
	const response = evaluateSection(band, grid);
	cache.set(key, response);
	if (cache.size > RESPONSE_CACHE_LIMIT) {
		const oldest = cache.keys().next();
		if (!oldest.done) cache.delete(oldest.value);
	}
	return response;
}

export interface Traces {
	/** Per section (wire order); null for OFF or unevaluable sections. */
	bands: (readonly number[] | null)[];
	/** Sum of the sections (no preamp). */
	eq: number[];
	/** Sum of the sections plus the preamp: what reaches the output. */
	output: number[];
	/** Highest level inside the chain at each frequency (preamp and every prefix). */
	internal: number[];
	/** 1-based stage where `internal` first goes over the internal limit, per frequency (0: none). */
	internalStage: number[];
}

/** All scope traces of `curve`, from per-section core responses. */
export function traces(curve: Curve, grid: readonly number[] = SCOPE_GRID): Traces {
	const bands = curve.bands.map((band) => bandResponse(band, grid));
	const eq = new Array<number>(grid.length).fill(0);
	const internal = new Array<number>(grid.length).fill(curve.preampDb);
	const internalStage = new Array<number>(grid.length).fill(0);
	bands.forEach((response, index) => {
		if (!response) return;
		for (let i = 0; i < grid.length; i++) {
			eq[i] = (eq[i] ?? 0) + (response[i] ?? 0);
			const level = curve.preampDb + (eq[i] ?? 0);
			if (level > (internal[i] ?? -Infinity)) internal[i] = level;
			if (internalStage[i] === 0 && level > INTERNAL_LIMIT_DB) internalStage[i] = index + 1;
		}
	});
	const output = eq.map((db) => db + curve.preampDb);
	return { bands, eq, output, internal, internalStage };
}

/**
 * Grid of the traces while a point moves: every other SCOPE_GRID frequency (109 points, both ends
 * and 20 kHz kept), so each drag frame builds, parses and paints half the path points. On release
 * the scope draws on SCOPE_GRID again, so every resting trace is the full-resolution one.
 */
export const DRAG_GRID: readonly number[] = Object.freeze(SCOPE_GRID.filter((_, i) => i % 2 === 0));

/** Leading points of an ascending `grid` inside the audible band (up to F_MAX, included). */
export function audibleLength(grid: readonly number[]): number {
	let n = 0;
	while (n < grid.length && (grid[n] ?? Infinity) <= F_MAX) n++;
	return n;
}

/**
 * Highest value of `values` in the audible band and where (the scope's preview peak readout), or
 * null when nothing there is finite. The band above 20 kHz is drawn but never read.
 */
export function audiblePeak(
	values: readonly number[],
	grid: readonly number[] = SCOPE_GRID
): { db: number; hz: number } | null {
	const n = Math.min(values.length, audibleLength(grid));
	let db = -Infinity;
	let hz = grid[0] ?? F_MIN;
	for (let i = 0; i < n; i++) {
		const value = values[i] ?? -Infinity;
		if (value > db) {
			db = value;
			hz = grid[i] ?? hz;
		}
	}
	return Number.isFinite(db) ? { db, hz } : null;
}

/** `xOf(f).toFixed(1)` of every frequency of a frozen grid: the same text on every redraw. */
const xTexts = new WeakMap<readonly number[], readonly string[]>();

function xTextsOf(grid: readonly number[]): readonly string[] | null {
	if (!Object.isFrozen(grid)) return null;
	let texts = xTexts.get(grid);
	if (!texts) {
		texts = Object.freeze(grid.map((f) => xOf(f).toFixed(1)));
		xTexts.set(grid, texts);
	}
	return texts;
}

/**
 * y text of a response value, clamped far outside the plot so the clip crops it at the axis edge.
 * −∞ (an LP's exact zero at Nyquist) is pinned there too instead of being dropped.
 */
const yText = (db: number): string => yOf(clamp(db, -60, 60)).toFixed(1);

/** SVG path of a response on `grid` (values clamped far outside the plot; the clip crops). */
export function pathOf(values: readonly number[], grid: readonly number[] = SCOPE_GRID): string {
	const xs = xTextsOf(grid);
	let d = '';
	for (let i = 0; i < values.length; i++) {
		const f = grid[i];
		const v = values[i];
		if (f === undefined || v === undefined || Number.isNaN(v)) continue;
		d += `${d ? 'L' : 'M'}${xs?.[i] ?? xOf(f).toFixed(1)} ${yText(v)}`;
	}
	return d;
}

const pathCaches = new WeakMap<readonly number[], WeakMap<readonly number[], string>>();

/**
 * `pathOf`, remembered per frozen response array and frozen grid (the cached section
 * responses): while one handle moves, the other sections' thin traces are not rebuilt.
 */
export function responsePath(
	values: readonly number[],
	grid: readonly number[] = SCOPE_GRID
): string {
	if (!Object.isFrozen(values) || !Object.isFrozen(grid)) return pathOf(values, grid);
	let cache = pathCaches.get(grid);
	if (!cache) {
		cache = new WeakMap();
		pathCaches.set(grid, cache);
	}
	let d = cache.get(values);
	if (d === undefined) {
		d = pathOf(values, grid);
		cache.set(values, d);
	}
	return d;
}

export interface Span {
	fromHz: number;
	toHz: number;
	/** Highest value inside the span and where it is. */
	peakDb: number;
	peakHz: number;
}

/** Frequency spans (on `grid`) where `values` is above `threshold`. */
export function spansAbove(
	values: readonly number[],
	threshold: number,
	grid: readonly number[] = SCOPE_GRID
): Span[] {
	const spans: Span[] = [];
	let current: Span | null = null;
	for (let i = 0; i < values.length; i++) {
		const v = values[i] ?? -Infinity;
		const f = grid[i] ?? F_MAX;
		if (v > threshold) {
			if (!current) {
				current = { fromHz: grid[Math.max(0, i - 1)] ?? f, toHz: f, peakDb: v, peakHz: f };
				spans.push(current);
			}
			current.toHz = grid[Math.min(values.length - 1, i + 1)] ?? f;
			if (v > current.peakDb) {
				current.peakDb = v;
				current.peakHz = f;
			}
		} else {
			current = null;
		}
	}
	return spans;
}

/** `spansAbove` on the audible part of `grid` only: the inaudible band never lights a zone. */
export function audibleSpansAbove(
	values: readonly number[],
	threshold: number,
	grid: readonly number[] = SCOPE_GRID
): Span[] {
	return spansAbove(values.slice(0, audibleLength(grid)), threshold, grid);
}

/** Path of `values` restricted to one span (to stroke the part of a trace that is over). */
export function segmentPath(
	values: readonly number[],
	from: number,
	to: number,
	grid: readonly number[] = SCOPE_GRID
): string {
	const xs = xTextsOf(grid);
	let d = '';
	for (let i = 0; i < values.length; i++) {
		const f = grid[i];
		const v = values[i];
		if (f === undefined || v === undefined || f < from || f > to || Number.isNaN(v)) continue;
		d += `${d ? 'L' : 'M'}${xs?.[i] ?? xOf(f).toFixed(1)} ${yText(v)}`;
	}
	return d;
}

export interface Box {
	fMin: number;
	fMax: number;
	gMin: number;
	gMax: number;
}

/**
 * Safe box of a section in the handle plane (frequency × gain): the core SOFT_RANGES box for its
 * kind (PK narrow when Q > 2, HS boost when it boosts). LP/HP have no gain: a thin strip at 0 dB.
 */
export function softBox(band: Band): Box | null {
	const pick = () => {
		switch (band.kind) {
			case 'PK':
				return band.qFactor > 2 ? SOFT_RANGES['PK-narrow'] : SOFT_RANGES['PK-main'];
			case 'LS':
				return SOFT_RANGES.LS;
			case 'HS':
				return band.gainDb > 0 ? SOFT_RANGES['HS-boost'] : SOFT_RANGES['HS-cut'];
			case 'LP':
				return SOFT_RANGES.LP;
			case 'HP':
				return SOFT_RANGES.HP;
			default:
				return null;
		}
	};
	const range = pick();
	if (!range) return null;
	const gain = 'gainDb' in range ? range.gainDb : undefined;
	return {
		fMin: range.freqHz.min,
		fMax: range.freqHz.max,
		gMin: gain ? gain.min : -2,
		gMax: gain ? gain.max : 2
	};
}

export type HardZoneKind = 'gain-cap' | 'pk-high-boost' | 'ultra-boost';
export interface HardZone extends Box {
	kind: HardZoneKind;
}

/**
 * Editor context of the frequency limits: the layer and Modo YOLO (which exists only in
 * Engenharia; `freqMaxFor` counts `yolo` there only). Without a layer the limits are Ouvir's.
 */
export interface FreqContext {
	readonly layer?: Layer;
	readonly yolo?: boolean;
}

/** Highest frequency `band` may take in `context` (core `freqMaxFor`; 20 or 32 kHz). */
export function freqMax(band: Band, context: FreqContext = {}): number {
	return freqMaxFor(band, { layer: context.layer ?? '', yolo: context.yolo === true });
}

/**
 * Top of the editable band of a layer, whatever the section: 32 kHz in Engenharia (where sections
 * that never amplify, and every section in Modo YOLO, may go above 20 kHz), else 20 kHz. Above it,
 * up to Nyquist, nothing is editable.
 */
export function editableMaxHz(context: FreqContext = {}): number {
	return context.layer === 'engenharia' ? ULTRA_MAX_HZ : AUDIBLE_MAX_HZ;
}

/**
 * Where the handle of this section can never go: the ABS_RANGES gain cap (up to the layer's top,
 * `editableMaxHz`), D7's PK boost above 16 kHz and, in Engenharia without Modo YOLO, any boost
 * between 20 and 32 kHz (`ultra-boost`, core `d7:boost-above-20k`).
 */
export function hardZones(band: Band, context: FreqContext = {}): HardZone[] {
	if (band.kind === 'OFF' || !hasGain(band)) return [];
	const maxHz = editableMaxHz(context);
	const zones: HardZone[] = [
		{ kind: 'gain-cap', fMin: F_MIN, fMax: maxHz, gMin: ABS_RANGES.gainDb.max, gMax: DB_MAX }
	];
	if (band.kind === 'PK') {
		zones.push({
			kind: 'pk-high-boost',
			fMin: ABS_RANGES.pkBoostMaxHz,
			fMax: F_MAX,
			gMin: 0,
			gMax: ABS_RANGES.gainDb.max
		});
	}
	if (maxHz > AUDIBLE_MAX_HZ && context.yolo !== true) {
		zones.push({
			kind: 'ultra-boost',
			fMin: AUDIBLE_MAX_HZ,
			fMax: maxHz,
			gMin: 0,
			gMax: ABS_RANGES.gainDb.max
		});
	}
	return zones;
}

/** The handle's gain on the plot (LP/HP sit at 0 dB). */
export const handleGain = (band: Band): number => (hasGain(band) ? band.gainDb : 0);

/**
 * Pointer position (viewBox units) to a target inside the control ranges of `context`: gain in
 * ABS_RANGES, frequency up to `freqMax` of the band as it would be at the pointer's gain (so in
 * Engenharia a boost stops at 20 kHz, a cut goes on to 32 kHz; Modo YOLO lets both go to 32 kHz).
 */
export function pointerTarget(
	vx: number,
	vy: number,
	band: Band,
	context: FreqContext = {}
): { freqHz: number; gainDb?: number } {
	const fMax = (target: Band) => freqMax(target, context);
	if (!hasGain(band)) {
		return { freqHz: Math.round(clamp(freqOf(vx), ABS_RANGES.freqHz.min, fMax(band))) };
	}
	const rounded =
		Math.round(clamp(dbOf(vy), ABS_RANGES.gainDb.min, ABS_RANGES.gainDb.max) * 10) / 10;
	const gainDb = Object.is(rounded, -0) ? 0 : rounded;
	const freqHz = Math.round(clamp(freqOf(vx), ABS_RANGES.freqHz.min, fMax({ ...band, gainDb })));
	return { freqHz, gainDb };
}

/**
 * Keyboard steps of the mock: ←/→ 1/24 octave, ↑/↓ 1 dB, PgUp/PgDn Q 0.1; Shift ×10, Alt ×0.1.
 * Frequencies stay inside `freqMax` of the band in `context` (20 kHz outside Engenharia).
 */
export function keyTarget(
	key: string,
	band: Band,
	modifiers: { shiftKey: boolean; altKey: boolean },
	context: FreqContext = {}
): { freqHz?: number; gainDb?: number; qFactor?: number } | null {
	if (band.kind === 'OFF') return null;
	const scale = modifiers.shiftKey ? 10 : modifiers.altKey ? 0.1 : 1;
	switch (key) {
		case 'ArrowLeft':
		case 'ArrowRight': {
			const dir = key === 'ArrowRight' ? 1 : -1;
			let freqHz = Math.round(band.freqHz * 2 ** ((dir * scale) / 24));
			if (freqHz === band.freqHz) freqHz += dir;
			// A band already above this context's top (shown, not editable) is not pulled down here.
			const top = Math.max(freqMax(band, context), Math.min(band.freqHz, ULTRA_MAX_HZ));
			return { freqHz: clamp(freqHz, ABS_RANGES.freqHz.min, top) };
		}
		case 'ArrowUp':
		case 'ArrowDown': {
			if (!hasGain(band)) return null;
			const gainDb = Math.round((band.gainDb + (key === 'ArrowUp' ? 1 : -1) * scale) * 10) / 10;
			return { gainDb: clamp(gainDb, ABS_RANGES.gainDb.min, ABS_RANGES.gainDb.max) };
		}
		case 'PageUp':
		case 'PageDown':
			return { qFactor: stepQ(band.qFactor, key === 'PageUp' ? 1 : -1, scale) };
		default:
			return null;
	}
}

/** Q after one wheel/key step (0.1 × scale), on the 0.01 grid and inside the absolute range. */
export function stepQ(q: number, direction: 1 | -1, scale = 1): number {
	const next = Math.round((q + direction * 0.1 * scale) * 100) / 100;
	return clamp(next, ABS_RANGES.qFactor.min, ABS_RANGES.qFactor.max);
}
