import { describe, expect, test, vi } from 'vitest';
import { OFFICIAL_PRESETS } from 'open-auri/catalog';
import { curveResponseDb, GRID } from 'open-auri/dsp';
import { normalize } from 'open-auri/io';
import { gateForWrite } from 'open-auri/safety';
import { targetFromPoints } from 'open-auri/solver';
import { searchEntries } from '#lib/data/autoeq.ts';
import {
	autoEqTrace,
	buildSolverRequest,
	csvTrace,
	drawnTarget,
	initialStation,
	INITIAL_POINTS,
	presetTarget,
	resultCurve,
	solveStation,
	stationTransition
} from '#lib/components/pages/soe-como-x/model.ts';
import { CSV, fakeDataClient, fitResult, measurement, targetEntries } from './fixtures.ts';

function readyState() {
	let state = initialStation();
	state = stationTransition(state, { type: 'measurement', trace: csvTrace(CSV, 'Measured') });
	return stationTransition(state, {
		type: 'target',
		trace: drawnTarget(INITIAL_POINTS, 'Drawn')
	});
}

describe('four-station state machine', () => {
	test('requires measurement and target before solving; edits invalidate results', () => {
		const initial = initialStation();
		expect(initial.phase).toBe('measurement');
		expect(stationTransition(initial, { type: 'start' })).toBe(initial);
		const measured = stationTransition(initial, {
			type: 'measurement',
			trace: csvTrace(CSV, 'Measured')
		});
		expect(measured.phase).toBe('target');
		expect(stationTransition(measured, { type: 'start' })).toBe(measured);
		const ready = readyState();
		expect(ready.phase).toBe('correction');
		const solving = stationTransition(ready, { type: 'start' });
		expect(solving.phase).toBe('solving');
		expect(stationTransition(solving, { type: 'start' })).toBe(solving);
		const done = stationTransition(solving, {
			type: 'result',
			revision: solving.revision,
			result: fitResult()
		});
		expect(done.phase).toBe('result');
		const edited = stationTransition(done, {
			type: 'controls',
			controls: { ...done.controls, speed: 100 }
		});
		expect(edited.phase).toBe('correction');
		expect(edited.result).toBeNull();
		expect(resultCurve(edited, 'Not ready')).toBeNull();
		expect(stationTransition(edited, { type: 'measurement', trace: null }).phase).toBe(
			'measurement'
		);
	});

	test('target may come first; stale results and errors cannot replace newer inputs', () => {
		const targeted = stationTransition(initialStation(), {
			type: 'target',
			trace: drawnTarget(INITIAL_POINTS, 'Drawn')
		});
		expect(targeted.phase).toBe('measurement');
		const old = stationTransition(readyState(), { type: 'start' });
		const changed = stationTransition(old, { type: 'target', trace: presetTarget('padrao') });
		const next = stationTransition(changed, { type: 'start' });
		expect(
			stationTransition(next, {
				type: 'result',
				revision: old.revision,
				result: fitResult()
			})
		).toBe(next);
		expect(
			stationTransition(next, {
				type: 'error',
				revision: old.revision,
				error: 'late failure'
			})
		).toBe(next);
	});
});

describe('target construction uses core algorithms', () => {
	test('every official preset target is its normalized curveResponseDb', () => {
		for (const preset of OFFICIAL_PRESETS) {
			expect(presetTarget(preset.id).values).toEqual(normalize(curveResponseDb(preset), GRID));
		}
		expect(() => presetTarget('unknown')).toThrow('preset:unknown');
	});

	test('C2 uses the monotone log spline, without mutating points', () => {
		const points = INITIAL_POINTS.map((point, i) => ({ ...point, gainDb: i - 3 }));
		const before = structuredClone(points);
		expect(drawnTarget(points, 'C2').values).toEqual(normalize(targetFromPoints(points), GRID));
		expect(points).toEqual(before);
	});

	test('CSV resamples and normalizes; missing coverage and invalid values are refused', () => {
		const trace = csvTrace(CSV, 'User CSV');
		expect(trace.kind).toBe('csv');
		expect(trace.values).toHaveLength(GRID.length);
		expect(trace.values[0]).toBeCloseTo(4);
		expect(trace.values.at(-1)).toBeCloseTo(-3);
		expect(() => csvTrace('frequency,raw\n100,0\n1000,1', 'Short')).toThrow();
		expect(() => csvTrace('frequency,raw\n20,NaN\n20000,0', 'Invalid')).toThrow();
	});

	test('AutoEq measurement and all three target examples preserve source attribution', async () => {
		const client = fakeDataClient();
		for (const entry of [measurement, ...targetEntries]) {
			const trace = await autoEqTrace(client, entry);
			expect(trace.kind).toBe('autoeq');
			expect(trace.credit?.source).toBe(entry.source);
			expect(trace.credit?.link).toMatch(/^https:/);
			expect(trace.values).toEqual(GRID.map(() => 0));
		}
		for (const query of ['Example', 'IEM', 'Independent lab']) {
			expect(searchEntries(await client.loadIndex(), query)[0]).toEqual(measurement);
		}
	});

	test('manifest failure preserves credit; missing packs reject; CSV still works', async () => {
		const client = fakeDataClient();
		vi.mocked(client.getAttribution).mockRejectedValue(new Error('offline'));
		expect((await autoEqTrace(client, measurement)).credit?.source).toBe(measurement.source);
		vi.mocked(client.loadEntry).mockRejectedValue(new Error('HTTP 404'));
		await expect(autoEqTrace(client, measurement)).rejects.toThrow('HTTP 404');
		expect(csvTrace(CSV, 'Offline CSV').values).toHaveLength(GRID.length);
	});
});

describe('worker boundary', () => {
	test('builds a cloneable request with D4, D5, speed, bounds and no experimental filters', () => {
		const state = readyState();
		const request = buildSolverRequest(state);
		expect(request).toEqual(structuredClone(request));
		if (!('options' in request) || !request.options) throw new Error('Missing options');
		expect(request.options).toMatchObject({
			speed: 65,
			weights: 'iso226',
			phon: 60,
			d5Weight: 0.005,
			maxBands: 10,
			allowExperimental: false,
			layer: 'ajustar',
			maxIterations: 400
		});
		expect(request.options.measurement).not.toBe(state.measurement?.values);
		const changed = stationTransition(state, {
			type: 'controls',
			controls: { speed: 0, iso: false, d5Weight: 0 }
		});
		expect(buildSolverRequest(changed)).toMatchObject({
			options: { speed: 0, weights: 'flat', d5Weight: 0 }
		});
		expect(() => buildSolverRequest(initialStation())).toThrow('solver:missing-input');
		for (const speed of [-1, 101, NaN]) {
			expect(() =>
				buildSolverRequest({ ...state, controls: { ...state.controls, speed } })
			).toThrow();
		}
	});

	test('fake worker result is gated and cloned for the editor, without writing', async () => {
		const result = fitResult();
		const worker = { solve: vi.fn(async () => ({ result })) };
		const state = stationTransition(readyState(), { type: 'start' });
		const event = await solveStation(state, worker);
		expect(worker.solve).toHaveBeenCalledWith(buildSolverRequest(state));
		const done = stationTransition(state, event);
		const curve = resultCurve(done, 'Sound like X');
		expect(done.phase).toBe('result');
		expect(curve?.source).toBe('custom');
		expect(curve?.bands).not.toBe(result.bands);
		expect(gateForWrite(result.bands, result.preampDb).ok).toBe(true);
	});

	test('fake worker errors and invalid results leave no usable curve; retry works', async () => {
		const state = stationTransition(readyState(), { type: 'start' });
		const worker = { solve: vi.fn().mockRejectedValue(new Error('worker crashed')) };
		const failed = stationTransition(state, await solveStation(state, worker));
		expect(failed.phase).toBe('error');
		expect(failed.error).toBe('worker crashed');
		expect(resultCurve(failed, 'Rejected')).toBeNull();
		expect(stationTransition(failed, { type: 'start' }).phase).toBe('solving');
		const invalid = fitResult();
		Reflect.set(invalid.gate, 'ok', false);
		expect(
			stationTransition(state, {
				type: 'result',
				revision: state.revision,
				result: invalid
			}).phase
		).toBe('error');
	});
});
