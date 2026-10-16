import { afterEach, describe, expect, test, vi } from 'vitest';
import { gateForWrite } from 'open-auri/safety';
import { encodePayload, snapshotBands } from 'open-auri/dsp';
import { createSolverWorker } from '#lib/workers/solver-client.ts';
import { createGateWorker } from '#lib/workers/gate-client.ts';
import { initialTracks } from '#lib/components/pages/comparar/comparison.ts';
import { solveBlend } from '#lib/components/pages/comparar/blend.ts';

const solver = createSolverWorker({ worker: false });
const gate = createGateWorker({ worker: false });
afterEach(() => vi.restoreAllMocks());

describe('gate-validated C3 blend', () => {
	for (const percent of [0, 25, 50, 100, 150]) {
		test(`${percent}% returns ten gate-valid PK/LS/OFF sections`, async () => {
			const [a, b, base] = initialTracks();
			const result = await solveBlend(
				{ a: a.curve, b: b.curve, base: base.curve, percent, preampDb: null, name: 'C3' },
				solver,
				gate
			);
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error('Expected a valid solver result');
			expect(result.curve.bands).toHaveLength(10);
			expect(result.curve.bands.every((band) => ['PK', 'LS', 'OFF'].includes(band.kind))).toBe(
				true
			);
			expect(gateForWrite(result.curve.bands, result.curve.preampDb).ok).toBe(true);
			expect(Number.isFinite(result.rmsDb)).toBe(true);
		}, 15000);
	}

	test('base=A, 100% preserves exact B bytes and still runs the final gate', async () => {
		const [a, b] = initialTracks();
		const commit = vi.spyOn(gate, 'commit');
		const result = await solveBlend(
			{ a: a.curve, b: b.curve, base: a.curve, percent: 100, preampDb: null, name: 'Exact' },
			solver,
			gate
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('Expected exact result');
		expect(encodePayload(result.curve.bands, result.curve.preampDb)).toEqual(
			encodePayload(b.curve.bands, b.curve.preampDb)
		);
		expect(commit).toHaveBeenCalledOnce();
	});

	test('manual unsafe preamp returns explicit gate refusal, never a usable curve', async () => {
		const [a, b] = initialTracks();
		const result = await solveBlend(
			{ a: a.curve, b: b.curve, base: a.curve, percent: 100, preampDb: 0, name: 'Refused' },
			solver,
			gate
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('Unsafe preamp must not pass');
		expect(result.reasons.some((reason) => reason.code === 'g:preamp')).toBe(true);
		expect('curve' in result).toBe(false);
	});

	test('missing/nonfinite manual preamp is a refusal, not silent automatic mode', async () => {
		const [a, b] = initialTracks();
		const result = await solveBlend(
			{ a: a.curve, b: b.curve, base: a.curve, percent: 100, preampDb: NaN, name: 'Refused' },
			solver,
			gate
		);
		expect(result).toMatchObject({ ok: false, reasons: [{ code: 'g:preamp' }] });
	});

	test('nontrivial blends really call the worker and do not mutate source curves', async () => {
		const [a, b, base] = initialTracks();
		const original = snapshotBands(base.curve.bands);
		const solve = vi.spyOn(solver, 'solve');
		await solveBlend(
			{ a: a.curve, b: b.curve, base: base.curve, percent: 75, preampDb: null, name: 'Worker' },
			solver,
			gate
		);
		expect(solve).toHaveBeenCalledWith({
			options: expect.objectContaining({ maxBands: 10, layer: 'ajustar', allowExperimental: false })
		});
		expect(base.curve.bands).toEqual(original);
	});
});
