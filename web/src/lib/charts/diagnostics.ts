import { curveResponseDb, GRID } from 'open-auri/dsp';
import type { Curve } from './response.ts';
import { linePath, logScale } from './scales.ts';

/** A row is signed fit-minus-target error, never generated decorative data. */
export function errorHeatGeometry(
	rows: readonly (readonly number[])[],
	grid: readonly number[] = GRID,
	width = 720,
	rowHeight = 28,
	limitDb = 6
) {
	if (!(limitDb > 0) || rows.some((row) => row.length !== grid.length)) {
		throw new RangeError('Heat map requires one value per grid frequency');
	}
	const x = logScale(20, 20000, 0, width);
	return rows.flatMap((row, rowIndex) =>
		row.map((errorDb, i) => {
			const left = i === 0 ? 0 : (x(grid[i - 1]) + x(grid[i])) / 2;
			const right = i === grid.length - 1 ? width : (x(grid[i]) + x(grid[i + 1])) / 2;
			return {
				x: left,
				y: rowIndex * rowHeight,
				width: right - left,
				height: rowHeight,
				errorDb,
				freqHz: grid[i],
				row: rowIndex,
				intensity: Number.isFinite(errorDb) ? Math.min(1, Math.abs(errorDb) / limitDb) : 0
			};
		})
	);
}

export function curveErrors(
	curve: Curve,
	targetDb: readonly number[],
	grid: readonly number[] = GRID
) {
	if (targetDb.length !== grid.length) throw new RangeError('Target must match grid');
	return curveResponseDb(curve, grid).map((db, i) => db - targetDb[i]);
}

/** A measured trace, or a frequency-response residual; no synthetic waveform. */
export function wiggleGeometry(values: readonly number[], width = 720, height = 100, range = 1) {
	if (!(range > 0 && Number.isFinite(range))) throw new RangeError('Invalid trace range');
	const points = values.map((value, i) => ({
		x: values.length < 2 ? width / 2 : (i * width) / (values.length - 1),
		y: height / 2 - Math.max(-1, Math.min(1, value / range)) * (height / 2 - 2)
	}));
	return { path: linePath(points), baseline: height / 2 };
}
