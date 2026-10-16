import { describe, expect, test, vi } from 'vitest';
import { gateForWrite } from 'open-auri/safety';
import {
	handleGateRequest,
	type CommitResult,
	type DragResult
} from '#lib/workers/gate-handler.ts';
import {
	commitBand,
	dragBand,
	isAbortError,
	moveBand,
	type GateClient
} from '#lib/components/pages/curva/drag.ts';
import type { Band, Curve } from '#lib/components/pages/curva/model.ts';

const OFF: Band = { kind: 'OFF' };
const curveWith = (band: Band, preampDb = -6): Curve => ({
	bands: [band, ...Array.from({ length: 9 }, () => OFF)],
	preampDb
});

/** Synchronous fake worker client backed by the real pure handler. */
function handlerClient(): GateClient & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async drag(input) {
			calls.push(`drag:${input.param}`);
			const response = handleGateRequest({ ...input, type: 'drag', id: calls.length });
			if (response.type !== 'drag') throw new Error('unexpected');
			return response;
		},
		async commit(input) {
			calls.push('commit');
			const response = handleGateRequest({ ...input, type: 'commit', id: calls.length });
			if (response.type !== 'commit') throw new Error('unexpected');
			return response;
		}
	};
}

describe('gate-bounded drag', () => {
	test('a boost past the envelope stops at the boundary, with reasons, rounded and committed', async () => {
		const client = handlerClient();
		const start = curveWith({ kind: 'PK', freqHz: 15000, gainDb: 3, qFactor: 1 });
		const result = await moveBand(client, start, 0, { gainDb: 9.2 }, false);
		expect(result.stopped).toBe(true);
		expect(result.committed).toBe(true);
		expect(result.reasons.length).toBeGreaterThan(0);
		const band = result.bands[0];
		expect(band?.kind).toBe('PK');
		if (band?.kind !== 'PK') return;
		expect(band.gainDb).toBeGreaterThan(3);
		expect(band.gainDb).toBeLessThan(9.2);
		expect(Math.round(band.gainDb * 10) / 10).toBeCloseTo(band.gainDb, 10);
		expect(gateForWrite(result.bands, result.preampDb).ok).toBe(true);
		expect(client.calls).toEqual(['drag:gainDb', 'commit']);
	});

	test('an accepted move reaches the target and rounds f to 1 Hz and Q to 0.01', async () => {
		const client = handlerClient();
		const start = curveWith({ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 });
		const result = await moveBand(client, start, 0, { freqHz: 1234, qFactor: 1.5 }, false);
		expect(result.stopped).toBe(false);
		expect(result.committed).toBe(true);
		expect(result.bands[0]).toMatchObject({ kind: 'PK', freqHz: 1234, qFactor: 1.5, gainDb: -3 });
		expect(client.calls).toEqual(['drag:freqHz', 'drag:qFactor', 'commit']);
	});

	test('the advisory drag stops at the first refused parameter and never commits', async () => {
		const reasons: DragResult['reasons'] = [{ code: 'e:output-audible' }];
		const start = curveWith({ kind: 'PK', freqHz: 1000, gainDb: 0.5, qFactor: 1 });
		const stoppedBands = curveWith({ kind: 'PK', freqHz: 1000, gainDb: 2, qFactor: 1 }).bands;
		const client: GateClient = {
			drag: vi.fn(async (input: Parameters<GateClient['drag']>[0]): Promise<DragResult> => ({
				type: 'drag',
				id: 1,
				value: 2,
				bands: input.param === 'gainDb' ? stoppedBands : input.bands,
				verdict: gateForWrite(stoppedBands, -6),
				requiresCommit: true,
				firstRefused: input.param === 'gainDb' ? { value: 2.1, reasons } : null,
				reasons: input.param === 'gainDb' ? reasons : []
			})),
			commit: vi.fn()
		};
		const result = await dragBand(client, start, 0, { gainDb: 8, qFactor: 3 }, false);
		expect(result.stopped).toBe(true);
		expect(result.reasons).toEqual(reasons);
		expect(result.bands[0]).toMatchObject({ gainDb: 2 });
		expect(client.drag).toHaveBeenCalledTimes(1);
		expect(client.commit).not.toHaveBeenCalled();
	});

	test('a full-grid commit refusal keeps the original curve and reports why', async () => {
		const start = curveWith({ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 });
		const refusedVerdict = { ...gateForWrite(start.bands, start.preampDb), ok: false };
		const client: GateClient = {
			drag: vi.fn(),
			commit: vi.fn(async (): Promise<CommitResult> => ({
				type: 'commit',
				id: 1,
				verdict: { ...refusedVerdict, reasons: [{ code: 'd:prefix-peak', stage: 1 }] }
			}))
		};
		const moved = {
			bands: curveWith({ kind: 'PK', freqHz: 1000, gainDb: 1.23, qFactor: 1 }).bands.slice(),
			preampDb: -6,
			stopped: false,
			reasons: [],
			committed: false
		};
		const result = await commitBand(client, start, moved, 0, false);
		expect(result.committed).toBe(false);
		expect(result.stopped).toBe(true);
		expect(result.bands).toEqual(start.bands);
		expect(result.reasons).toEqual([{ code: 'd:prefix-peak', stage: 1 }]);
		// The committed candidate was already rounded to the 0.1 dB grid.
		const sent = vi.mocked(client.commit).mock.calls[0]?.[0];
		expect(sent?.bands[0]).toMatchObject({ gainDb: 1.2 });
	});

	test('superseded requests are recognised as aborts', () => {
		expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
		expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
		expect(isAbortError(new Error('boom'))).toBe(false);
	});
});
