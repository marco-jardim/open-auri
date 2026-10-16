import { createLatestClient, type RequestOptions, type WorkerClientOptions } from './client.ts';
import {
	handleSolverRequest,
	type SolveParameters,
	type SolverInput,
	type TargetInput
} from './solver-handler.ts';

export function createSolverWorker(options: WorkerClientOptions = {}) {
	const client = createLatestClient<SolverInput, ReturnType<typeof handleSolverRequest>>(
		() => new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' }),
		handleSolverRequest,
		options
	);
	return {
		...client,
		async solve(input: SolveParameters, requestOptions?: RequestOptions) {
			const response = await client.request({ ...input, type: 'solve' }, requestOptions);
			if (response.type !== 'solve') throw new Error('Unexpected solver response');
			return response;
		},
		async target(input: Omit<TargetInput, 'type'>, requestOptions?: RequestOptions) {
			const response = await client.request({ ...input, type: 'target' }, requestOptions);
			if (response.type !== 'target') throw new Error('Unexpected solver response');
			return response;
		}
	};
}
