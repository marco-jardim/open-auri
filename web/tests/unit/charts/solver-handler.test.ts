import { afterEach, expect, it, vi } from 'vitest';
import * as solver from 'open-auri/solver';
import { gateForWrite } from 'open-auri/safety';
import { handleSolverRequest } from '../../../src/lib/workers/solver-handler.ts';

vi.mock('open-auri/solver', async (importOriginal) => {
	const actual = await importOriginal<typeof import('open-auri/solver')>();
	return { ...actual, solvePeq: vi.fn(actual.solvePeq) };
});

afterEach(() => vi.clearAllMocks());

it('returns one spline response using the core interpolator', () => {
	const points = [
		{ freqHz: 20, gainDb: -3 },
		{ freqHz: 20000, gainDb: 2 }
	];
	const grid = [20, 200, 2000, 20000];
	const response = handleSolverRequest({ type: 'target', id: 8, points, grid });
	if (response.type !== 'target') throw new Error('Expected target');
	expect(response).toEqual({
		type: 'target',
		id: 8,
		target: solver.targetFromPoints(points, grid)
	});
});

it('wraps solvePeq and passes maxTimeMs through without introducing progress events', () => {
	const spy = vi.mocked(solver.solvePeq);
	const options = { target: [0, 0, 0], grid: [20, 1000, 20000], maxTimeMs: 37, maxIterations: 1 };
	const response = handleSolverRequest({ type: 'solve', id: 12, options });
	if (response.type !== 'solve') throw new Error('Expected solve');
	expect(spy).toHaveBeenCalledExactlyOnceWith(options);
	expect(response.id).toBe(12);
	expect(gateForWrite(response.result.bands, response.result.preampDb).ok).toBe(true);
	expect(response.result.stopReason).toBe('flat');
});

it('accepts drawn points and derives the target on the requested solver grid', () => {
	const points = [
		{ freqHz: 20, gainDb: 0 },
		{ freqHz: 20000, gainDb: 0 }
	];
	const spy = vi.mocked(solver.solvePeq);
	const response = handleSolverRequest({
		type: 'solve',
		id: 3,
		points,
		options: { grid: [20, 1000, 20000], maxTimeMs: 11 }
	});
	expect(spy).toHaveBeenCalledWith({
		grid: [20, 1000, 20000],
		target: [0, 0, 0],
		maxTimeMs: 11
	});
	expect(response.type).toBe('solve');
});
