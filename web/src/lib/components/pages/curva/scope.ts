/**
 * Geometry and cheap curve analysis for the Curva oscilloscope (pure, no DOM).
 *
 * - Plot space follows the v2 mock: 820 × 380 viewBox, 20 Hz to 20 kHz (log), ±15 dB.
 * - Responses come from core (`curveResponseDb`, one call per section, summed in dB, which is
 *   exactly how core sums a cascade). Nothing here designs or evaluates a biquad.
 * - The prefix (internal) and output peaks are a drawing preview on a coarse grid. They show WHERE
 *   a curve gets close to or over the limits while a handle moves; the gate (full grid, worker)
 *   still decides every commit and write.
 * - Safe boxes come from SOFT_RANGES (conservative single-section boxes) and the hard limits from
 *   ABS_RANGES and the D7 rules of core policy.
 */
import { curveResponseDb, logGrid } from 'open-auri/dsp';
import { ABS_RANGES, SOFT_RANGES, THRESHOLDS } from 'open-auri/safety';
import { hasGain, type Band, type Curve } from './model.ts';

export const VIEW_WIDTH = 820;
export const VIEW_HEIGHT = 380;
export const PLOT = { left: 66, right: 790, top: 26, bottom: 346 } as const;
export const DB_MIN = -15;
export const DB_MAX = 15;
export const F_MIN = 20;
export const F_MAX = 20000;
/** Output limit drawn on the scope (the gate's audible output threshold). */
export const OUTPUT_LIMIT_DB = THRESHOLDS.outputAudibleDb;
/** Internal (prefix) limit: clipping inside the chain. */
export const INTERNAL_LIMIT_DB = THRESHOLDS.internalAudibleDb;
/** How close to a limit counts as "near" (amber) on the scope. */
export const NEAR_MARGIN_DB = 1;

/** Drawing grid: coarser than core's analysis GRID, enough for a smooth trace on every frame. */
export const SCOPE_GRID: readonly number[] = Object.freeze(logGrid(193, F_MIN, F_MAX));

const span = PLOT.right - PLOT.left;
const height = PLOT.bottom - PLOT.top;

export const xOf = (freqHz: number): number => PLOT.left + (Math.log10(freqHz / F_MIN) / 3) * span;
export const freqOf = (x: number): number => F_MIN * 1000 ** ((x - PLOT.left) / span);
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

/** One section's response in dB on `grid`, or null for OFF and bands core cannot evaluate. */
export function bandResponse(band: Band, grid: readonly number[] = SCOPE_GRID): number[] | null {
	if (band.kind === 'OFF') return null;
	try {
		return curveResponseDb({ bands: [band], preampDb: 0 }, grid);
	} catch (error) {
		// Core validates the band (range/type errors); such a band simply has no trace.
		if (error instanceof RangeError || error instanceof TypeError) return null;
		throw error;
	}
}

export interface Traces {
	/** Per section (wire order); null for OFF or unevaluable sections. */
	bands: (number[] | null)[];
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

/** SVG path of a response on `grid` (values clamped far outside the plot; the clip crops). */
export function pathOf(values: readonly number[], grid: readonly number[] = SCOPE_GRID): string {
	let d = '';
	for (let i = 0; i < values.length; i++) {
		const f = grid[i];
		const v = values[i];
		if (f === undefined || v === undefined || !Number.isFinite(v)) continue;
		d += `${d ? 'L' : 'M'}${xOf(f).toFixed(1)} ${yOf(clamp(v, -60, 60)).toFixed(1)}`;
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

/** Path of `values` restricted to one span (to stroke the part of a trace that is over). */
export function segmentPath(
	values: readonly number[],
	from: number,
	to: number,
	grid: readonly number[] = SCOPE_GRID
): string {
	let d = '';
	for (let i = 0; i < values.length; i++) {
		const f = grid[i];
		const v = values[i];
		if (f === undefined || v === undefined || f < from || f > to || !Number.isFinite(v)) continue;
		d += `${d ? 'L' : 'M'}${xOf(f).toFixed(1)} ${yOf(clamp(v, -60, 60)).toFixed(1)}`;
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

export type HardZoneKind = 'gain-cap' | 'pk-high-boost';
export interface HardZone extends Box {
	kind: HardZoneKind;
}

/** Where the handle of this section can never go (ABS_RANGES gain cap, D7 PK boost above 16 kHz). */
export function hardZones(band: Band): HardZone[] {
	if (band.kind === 'OFF' || !hasGain(band)) return [];
	const zones: HardZone[] = [
		{ kind: 'gain-cap', fMin: F_MIN, fMax: F_MAX, gMin: ABS_RANGES.gainDb.max, gMax: DB_MAX }
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
	return zones;
}

/** The handle's gain on the plot (LP/HP sit at 0 dB). */
export const handleGain = (band: Band): number => (hasGain(band) ? band.gainDb : 0);

/** Pointer position (viewBox units) to a target inside the absolute control ranges. */
export function pointerTarget(
	vx: number,
	vy: number,
	band: Band
): { freqHz: number; gainDb?: number } {
	const freqHz = Math.round(clamp(freqOf(vx), ABS_RANGES.freqHz.min, ABS_RANGES.freqHz.max));
	if (!hasGain(band)) return { freqHz };
	const gainDb =
		Math.round(clamp(dbOf(vy), ABS_RANGES.gainDb.min, ABS_RANGES.gainDb.max) * 10) / 10;
	return { freqHz, gainDb: Object.is(gainDb, -0) ? 0 : gainDb };
}

/** Keyboard steps of the mock: ←/→ 1/24 octave, ↑/↓ 1 dB, PgUp/PgDn Q 0.1; Shift ×10, Alt ×0.1. */
export function keyTarget(
	key: string,
	band: Band,
	modifiers: { shiftKey: boolean; altKey: boolean }
): { freqHz?: number; gainDb?: number; qFactor?: number } | null {
	if (band.kind === 'OFF') return null;
	const scale = modifiers.shiftKey ? 10 : modifiers.altKey ? 0.1 : 1;
	switch (key) {
		case 'ArrowLeft':
		case 'ArrowRight': {
			const dir = key === 'ArrowRight' ? 1 : -1;
			let freqHz = Math.round(band.freqHz * 2 ** ((dir * scale) / 24));
			if (freqHz === band.freqHz) freqHz += dir;
			return { freqHz: clamp(freqHz, ABS_RANGES.freqHz.min, ABS_RANGES.freqHz.max) };
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
