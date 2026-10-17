import { afterEach, expect, test } from 'vitest';
import { prefetchUrl, warmGateWorker, warmSolverWorker } from '#lib/app/warm.ts';

afterEach(() => {
	for (const link of document.head.querySelectorAll('link[data-warm]')) link.remove();
});

const prefetches = () =>
	[...document.head.querySelectorAll<HTMLLinkElement>('link[rel="prefetch"][data-warm]')].map(
		(link) => new URL(link.href).pathname
	);

test('prefetchUrl adds one low-priority prefetch link per URL', () => {
	expect(prefetchUrl('/fux2/a.js')).toBe(true);
	expect(prefetchUrl('/fux2/a.js')).toBe(false);
	expect(prefetchUrl('/fux2/b.js')).toBe(true);
	expect(prefetches()).toEqual(['/fux2/a.js', '/fux2/b.js']);
});

test('worker warm-ups prefetch the bundled worker scripts and create no worker', async () => {
	const created: unknown[] = [];
	const NativeWorker = globalThis.Worker;
	globalThis.Worker = class extends NativeWorker {
		constructor(url: string | URL, options?: WorkerOptions) {
			super(url, options);
			created.push(url);
		}
	};
	try {
		const gate = await warmGateWorker();
		const solver = await warmSolverWorker();
		expect(gate).toMatch(/gate/);
		expect(solver).toMatch(/solver/);
		expect(gate).not.toBe(solver);
		const paths = prefetches();
		expect(paths).toContain(new URL(gate ?? '', location.href).pathname);
		expect(paths).toContain(new URL(solver ?? '', location.href).pathname);
		// Idempotent: a second warm-up keeps one link per worker.
		await warmGateWorker();
		expect(prefetches()).toHaveLength(paths.length);
		expect(created).toEqual([]);
	} finally {
		globalThis.Worker = NativeWorker;
	}
});
