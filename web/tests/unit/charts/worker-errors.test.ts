import { afterEach, expect, test, vi } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { createGateWorker } from '#lib/workers/gate-client.ts';
import { createSolverWorker } from '#lib/workers/solver-client.ts';
import { errorMessage, type WorkerReply } from '#lib/workers/runtime.ts';

/** A transport-only fake: responses deliberately violate the worker's response discriminator. */
class ReplyWorker {
	static instances: ReplyWorker[] = [];
	onmessage: ((event: MessageEvent<WorkerReply<unknown>>) => void) | null = null;
	onerror: ((event: Pick<ErrorEvent, 'message'>) => void) | null = null;
	postMessage = vi.fn();
	terminate = vi.fn();

	constructor() {
		ReplyWorker.instances.push(this);
	}

	reply(id: number, type: string) {
		this.onmessage?.(new MessageEvent('message', { data: { id, ok: true, result: { id, type } } }));
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	ReplyWorker.instances = [];
});

test('worker errors preserve Error messages and safely stringify non-Error failures', () => {
	expect(errorMessage(new Error('Worker failed'))).toBe('Worker failed');
	expect(errorMessage('Rejected payload')).toBe('Rejected payload');
	expect(errorMessage(null)).toBe('null');
	expect(errorMessage(42)).toBe('42');
});

test.each(['drag', 'commit'] as const)('gate %s rejects the wrong response kind', async (kind) => {
	vi.stubGlobal('Worker', ReplyWorker);
	const client = createGateWorker();
	try {
		const result =
			kind === 'commit'
				? client.commit(NEUTRO, { id: 12 })
				: client.drag({ ...NEUTRO, bandIndex: 0, param: 'gainDb', from: 0, to: 1 }, { id: 12 });
		const assertion = expect(result).rejects.toThrow('Unexpected gate response');
		const worker = ReplyWorker.instances[0];
		expect(worker.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: kind, id: 12 })
		);
		worker.reply(12, kind === 'commit' ? 'drag' : 'commit');
		await assertion;
	} finally {
		client.dispose();
	}
});

test.each(['solve', 'target'] as const)(
	'solver %s rejects the wrong response kind',
	async (kind) => {
		vi.stubGlobal('Worker', ReplyWorker);
		const client = createSolverWorker();
		const points = [{ freqHz: 1000, gainDb: 0 }];
		try {
			const result =
				kind === 'solve'
					? client.solve({ points }, { id: 23 })
					: client.target({ points, grid: [1000] }, { id: 23 });
			const assertion = expect(result).rejects.toThrow('Unexpected solver response');
			const worker = ReplyWorker.instances[0];
			expect(worker.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: kind, id: 23 })
			);
			worker.reply(23, kind === 'solve' ? 'target' : 'solve');
			await assertion;
		} finally {
			client.dispose();
		}
	}
);

test('a worker crash rejects the active request, terminates it, and allows a fresh worker', async () => {
	vi.stubGlobal('Worker', ReplyWorker);
	const client = createGateWorker();
	try {
		const failed = client.commit(NEUTRO);
		const assertion = expect(failed).rejects.toThrow('Worker crashed');
		const first = ReplyWorker.instances[0];
		const lateError = first.onerror;
		first.onerror?.({ message: 'Worker crashed' });
		await assertion;
		expect(first.terminate).toHaveBeenCalledOnce();
		const recovered = client.commit(NEUTRO);
		lateError?.({ message: 'Old worker error' });
		const second = ReplyWorker.instances[1];
		expect(second.terminate).not.toHaveBeenCalled();
		second.reply(2, 'commit');
		await expect(recovered).resolves.toMatchObject({ id: 2, type: 'commit' });
	} finally {
		client.dispose();
	}
});
