import { createLatestClient, type RequestOptions, type WorkerClientOptions } from './client.ts';
import {
	handleGateRequest,
	type CommitInput,
	type DragInput,
	type GateInput
} from './gate-handler.ts';

// The editor profile (`'standard' | 'yolo' | 'codec'`) travels in each drag/commit input; the
// codec-only predicate of the free preview is cheap and synchronous, so it runs in the page.
export { codecAccepts, type EditorProfile } from './gate-handler.ts';

export function createGateWorker(options: WorkerClientOptions = {}) {
	const client = createLatestClient<GateInput, ReturnType<typeof handleGateRequest>>(
		() => new Worker(new URL('./gate.worker.ts', import.meta.url), { type: 'module' }),
		handleGateRequest,
		options
	);
	return {
		...client,
		async drag(input: Omit<DragInput, 'type'>, requestOptions?: RequestOptions) {
			const response = await client.request({ ...input, type: 'drag' }, requestOptions);
			if (response.type !== 'drag') throw new Error('Unexpected gate response');
			return response;
		},
		async commit(input: Omit<CommitInput, 'type'>, requestOptions?: RequestOptions) {
			const response = await client.request({ ...input, type: 'commit' }, requestOptions);
			if (response.type !== 'commit') throw new Error('Unexpected gate response');
			return response;
		}
	};
}
