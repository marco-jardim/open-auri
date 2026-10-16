import { errorMessage, type WorkerReply } from './runtime.ts';

export interface RequestOptions {
	id?: number;
	signal?: AbortSignal;
}

export interface WorkerClientOptions {
	/** Explicit synchronous fallback for SSR/tests. Fallback still returns a Promise. */
	worker?: false;
	workerFactory?: () => Worker;
}

function abortError() {
	return new DOMException('Worker request cancelled or superseded', 'AbortError');
}

/** Latest request wins. Termination also interrupts synchronous core work in flight. */
export function createLatestClient<I, O>(
	factory: () => Worker,
	handler: (request: I & { id: number }) => O,
	options: WorkerClientOptions = {}
) {
	let sequence = 0;
	let disposed = false;
	let worker: Worker | undefined;
	let active: { id: number; reject: (error: Error) => void; cleanup: () => void } | undefined;
	const cancel = (id = active?.id) => {
		if (!active || active.id !== id) return;
		const pending = active;
		active = undefined;
		pending.cleanup();
		worker?.postMessage({ type: 'cancel', id });
		worker?.terminate();
		worker = undefined;
		pending.reject(abortError());
	};

	const request = (input: I, requestOptions: RequestOptions = {}): Promise<O> => {
		if (disposed) return Promise.reject(new Error('Worker client is disposed'));
		const id = requestOptions.id ?? sequence + 1;
		if (!Number.isSafeInteger(id) || id < 0) {
			return Promise.reject(new RangeError('Worker request ID must be a nonnegative safe integer'));
		}
		cancel();
		sequence = Math.max(sequence, id);
		const signal = requestOptions.signal;
		if (signal?.aborted) return Promise.reject(abortError());
		return new Promise<O>((resolve, reject) => {
			const abort = () => cancel(id);
			const cleanup = () => signal?.removeEventListener('abort', abort);
			const pending = { id, reject, cleanup };
			active = pending;
			signal?.addEventListener('abort', abort, { once: true });
			const finish = (reply: WorkerReply<O>) => {
				if (active !== pending || reply.id !== id) return;
				active = undefined;
				cleanup();
				if (reply.ok) resolve(reply.result);
				else reject(new Error(reply.error));
			};
			try {
				const payload = { ...input, id };
				if (options.worker === false || typeof Worker === 'undefined') {
					// Run core synchronously, but deliver later so a stale result can be discarded.
					const result = handler(payload);
					queueMicrotask(() => finish({ id, ok: true, result }));
					return;
				}
				worker ??= (options.workerFactory ?? factory)();
				worker.onmessage = (event: MessageEvent<WorkerReply<O>>) => finish(event.data);
				worker.onerror = (event) => {
					if (active !== pending) return;
					worker?.terminate();
					worker = undefined;
					finish({ id, ok: false, error: event.message });
				};
				worker.postMessage(payload);
			} catch (error) {
				finish({ id, ok: false, error: errorMessage(error) });
			}
		});
	};

	return {
		request,
		cancel,
		dispose() {
			cancel();
			worker?.terminate();
			worker = undefined;
			disposed = true;
		}
	};
}
