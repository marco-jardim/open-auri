import { dbScale, linePath, logScale } from '#lib/charts/scales.ts';
import { GRID } from './comparison.ts';

export interface PlotLine {
	name: string;
	values: readonly number[];
	color: string;
	dashed?: boolean;
}
export const plotX = logScale(20, 20000, 58, 958);
export function plotRange(lines: readonly PlotLine[]): number {
	return Math.max(
		15,
		Math.ceil(Math.max(0, ...lines.flatMap((line) => line.values.map(Math.abs))) / 5) * 5
	);
}
export function plotPath(values: readonly number[], range: number): string {
	const y = dbScale(-range, range, 250, 20);
	return linePath(values.map((value, index) => ({ x: plotX(GRID[index]), y: y(value) })));
}
