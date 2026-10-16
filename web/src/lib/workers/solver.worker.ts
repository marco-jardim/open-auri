import { handleSolverRequest, type SolverRequest, type SolverResponse } from './solver-handler.ts';
import { installWorker, type WorkerScope } from './runtime.ts';

installWorker(self as unknown as WorkerScope<SolverRequest, SolverResponse>, handleSolverRequest);
