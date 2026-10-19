/**
 * The plain bookkeeping of the background classifier (workers/classifier-store.ts), with an
 * injected runner standing for the worker:
 * - aborting a queued request takes it out of the queue at once: it rejects while the job
 *   ahead of it is still with the worker, and never reaches the worker; a request already with
 *   the worker is rejected at once too, and the runner's signal is aborted;
 * - answers are never evicted: a library larger than the page cache settles, each curve is
 *   classified once, and asking again never queues it again.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import {
	CLASSIFICATIONS_KEPT,
	clearGateVerdicts,
	knownClassification,
	type ClassifiedCurve
} from '#lib/gate-verdicts.ts';
import { createClassifierStore, curveKey, type PlainCurve } from '#lib/workers/classifier-store.ts';
import type { Band } from '#lib/workers/gate-handler.ts';

beforeEach(() => clearGateVerdicts());
afterEach(() => {
	clearGateVerdicts();
	vi.restoreAllMocks();
});

const pad = (active: Band[]): Band[] => [...active, ...NEUTRO.bands.slice(active.length)];
/** A distinct plain curve per index (a cut that moves with it). */
const curveAt = (index: number): PlainCurve => ({
	bands: pad([{ kind: 'PK', freqHz: 100 + index, gainDb: -3, qFactor: 1 }]),
	preampDb: -3
});
const STANDARD: ClassifiedCurve = {
	classification: { class: 'standard', waived: [], reasons: [] },
	gateRuns: 1
};
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** A store whose runner waits for `release` (one deferred answer per call). */
function heldStore() {
	const held: { curve: PlainCurve; signal: AbortSignal | undefined; release: () => void }[] = [];
	const run = vi.fn((curve: PlainCurve, signal: AbortSignal | undefined) => {
		const answer = deferred<ClassifiedCurve>();
		held.push({ curve, signal, release: () => answer.resolve(STANDARD) });
		return answer.promise;
	});
	const onAnswer = vi.fn();
	return { store: createClassifierStore({ run, onAnswer }), run, onAnswer, held };
}

test('an aborted queued request leaves the queue at once and never reaches the worker', async () => {
	const { store, run, held } = heldStore();
	const controller = new AbortController();
	const first = store.classify(curveAt(0));
	const second = store.classify(curveAt(1), controller.signal);
	await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
	// The first job is still with the worker: the abort does not wait for it.
	controller.abort();
	await expect(second).rejects.toSatisfy(isAbort);
	expect(held).toHaveLength(1);
	held[0]?.release();
	await expect(first).resolves.toEqual(STANDARD);
	// The queue drained without the aborted job.
	await Promise.resolve();
	expect(run).toHaveBeenCalledOnce();
	expect(knownClassification(curveAt(1).bands, curveAt(1).preampDb)).toBeNull();
});

test('aborting a request already with the worker rejects it now and cancels the runner', async () => {
	const { store, run, held } = heldStore();
	const controller = new AbortController();
	const pending = store.classify(curveAt(0), controller.signal);
	await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
	expect(held[0]?.signal).toBe(controller.signal);
	controller.abort();
	await expect(pending).rejects.toSatisfy(isAbort);
	expect(held[0]?.signal?.aborted).toBe(true);
	// A late answer is still kept for the page, but the request stays rejected.
	held[0]?.release();
	const next = store.classify(curveAt(2));
	await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
	held[1]?.release();
	await expect(next).resolves.toEqual(STANDARD);
});

test('dispose rejects every queued job and every later request', async () => {
	const { store, run, held } = heldStore();
	const first = store.classify(curveAt(0));
	const second = store.classify(curveAt(1));
	await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
	store.dispose();
	await expect(second).rejects.toSatisfy(isAbort);
	await expect(store.classify(curveAt(2))).rejects.toSatisfy(isAbort);
	held[0]?.release();
	await first.catch(() => undefined);
	expect(run).toHaveBeenCalledOnce();
});

test('300 curves (more than the page cache keeps) are each classified once and settle', async () => {
	const count = 300;
	expect(count).toBeGreaterThan(CLASSIFICATIONS_KEPT);
	const run = vi.fn(async () => STANDARD);
	const onAnswer = vi.fn();
	const store = createClassifierStore({ run, onAnswer });
	const curves = Array.from({ length: count }, (_, index) => curveAt(index));
	const keys = curves.map((curve) => curveKey(curve.bands, curve.preampDb));
	/** One template pass over the shelf: every badge asks, as `peek` does. */
	const pass = () =>
		curves.filter((curve, index) => {
			const key = keys[index] ?? '';
			if (store.answered(key) !== null) return false;
			if (store.known(curve.bands, curve.preampDb, key) !== null) return false;
			store.request(key, () => curve);
			return true;
		}).length;
	expect(pass()).toBe(count);
	// Every answer re-runs the waiting badges: none is queued twice, the queue drains.
	for (let round = 0; round < 50 && pass() > 0; round++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(pass()).toBe(0);
	expect(run).toHaveBeenCalledTimes(count);
	expect(onAnswer).toHaveBeenCalledTimes(count);
	// The page cache kept only the latest classes; the store still knows the first curve.
	expect(knownClassification(curves[0]?.bands ?? [], -3)).toBeNull();
	expect(store.answered(keys[0] ?? '')).toEqual(STANDARD);
	// Later passes and requests ask the worker for nothing.
	for (const [index, curve] of curves.entries()) store.request(keys[index] ?? '', () => curve);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(run).toHaveBeenCalledTimes(count);
});

test('a curve requested once is never queued again, answered or not', async () => {
	const run = vi.fn(async () => {
		throw new Error('worker failed');
	});
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const store = createClassifierStore({ run, onAnswer: vi.fn() });
	const curve = curveAt(7);
	const key = curveKey(curve.bands, curve.preampDb);
	store.request(key, () => curve);
	await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
	store.request(key, () => curve);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(run).toHaveBeenCalledOnce();
});
