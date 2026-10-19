/**
 * The plain bookkeeping of the background classifier (classifier.svelte.ts): its queue for the
 * worker (one curve at a time) and the answers of the session. Nothing here is reactive, on
 * purpose: `peek` reads and fills it while a template is evaluated, where writing a signal is
 * forbidden (`state_unsafe_mutation`). The reactive wrapper is told when an answer lands
 * (`onAnswer`) and notifies the templates itself.
 *
 * - Answers are kept for the store's lifetime (one page), never evicted, so a library larger
 *   than the page cache (`CLASSIFICATIONS_KEPT`) still settles: each curve is classified once.
 * - A curve `request`ed (by `peek`) is queued once per lifetime: answered, failed or still
 *   pending, it is never queued again.
 * - `classify(curve, signal)`: aborting removes a queued job at once (it rejects with an
 *   `AbortError` and never reaches the worker); a job already with the worker is cancelled
 *   through the runner's signal.
 * - The queue starts on a microtask, never inside the caller (a template).
 */
import {
	knownClassified,
	rememberClassification,
	type ClassifiedCurve
} from '#lib/gate-verdicts.ts';
import type { Band } from './gate-handler.ts';

/** A curve as the worker takes it: plain data (a worker message cannot clone a `$state` proxy). */
export interface PlainCurve {
	readonly bands: readonly Band[];
	readonly preampDb: number;
}

export interface ClassifierStoreOptions {
	/** One classification off the main thread (the worker client); `signal` cancels it. */
	run(curve: PlainCurve, signal: AbortSignal | undefined): Promise<ClassifiedCurve>;
	/** An answer is known now that was not when it was asked for (one call per answer). */
	onAnswer(): void;
}

export interface ClassifierStore {
	/** The session's answer for `key`, or null (no page cache lookup: cheap, for templates). */
	answered(key: string): ClassifiedCurve | null;
	/** The session's answer, else the page cache's (kept as the session's from then on), else null. */
	known(bands: readonly Band[], preampDb: number, key: string): ClassifiedCurve | null;
	/** Queues `curve()` once per lifetime of the store (answered or not, never again). */
	request(key: string, curve: () => PlainCurve): void;
	/** The class of `curve`: known, or queued for the worker, one at a time. */
	classify(curve: PlainCurve, signal?: AbortSignal): Promise<ClassifiedCurve>;
	/** Rejects every queued job and every later request with an `AbortError`. */
	dispose(): void;
}

interface Job {
	key: string;
	curve: PlainCurve;
	signal: AbortSignal | undefined;
	resolve(answer: ClassifiedCurve): void;
	reject(error: unknown): void;
	/** Removes the job's abort listener (once it settles). */
	release(): void;
}

export function abortError(): DOMException {
	return new DOMException('Classification cancelled', 'AbortError');
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

/** Dedupe key of a curve (the page cache keys the class itself, exactly). */
export function curveKey(bands: readonly Band[], preampDb: number): string {
	return JSON.stringify([preampDb, bands]);
}

export function createClassifierStore(options: ClassifierStoreOptions): ClassifierStore {
	const queue: Job[] = [];
	/** The session's answers: never evicted. */
	const answers = new Map<string, ClassifiedCurve>();
	/** Keys `request` queued: never queued again. */
	const requested = new Set<string>();
	let running = false;
	let disposed = false;

	function known(bands: readonly Band[], preampDb: number, key: string): ClassifiedCurve | null {
		const answer = answers.get(key);
		if (answer !== undefined) return answer;
		const page = knownClassified(bands, preampDb);
		if (page !== null) answers.set(key, page);
		return page;
	}

	function settle(job: Job, answer: ClassifiedCurve) {
		job.release();
		options.onAnswer();
		job.resolve(answer);
	}

	async function pump(): Promise<void> {
		if (running) return;
		running = true;
		try {
			for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
				if (disposed || job.signal?.aborted) {
					job.release();
					job.reject(abortError());
					continue;
				}
				const cached = known(job.curve.bands, job.curve.preampDb, job.key);
				if (cached !== null) {
					settle(job, cached);
					continue;
				}
				try {
					const answer = await options.run(job.curve, job.signal);
					const { bands, preampDb } = job.curve;
					rememberClassification(bands, preampDb, answer.classification, answer.gateRuns);
					answers.set(job.key, answer);
					settle(job, answer);
				} catch (error) {
					job.release();
					job.reject(disposed || job.signal?.aborted ? abortError() : error);
				}
			}
		} finally {
			running = false;
		}
	}

	function classify(curve: PlainCurve, signal?: AbortSignal): Promise<ClassifiedCurve> {
		if (disposed || signal?.aborted) return Promise.reject(abortError());
		const key = curveKey(curve.bands, curve.preampDb);
		const cached = known(curve.bands, curve.preampDb, key);
		if (cached !== null) return Promise.resolve(cached);
		return new Promise<ClassifiedCurve>((resolve, reject) => {
			const job: Job = { key, curve, signal, resolve, reject, release: () => undefined };
			if (signal) {
				// Queued: out of the queue at once. With the worker: rejected now, and the runner's
				// signal cancels the request.
				const onAbort = () => {
					const index = queue.indexOf(job);
					if (index >= 0) queue.splice(index, 1);
					job.release();
					reject(abortError());
				};
				signal.addEventListener('abort', onAbort, { once: true });
				job.release = () => signal.removeEventListener('abort', onAbort);
			}
			queue.push(job);
			queueMicrotask(() => void pump());
		});
	}

	return {
		answered: (key) => answers.get(key) ?? null,
		known,
		request(key, curve) {
			if (disposed || requested.has(key)) return;
			requested.add(key);
			classify(curve()).catch((error: unknown) => {
				if (!isAbortError(error)) console.warn('Background classification failed', error);
			});
		},
		classify,
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const job of queue.splice(0)) {
				job.release();
				job.reject(abortError());
			}
		}
	};
}
