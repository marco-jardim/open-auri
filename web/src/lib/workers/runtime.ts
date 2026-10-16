export interface CancelRequest {
	type: 'cancel';
	id: number;
}

export type WorkerReply<T> =
	| { id: number; ok: true; result: T }
	| {
			id: number;
			ok: false;
			error: string;
	  };

export interface WorkerScope<I, O> {
	onmessage: ((event: MessageEvent<I | CancelRequest>) => void) | null;
	postMessage(message: WorkerReply<O>): void;
}

/** Yield once so queued cancellation/newer IDs can discard work before it starts. */
export function installWorker<I extends { id: number; type: string }, O>(
	scope: WorkerScope<I, O>,
	handle: (input: I) => O
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let latestId: number | undefined;
	scope.onmessage = ({ data }) => {
		if (data.type === 'cancel') {
			if (latestId === data.id) {
				clearTimeout(timer);
				latestId = undefined;
			}
			return;
		}
		clearTimeout(timer);
		latestId = data.id;
		timer = setTimeout(() => {
			if (data.id !== latestId) return;
			try {
				scope.postMessage({ id: data.id, ok: true, result: handle(data as I) });
			} catch (error) {
				scope.postMessage({ id: data.id, ok: false, error: errorMessage(error) });
			}
		}, 0);
	};
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
