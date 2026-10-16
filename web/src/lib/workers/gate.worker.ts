import { handleGateRequest, type GateRequest, type GateResponse } from './gate-handler.ts';
import { installWorker, type WorkerScope } from './runtime.ts';

installWorker(self as unknown as WorkerScope<GateRequest, GateResponse>, handleGateRequest);
