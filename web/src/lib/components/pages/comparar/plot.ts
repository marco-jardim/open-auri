import { dbScale, linePath, logScale } from '#lib/charts/scales.ts';
import { GRID } from './comparison.ts';

export interface PlotLine {
	name: string;
	values: readonly number[];
	color: string;
	dashed?: boolean;
}
/**
 * The gate's output ceiling between 20 Hz and 20 kHz (reason e, spec §4.3): the overlay draws it
 * as the output limit line. Display only; the gate itself stays the single authority.
 */
export const OUTPUT_LIMIT_DB = -0.47;
/** Overlay scale of the mock (±15 dB); anything beyond is clipped at the frame, never rescaled. */
export const OVERLAY_RANGE_DB = 15;
export const plotX = logScale(20, 20000, 58, 958);
export function plotRange(lines: readonly PlotLine[]): number {
	return Math.max(
		15,
		Math.ceil(Math.max(0, ...lines.flatMap((line) => line.values.map(Math.abs))) / 5) * 5
	);
}
export function plotY(value: number, range: number): number {
	return dbScale(-range, range, 250, 20)(value);
}
export function plotPath(values: readonly number[], range: number): string {
	const y = dbScale(-range, range, 250, 20);
	return linePath(values.map((value, index) => ({ x: plotX(GRID[index]), y: y(value) })));
}
/** Highest point over every line: where the output gets closest to (or past) the ceiling. */
export function plotPeak(lines: readonly PlotLine[]): { db: number; hz: number } | null {
	let db = -Infinity;
	let hz = 0;
	for (const line of lines) {
		for (let index = 0; index < line.values.length; index++) {
			const value = line.values[index];
			if (Number.isFinite(value) && value > db) {
				db = value;
				hz = GRID[index];
			}
		}
	}
	return Number.isFinite(db) ? { db, hz } : null;
}
/** dB ticks for a symmetric range: every 5 dB up to ±20, every 10 dB beyond. */
export function plotTicks(range: number): number[] {
	const step = range <= 20 ? 5 : 10;
	const ticks: number[] = [];
	for (let value = -range; value <= range; value += step) ticks.push(value);
	return ticks;
}
export const PLOT_FREQUENCIES = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000] as const;
