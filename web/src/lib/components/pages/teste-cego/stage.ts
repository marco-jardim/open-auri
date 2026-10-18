/**
 * Pure helpers of the listening-room stage (Stage.svelte). The stage shows only real state: the
 * level comes from the preview's meter frames (pre-volume), the rail moves follow the test's own
 * swap, and a response curve is computed only once the result is revealed.
 */
import { curveResponseDb, logGrid } from 'open-auri/dsp';
import type { PreviewCurve } from '#lib/audio/engine.ts';
import type { MeterUpdate } from '#lib/audio/meters.ts';

/** Peak level (dBFS) at which a bay is dark; 0 dBFS is full light. */
export const LEVEL_FLOOR_DB = -48;
/** Reduced motion: the level is shown as one of these brightness steps (plus dark). */
export const LEVEL_STEPS = 4;

/**
 * Brightness 0..1 of the playing bay from a meter update: the louder PPM channel mapped from
 * `LEVEL_FLOOR_DB` to 0 dBFS. Null unless the update is live: no frame, no light.
 */
export function levelOf(update: MeterUpdate): number | null {
	const frame = update.mode === 'live' ? update.frame : null;
	if (!frame) return null;
	const peak = Math.max(frame.ppmL, frame.ppmR);
	if (!Number.isFinite(peak)) return 0;
	const level = (peak - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB;
	return Math.round(Math.min(1, Math.max(0, level)) * 1000) / 1000;
}

/** The brightness step (0, 1/steps … 1) that holds `level`; a quiet signal stays on step one. */
export function stepLevel(level: number, steps = LEVEL_STEPS): number {
	return Math.ceil(Math.min(1, Math.max(0, level)) * steps) / steps;
}

/**
 * Rail moves of the shuffle, one per cabinet: `shift` in bays and `far` for the cabinet that takes
 * the rear rail. The cabinets in use rotate by one place; they are identical, so the last frame
 * of the move looks exactly like the first and nothing tells which candidate went where.
 */
export function railMoves(count: number): readonly { shift: number; far: number }[] {
	return count >= 3
		? [
				{ shift: 1, far: 0 },
				{ shift: 1, far: 0 },
				{ shift: -2, far: 1 }
			]
		: [
				{ shift: 1, far: 0 },
				{ shift: -1, far: 1 },
				{ shift: 0, far: 0 }
			];
}

let sparkGrid: readonly number[] | null = null;

/**
 * Tiny response line of a revealed candidate (the sections' shape, preamp excluded) in a
 * `width` × `height` box, ±`rangeDb` around the middle. Null when the curve cannot be evaluated.
 */
export function sparkPath(
	curve: PreviewCurve,
	width = 96,
	height = 28,
	rangeDb = 12
): string | null {
	sparkGrid ??= Object.freeze(logGrid(40));
	let values: readonly number[];
	try {
		values = curveResponseDb({ bands: curve.bands, preampDb: 0 }, sparkGrid);
	} catch {
		return null;
	}
	if (values.length < 2) return null;
	const half = height / 2;
	return values
		.map((db, i) => {
			const x = (i / (values.length - 1)) * width;
			const clamped = Number.isFinite(db) ? Math.max(-rangeDb, Math.min(rangeDb, db)) : 0;
			const y = half - (clamped / rangeDb) * (half - 1);
			return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
		})
		.join('');
}
