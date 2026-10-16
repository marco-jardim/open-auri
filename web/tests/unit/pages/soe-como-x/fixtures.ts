import { vi } from 'vitest';
import { GRID, snapshotBands } from 'open-auri/dsp';
import { NEUTRO } from 'open-auri/catalog';
import type { AutoEqEntry } from '#lib/data/autoeq.ts';
import type { AutoEqClient, FitResult } from '#lib/components/pages/soe-como-x/model.ts';

export const CSV = 'frequency,raw\n20,4\n1000,0\n20000,-3';
export const measurement: AutoEqEntry = {
	id: 'example-iem',
	name: 'Example IEM',
	brand: 'Example',
	source: 'Independent lab',
	type: 'iem',
	pack: 'measurements-lab-000.bin',
	offset: 0
};
export const targetEntries: AutoEqEntry[] = [
	'Harman in-ear 2019',
	'Harman over-ear 2018',
	'Diffuse field 5128'
].map((name, i) => ({
	...measurement,
	id: `target-${i}`,
	name,
	source: 'AutoEq targets',
	type: 'target',
	pack: 'targets-000.bin'
}));

export function fakeDataClient(): AutoEqClient {
	return {
		loadIndex: vi.fn(async () => [measurement, ...targetEntries]),
		loadEntry: vi.fn(async () => ({ frequencies: GRID, values: GRID.map(() => 0) })),
		getAttribution: vi.fn(async (entry: AutoEqEntry | string) => ({
			name: typeof entry === 'string' ? entry : entry.source,
			measurements: 1,
			attribution: 'Independent measurement source; AutoEq MIT',
			link: 'https://github.com/jaakkopasanen/AutoEq'
		}))
	};
}

export function fitResult(): FitResult {
	return {
		bands: snapshotBands(NEUTRO.bands).map((band) => ({ ...band })),
		preampDb: NEUTRO.preampDb,
		rmsDb: 0,
		loss: 0,
		iterations: 0,
		elapsedMs: 1,
		stopReason: 'flat',
		gate: { ok: true, reasons: [] }
	};
}
