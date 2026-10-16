import { curveResponseDb, designSection, GRID } from 'open-auri/dsp';
import { dbScale, linePath, logScale, RESPONSE_BOX, type PlotBox } from './scales.ts';

export type Band = Parameters<typeof designSection>[0];
export interface Curve {
	bands: readonly Band[];
	preampDb: number;
}

/** All response evaluation lives in core. These functions only project samples. */
export function responseGeometry(
	curve: Curve,
	box: PlotBox = RESPONSE_BOX,
	minDb = -24,
	maxDb = 12,
	grid: readonly number[] = GRID
) {
	const x = logScale(20, 20000, box.left, box.left + box.width);
	const y = dbScale(minDb, maxDb, box.top + box.height, box.top);
	const eq = curveResponseDb({ bands: curve.bands, preampDb: 0 }, grid);
	const output = curveResponseDb(curve, grid);
	const project = (values: readonly number[]) =>
		linePath(
			values.map((db, i) => ({
				x: x(grid[i]),
				y: y(Math.max(minDb, Math.min(maxDb, db)))
			}))
		);
	return { grid, eq, output, eqPath: project(eq), outputPath: project(output), x, y };
}

export function miniCurvePath(curve: Curve, width = 120, height = 32, minDb = -24, maxDb = 12) {
	return responseGeometry(
		curve,
		{ left: 1, top: 1, width: width - 2, height: height - 2 },
		minDb,
		maxDb
	).outputPath;
}
