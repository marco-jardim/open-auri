import { describe, expect, it } from 'vitest';
import { OFFICIAL_PRESETS, NEUTRO } from 'open-auri/catalog';
import { gate, gateForWrite } from 'open-auri/safety';
import {
	handleGateRequest,
	type Band,
	type DragParam
} from '../../../src/lib/workers/gate-handler.ts';

const bands: readonly Band[] = Object.freeze([
	Object.freeze({ kind: 'PK', freqHz: 1000, gainDb: 2, qFactor: 1 } as const),
	...NEUTRO.bands.slice(1)
]);

describe('pure drag handler', () => {
	it('returns a snapped accepted boundary and reasons for the first refused candidate', () => {
		const result = handleGateRequest({
			type: 'drag',
			id: 10,
			bands,
			preampDb: -12,
			bandIndex: 0,
			param: 'gainDb',
			from: 2,
			to: 24
		});
		if (result.type !== 'drag') throw new Error('Expected drag');
		expect(result.id).toBe(10);
		expect(result.value).toBeLessThan(24);
		expect(result.value * 10).toBeCloseTo(Math.round(result.value * 10), 10);
		expect(result.verdict.metrics.grid).toBe('drag');
		expect(result.requiresCommit).toBe(true);
		expect(result.firstRefused?.value).toBe(24);
		expect(result.reasons.length).toBeGreaterThan(0);
		expect(gate(result.bands, -12).ok).toBe(true);
		expect(bands[0]).toEqual({ kind: 'PK', freqHz: 1000, gainDb: 2, qFactor: 1 });
	});

	it.each<[DragParam, number, number]>([
		['gainDb', 2, -24],
		['gainDb', 2, 9.2],
		['gainDb', 2, 30],
		['freqHz', 1000, 20],
		['freqHz', 1000, 20000],
		['freqHz', 1000, 0],
		['qFactor', 1, 0.1],
		['qFactor', 1, 4],
		['qFactor', 1, 20]
	])('always returns a gate-accepted %s boundary toward %s → %s', (param, from, to) => {
		const result = handleGateRequest({
			type: 'drag',
			id: 1,
			bands,
			preampDb: -12,
			bandIndex: 0,
			param,
			from,
			to
		});
		if (result.type !== 'drag') throw new Error('Expected drag');
		expect(result.verdict.ok).toBe(true);
		expect(gate(result.bands, -12, { grid: 'drag' }).ok).toBe(true);
		expect(gateForWrite(result.bands, -12).ok).toBe(true);
	});

	it('returns no refusal for an accepted endpoint', () => {
		const result = handleGateRequest({
			type: 'drag',
			id: 2,
			bands,
			preampDb: -12,
			bandIndex: 0,
			param: 'gainDb',
			from: 2,
			to: 3
		});
		if (result.type !== 'drag') throw new Error('Expected drag');
		expect(result.value).toBe(3);
		expect(result.firstRefused).toBeNull();
		expect(result.reasons).toEqual([]);
	});

	it('rejects invalid indices, nonfinite inputs and unaccepted starting curves', () => {
		const input = {
			type: 'drag',
			id: 1,
			bands,
			preampDb: -12,
			bandIndex: 0,
			param: 'gainDb',
			from: 2,
			to: 3
		} as const;
		expect(() => handleGateRequest({ ...input, bandIndex: 10 })).toThrow(RangeError);
		expect(() => handleGateRequest({ ...input, bandIndex: 1 })).toThrow(RangeError);
		expect(() => handleGateRequest({ ...input, to: NaN })).toThrow(RangeError);
		expect(() => handleGateRequest({ ...input, preampDb: 0 })).toThrow(/accepted/);
	});
});

describe('full commit handler', () => {
	it.each([...OFFICIAL_PRESETS, NEUTRO])('returns the full write verdict: $id', (curve) => {
		const result = handleGateRequest({ type: 'commit', ...curve, id: 100 });
		expect(result.type).toBe('commit');
		expect(result.verdict.metrics.grid).toBe('full');
		expect(result.verdict).toEqual(gateForWrite(curve.bands, curve.preampDb));
		expect(result.verdict.ok).toBe(true);
	});

	it('does not bypass experimental or output restrictions', () => {
		const hs: Band[] = [
			{ kind: 'HS', freqHz: 10000, gainDb: -2, qFactor: 0.7 },
			...NEUTRO.bands.slice(1)
		];
		const refused = handleGateRequest({ type: 'commit', id: 1, bands: hs, preampDb: -12 });
		const allowed = handleGateRequest({
			type: 'commit',
			id: 2,
			bands: hs,
			preampDb: -12,
			experimental: true
		});
		expect(refused.verdict.reasons.map((r) => r.code)).toContain('k:kind-not-allowed');
		expect(allowed.verdict.ok).toBe(true);
		expect(handleGateRequest({ type: 'commit', ...NEUTRO, id: 3, preampDb: 0 }).verdict.ok).toBe(
			false
		);
	});
});

describe('free preview commits (C1)', () => {
	const loud: readonly Band[] = [
		{ kind: 'PK', freqHz: 1000, gainDb: 12, qFactor: 1 },
		...NEUTRO.bands.slice(1)
	];

	it('marks a curve only the codec accepts as previewOnly, never as a plain accept', () => {
		const result = handleGateRequest({
			type: 'commit',
			id: 1,
			bands: loud,
			preampDb: -0.5,
			profile: 'codec'
		});
		if (result.type !== 'commit') throw new Error('Expected commit');
		expect(result.verdict.ok).toBe(false);
		expect(result.accepted).toBe(true);
		expect(result.previewOnly).toBe(true);
	});

	it('has no previewOnly outside the free preview or for gate-accepted curves', () => {
		for (const profile of ['standard', 'yolo'] as const) {
			const result = handleGateRequest({
				type: 'commit',
				id: 2,
				bands: loud,
				preampDb: -0.5,
				profile
			});
			if (result.type !== 'commit') throw new Error('Expected commit');
			expect(result.accepted).toBe(false);
			expect(result.previewOnly).toBeUndefined();
		}
		const fine = handleGateRequest({ type: 'commit', ...NEUTRO, id: 3, profile: 'codec' });
		if (fine.type !== 'commit') throw new Error('Expected commit');
		expect(fine.accepted).toBe(true);
		expect(fine.previewOnly).toBeUndefined();
	});
});
