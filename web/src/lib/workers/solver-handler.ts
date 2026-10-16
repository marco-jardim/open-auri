import { solvePeq, targetFromPoints } from 'open-auri/solver';

/** Functions (notably the testing clock) cannot cross the worker boundary. */
export type SolverOptions = Omit<Parameters<typeof solvePeq>[0], 'clock'>;
export type TargetPoint = Parameters<typeof targetFromPoints>[0][number];
export type SolveParameters =
	| { options: SolverOptions }
	| {
			points: readonly TargetPoint[];
			options?: Omit<SolverOptions, 'target'>;
	  };
export type SolveInput = SolveParameters & { type: 'solve' };
export interface TargetInput {
	type: 'target';
	points: readonly TargetPoint[];
	grid?: readonly number[];
}
export type SolverInput = SolveInput | TargetInput;
export type SolverRequest = SolverInput & { id: number };
export type SolverResponse =
	| {
			type: 'solve';
			id: number;
			result: ReturnType<typeof solvePeq>;
	  }
	| {
			type: 'target';
			id: number;
			target: number[];
	  };

/** A single response, with the core's maxTimeMs budget passed through unchanged. */
export function handleSolverRequest(request: SolverRequest): SolverResponse {
	if (request.type === 'target') {
		return {
			type: 'target',
			id: request.id,
			target: targetFromPoints(request.points, request.grid)
		};
	}
	const options =
		'points' in request
			? { ...request.options, target: targetFromPoints(request.points, request.options?.grid) }
			: request.options;
	return { type: 'solve', id: request.id, result: solvePeq(options) };
}
