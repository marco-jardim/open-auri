/**
 * Miniature response paths for the preset cards and the filter-bank strips. They come from the same
 * core per-section responses as the scope (`bandResponse`), on a coarse log grid: a thumbnail of the
 * real curve, never a drawing.
 */
import type { Band } from './model.ts';
import { bandResponse, F_MAX, F_MIN } from './scope.ts';

const POINTS = 48;
export const MINI_GRID: readonly number[] = Object.freeze(
	Array.from({ length: POINTS }, (_, i) => F_MIN * (F_MAX / F_MIN) ** (i / (POINTS - 1)))
);

/** Sum of the sections' responses in dB on `MINI_GRID` (preamp excluded: the shape, not the level). */
export function miniResponse(bands: readonly Band[]): number[] {
	const sum = new Array<number>(MINI_GRID.length).fill(0);
	for (const band of bands) {
		const response = bandResponse(band, MINI_GRID);
		if (!response) continue;
		for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] ?? 0) + (response[i] ?? 0);
	}
	return sum;
}

/** SVG path of `bands` in a `width` × `height` box, ±`rangeDb` around the vertical middle. */
export function miniPath(bands: readonly Band[], width = 100, height = 20, rangeDb = 12): string {
	const values = miniResponse(bands);
	const half = height / 2;
	return values
		.map((db, i) => {
			const x = (i / (values.length - 1)) * width;
			const clamped = Number.isFinite(db) ? Math.max(-rangeDb, Math.min(rangeDb, db)) : 0;
			const y = half - (clamped / rangeDb) * half;
			return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
		})
		.join('');
}
