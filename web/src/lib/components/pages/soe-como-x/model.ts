import { curveResponseDb, GRID, snapshotBands } from 'open-auri/dsp';
import { getPreset } from 'open-auri/catalog';
import { normalize, parseMeasurement, toGrid } from 'open-auri/io';
import { targetFromPoints, type solvePeq } from 'open-auri/solver';
import type { AutoEqEntry, createAutoEqClient } from '#lib/data/autoeq.ts';
import type { SolveParameters, SolverOptions } from '#lib/workers/solver-handler.ts';
import type { CurveData } from '#lib/state/model.ts';

export type AutoEqClient = Pick<
	ReturnType<typeof createAutoEqClient>,
	'loadIndex' | 'loadEntry' | 'getAttribution'
>;
export type FitResult = ReturnType<typeof solvePeq>;
export type TargetPoint = Parameters<typeof targetFromPoints>[0][number];
export interface Trace {
	name: string;
	values: number[];
	kind: 'autoeq' | 'csv' | 'preset' | 'drawn' | 'community';
	credit?: { source: string; detail?: string; link?: string };
}
export const INITIAL_POINTS: readonly TargetPoint[] = [
	{ freqHz: 20, gainDb: 0 },
	{ freqHz: 80, gainDb: 0 },
	{ freqHz: 300, gainDb: 0 },
	{ freqHz: 1000, gainDb: 0 },
	{ freqHz: 3000, gainDb: 0 },
	{ freqHz: 8000, gainDb: 0 },
	{ freqHz: 20000, gainDb: 0 }
];

export function csvTrace(text: string, name: string): Trace {
	const parsed = parseMeasurement(text);
	return {
		name,
		kind: 'csv',
		values: normalize(toGrid(parsed.frequencies, parsed.values), GRID)
	};
}

export function presetTarget(id: string): Trace {
	const preset = getPreset(id);
	if (!preset) throw new RangeError('preset:unknown');
	return {
		name: preset.label,
		kind: 'preset',
		values: normalize(curveResponseDb(preset, GRID), GRID)
	};
}

export function drawnTarget(points: readonly TargetPoint[], name: string): Trace {
	return { name, kind: 'drawn', values: normalize(targetFromPoints(points, GRID), GRID) };
}

export async function autoEqTrace(client: AutoEqClient, entry: AutoEqEntry): Promise<Trace> {
	const data = await client.loadEntry(entry);
	// The source and MIT credit never depend on the optional manifest being online.
	let detail: string | undefined;
	let link: string | undefined;
	try {
		const attribution = await client.getAttribution(entry);
		detail = attribution?.attribution;
		link = attribution?.link;
	} catch (cause) {
		detail = cause instanceof Error ? `AutoEq: ${cause.message}` : 'AutoEq: manifest unavailable';
	}
	return {
		name: entry.name,
		kind: 'autoeq',
		values: normalize(toGrid(data.frequencies, data.values), GRID),
		credit: { source: entry.source, detail, link }
	};
}

export interface Controls {
	speed: number;
	iso: boolean;
	d5Weight: number;
}
export interface StationState {
	measurement: Trace | null;
	target: Trace | null;
	controls: Controls;
	phase: 'measurement' | 'target' | 'correction' | 'solving' | 'result' | 'error';
	revision: number;
	result: FitResult | null;
	error: string | null;
}
export function initialStation(): StationState {
	return {
		measurement: null,
		target: null,
		controls: { speed: 65, iso: true, d5Weight: 0.005 },
		phase: 'measurement',
		revision: 0,
		result: null,
		error: null
	};
}
export type StationEvent =
	| { type: 'measurement' | 'target'; trace: Trace | null }
	| { type: 'controls'; controls: Controls }
	| { type: 'start' }
	| { type: 'result'; revision: number; result: FitResult }
	| { type: 'error'; revision: number; error: string };

function readyPhase(state: StationState): StationState['phase'] {
	return !state.measurement ? 'measurement' : !state.target ? 'target' : 'correction';
}
export function stationTransition(state: StationState, event: StationEvent): StationState {
	if (event.type === 'start') {
		if (!state.measurement || !state.target || state.phase === 'solving') return state;
		return { ...state, phase: 'solving', result: null, error: null };
	}
	if (event.type === 'result' || event.type === 'error') {
		if (event.revision !== state.revision || state.phase !== 'solving') return state;
		if (event.type === 'error') {
			return { ...state, phase: 'error', result: null, error: event.error };
		}
		const result = event.result;
		if (
			result.gate.ok !== true ||
			result.bands.length !== 10 ||
			!Number.isFinite(result.preampDb) ||
			result.preampDb < -25.5 ||
			result.preampDb > -0.5 ||
			!Number.isFinite(result.rmsDb)
		) {
			return { ...state, phase: 'error', result: null, error: 'solver:invalid-result' };
		}
		return { ...state, phase: 'result', result, error: null };
	}
	const next: StationState = {
		...state,
		...(event.type === 'controls' ? { controls: event.controls } : { [event.type]: event.trace }),
		revision: state.revision + 1,
		result: null,
		error: null
	};
	return { ...next, phase: readyPhase(next) };
}

export function buildSolverRequest(state: StationState): SolveParameters {
	return { options: solverOptions(state) };
}

function solverOptions(state: StationState): SolverOptions {
	if (!state.measurement || !state.target) throw new Error('solver:missing-input');
	const { speed, iso, d5Weight } = state.controls;
	if (
		!Number.isFinite(speed) ||
		speed < 0 ||
		speed > 100 ||
		!Number.isFinite(d5Weight) ||
		d5Weight < 0 ||
		d5Weight > 1
	) {
		throw new RangeError('solver:controls');
	}
	return {
		grid: GRID,
		measurement: [...state.measurement.values],
		target: [...state.target.values],
		speed,
		weights: iso ? 'iso226' : 'flat',
		phon: 60,
		d5Weight,
		maxBands: 10,
		allowExperimental: false,
		layer: 'ajustar',
		levelMatch: true,
		maxIterations: MAX_ITERATIONS,
		maxTimeMs: 1200
	};
}

export const MAX_ITERATIONS = 400;
/**
 * Iteration budgets of the progress passes that run before the full solve. Each pass is a
 * real, deterministic solve cut at that many LM trials (the worker has no progress messages),
 * so "ITER n / N" and the deviation map always show numbers the solver actually produced.
 * The final answer always comes from the full request, never from a progress pass.
 */
export const PROGRESS_BUDGETS: readonly number[] = [20, 60, 140];

/** Measurement with the fitted EQ, aligned at 1 kHz like every trace on the page. */
export function predictedValues(
	measurement: readonly number[],
	fit: Pick<FitResult, 'bands' | 'preampDb'>
): number[] {
	const response = curveResponseDb(fit, GRID);
	return normalize(
		measurement.map((value, i) => value + response[i]),
		GRID
	);
}

/**
 * Level-matched deviation (prediction − target) on the audible grid (20 Hz to 20 kHz) and its
 * largest absolute value. The mean is removed because the target never sets playback volume.
 */
export function deviation(
	predicted: readonly number[],
	target: readonly number[]
): { values: number[]; maxErrorDb: number } {
	const indices = GRID.flatMap((hz, i) => (hz >= 20 && hz <= 20000 ? [i] : []));
	if (!indices.length) return { values: [], maxErrorDb: 0 };
	const raw = indices.map((i) => predicted[i] - target[i]);
	const mean = raw.reduce((sum, value) => sum + value, 0) / raw.length;
	const values = raw.map((value) => value - mean);
	return { values, maxErrorDb: Math.max(...values.map(Math.abs)) };
}

export interface SolveProgress {
	/** LM trials the solver reported for this pass. */
	iterations: number;
	maxIterations: number;
	rmsDb: number;
	maxErrorDb: number;
	predicted: number[];
	/** Level-matched deviation on the audible grid, one value per grid point. */
	row: number[];
}

export function progressFrom(
	result: FitResult,
	measurement: readonly number[],
	target: readonly number[],
	maxIterations: number
): SolveProgress {
	const predicted = predictedValues(measurement, result);
	const { values, maxErrorDb } = deviation(predicted, target);
	return {
		iterations: result.iterations,
		maxIterations,
		rmsDb: result.rmsDb,
		maxErrorDb,
		predicted,
		row: values
	};
}

export interface SolverPort {
	solve(input: SolveParameters): Promise<{ result: FitResult }>;
}

/**
 * Real progress: short solves at PROGRESS_BUDGETS, each reported through `onprogress`, then
 * the full request. `onprogress` returns false when the page moved on (edit, cancel, unmount);
 * the remaining passes are skipped. A pass that stops for any reason other than the iteration
 * cap ends the previews (more budget would not change its path) and goes to the full solve.
 */
export async function solveStationWithProgress(
	state: StationState,
	worker: SolverPort,
	onprogress: (progress: SolveProgress) => boolean
): Promise<StationEvent> {
	try {
		const full = solverOptions(state);
		const measurement = full.measurement ?? [];
		const maxIterations = full.maxIterations ?? MAX_ITERATIONS;
		const maxTimeMs = full.maxTimeMs ?? 1200;
		for (const budget of PROGRESS_BUDGETS) {
			if (budget >= maxIterations) break;
			const pass = await worker.solve({
				options: {
					...full,
					maxIterations: budget,
					maxTimeMs: Math.max(100, Math.round((maxTimeMs * budget) / maxIterations))
				}
			});
			const next = progressFrom(pass.result, measurement, full.target, maxIterations);
			if (!onprogress(next)) {
				return { type: 'error', revision: state.revision, error: 'solver:superseded' };
			}
			if (pass.result.stopReason !== 'iterations') break;
		}
		const response = await worker.solve({ options: full });
		return { type: 'result', revision: state.revision, result: response.result };
	} catch (cause) {
		return {
			type: 'error',
			revision: state.revision,
			error: cause instanceof Error ? cause.message : 'solver:failed'
		};
	}
}
export async function solveStation(state: StationState, worker: SolverPort): Promise<StationEvent> {
	try {
		const response = await worker.solve(buildSolverRequest(state));
		return { type: 'result', revision: state.revision, result: response.result };
	} catch (cause) {
		return {
			type: 'error',
			revision: state.revision,
			error: cause instanceof Error ? cause.message : 'solver:failed'
		};
	}
}

export function resultCurve(state: StationState, name: string): CurveData | null {
	if (state.phase !== 'result' || !state.result?.gate.ok) return null;
	return {
		name,
		source: 'custom',
		bands: snapshotBands(state.result.bands),
		preampDb: state.result.preampDb
	};
}
