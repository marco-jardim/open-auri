import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { createGateWorker } from '../../../src/lib/workers/gate-client.ts';
import { createSolverWorker } from '../../../src/lib/workers/solver-client.ts';
import { createLatestClient } from '../../../src/lib/workers/client.ts';
import {
	installWorker,
	type CancelRequest,
	type WorkerReply,
	type WorkerScope
} from '../../../src/lib/workers/runtime.ts';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('SSR promise clients', () => {
	it('runs the full gate synchronously when Worker is unavailable', async () => {
		vi.stubGlobal('Worker', undefined);
		const client = createGateWorker();
		try {
			const response = await client.commit(NEUTRO, { id: 81 });
			expect(response.id).toBe(81);
			expect(response.verdict.metrics.grid).toBe('full');
			expect(response.verdict.ok).toBe(true);
		} finally {
			client.dispose();
		}
	});

	it('supports target and solve promises in the explicit fallback', async () => {
		const client = createSolverWorker({ worker: false });
		try {
			const points = [
				{ freqHz: 20, gainDb: 0 },
				{ freqHz: 20000, gainDb: 0 }
			];
			const target = await client.target({ points, grid: [20, 1000, 20000] });
			expect(target.target).toEqual([0, 0, 0]);
			const solved = await client.solve({ points, options: { maxTimeMs: 25, maxIterations: 1 } });
			expect(solved.result.gate.ok).toBe(true);
		} finally {
			client.dispose();
		}
	});

	it('rejects stale results, explicit cancellation, abortion and use after dispose', async () => {
		const client = createGateWorker({ worker: false });
		const stale = client.commit(NEUTRO, { id: 1 });
		const staleAssertion = expect(stale).rejects.toMatchObject({ name: 'AbortError' });
		const current = client.commit(NEUTRO, { id: 2 });
		await staleAssertion;
		expect((await current).id).toBe(2);
		const cancelled = client.commit(NEUTRO, { id: 3 });
		client.cancel(3);
		await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
		const controller = new AbortController();
		const aborted = client.commit(NEUTRO, { signal: controller.signal });
		controller.abort();
		await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
		await expect(client.commit(NEUTRO, { signal: controller.signal })).rejects.toMatchObject({
			name: 'AbortError'
		});
		client.dispose();
		await expect(client.commit(NEUTRO)).rejects.toThrow(/disposed/);
	});

	it('surfaces handler failures as rejected promises', async () => {
		const client = createGateWorker({ worker: false });
		try {
			await expect(
				client.drag({ ...NEUTRO, bandIndex: 0, param: 'gainDb', from: 0, to: 1 })
			).rejects.toThrow(/active band/);
		} finally {
			client.dispose();
		}
	});

	it('refuses nonfinite IDs instead of leaving an unmatchable promise pending', async () => {
		const client = createGateWorker({ worker: false });
		try {
			await expect(client.commit(NEUTRO, { id: NaN })).rejects.toThrow(RangeError);
			await expect(client.commit(NEUTRO, { id: -1 })).rejects.toThrow(RangeError);
			expect((await client.commit(NEUTRO)).id).toBe(1);
		} finally {
			client.dispose();
		}
	});
});

class TestWorker {
	static instances: TestWorker[] = [];
	onmessage: ((event: MessageEvent<WorkerReply<number>>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	postMessage = vi.fn();
	terminate = vi.fn();
	constructor() {
		TestWorker.instances.push(this);
	}
	respond(id: number, value: number) {
		this.onmessage?.(new MessageEvent('message', { data: { id, ok: true, result: value } }));
	}
}

describe('worker cancellation and error routing', () => {
	it('terminates running stale work and ignores late responses, even with reused IDs', async () => {
		TestWorker.instances = [];
		vi.stubGlobal('Worker', TestWorker);
		const fallback = vi.fn(({ value }: { id: number; value: number }) => value);
		const client = createLatestClient<{ value: number }, number>(
			() => new Worker('test'),
			fallback
		);
		const first = client.request({ value: 1 }, { id: 7 });
		const assertion = expect(first).rejects.toMatchObject({ name: 'AbortError' });
		const second = client.request({ value: 2 }, { id: 7 });
		const [oldWorker, currentWorker] = TestWorker.instances;
		expect(oldWorker.terminate).toHaveBeenCalledOnce();
		expect(oldWorker.postMessage).toHaveBeenLastCalledWith({ type: 'cancel', id: 7 });
		oldWorker.respond(7, 1);
		currentWorker.respond(7, 2);
		await assertion;
		expect(await second).toBe(2);
		expect(fallback).not.toHaveBeenCalled();
		client.dispose();
		expect(currentWorker.terminate).toHaveBeenCalledOnce();
	});

	it('ignores replies with another ID and forwards worker errors', async () => {
		TestWorker.instances = [];
		vi.stubGlobal('Worker', TestWorker);
		const client = createLatestClient<{ value: number }, number>(
			() => new Worker('test'),
			({ value }) => value
		);
		const response = client.request({ value: 1 }, { id: 9 });
		const worker = TestWorker.instances[0];
		worker.respond(8, 100);
		worker.onmessage?.(
			new MessageEvent('message', { data: { id: 9, ok: false, error: 'Invalid input' } })
		);
		await expect(response).rejects.toThrow('Invalid input');
		client.dispose();
	});
});

describe('worker runtime', () => {
	type Job = { type: 'job'; id: number; value: number };
	function harness() {
		const scope: WorkerScope<Job, number> = { onmessage: null, postMessage: vi.fn() };
		const handle = vi.fn((input: Job) => {
			if (input.value < 0) throw new Error('Negative input');
			return input.value * 2;
		});
		installWorker(scope, handle);
		return {
			scope,
			handle,
			send(data: Job | CancelRequest) {
				scope.onmessage?.(new MessageEvent('message', { data }));
			}
		};
	}

	it('coalesces queued requests by ID and cancels only a matching ID', () => {
		vi.useFakeTimers();
		const { scope, handle, send } = harness();
		send({ type: 'job', id: 1, value: 1 });
		send({ type: 'job', id: 2, value: 2 });
		send({ type: 'cancel', id: 1 });
		vi.runAllTimers();
		expect(handle).toHaveBeenCalledOnce();
		expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({ id: 2, ok: true, result: 4 });
		send({ type: 'job', id: 3, value: 3 });
		send({ type: 'cancel', id: 3 });
		vi.runAllTimers();
		expect(handle).toHaveBeenCalledOnce();
	});

	it('posts one typed error response rather than crashing the worker', () => {
		vi.useFakeTimers();
		const { scope, send } = harness();
		send({ type: 'job', id: 4, value: -1 });
		vi.runAllTimers();
		expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({
			id: 4,
			ok: false,
			error: 'Negative input'
		});
	});
});
