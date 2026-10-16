import { expect, test } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { gateForWrite } from 'open-auri/safety';
import { createGateWorker } from '../../../src/lib/workers/gate-client.ts';
import { createSolverWorker } from '../../../src/lib/workers/solver-client.ts';

test('Vite module gate worker returns an advisory drag and a full commit', async () => {
	const client = createGateWorker();
	try {
		const bands = [
			{ kind: 'PK', freqHz: 1000, gainDb: 2, qFactor: 1 } as const,
			...NEUTRO.bands.slice(1)
		];
		const dragged = await client.drag({
			bands,
			preampDb: -12,
			bandIndex: 0,
			param: 'gainDb',
			from: 2,
			to: 24
		});
		expect(dragged.verdict.metrics.grid).toBe('drag');
		expect(dragged.reasons.length).toBeGreaterThan(0);
		const committed = await client.commit({ bands: dragged.bands, preampDb: -12 });
		expect(committed.verdict.metrics.grid).toBe('full');
		expect(gateForWrite(dragged.bands, -12).ok).toBe(true);
	} finally {
		client.dispose();
	}
});

test('Vite module solver worker supports drawn targets and solve responses', async () => {
	const client = createSolverWorker();
	try {
		const points = [
			{ freqHz: 20, gainDb: 0 },
			{ freqHz: 20000, gainDb: 0 }
		];
		const target = await client.target({ points, grid: [20, 1000, 20000] });
		expect(target.target).toEqual([0, 0, 0]);
		const response = await client.solve({ points, options: { maxTimeMs: 20, maxIterations: 1 } });
		expect(response.result.gate.ok).toBe(true);
	} finally {
		client.dispose();
	}
});
