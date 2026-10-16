import { createLatestClient, type RequestOptions, type WorkerClientOptions } from './client.ts';
import {
	handleGateRequest,
	type CommitInput,
	type DragInput,
	type GateInput
} from './gate-handler.ts';

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
