/**
 * Classes for bulk work, off the main thread: library badges (one per tape) and the merge's gate
 * weights. One dedicated gate worker client (gate.worker.ts through `createLatestClient`: latest
 * wins, so it is never shared with an editor's drags or a page's verdict client) classifies one
 * queued curve at a time.
 *
 * - The worker has its own verdict and class caches, not the page's. Each answer is therefore
 *   kept for the page too (`rememberClassification`): a later synchronous exit (save, write,
 *   export) finds it there. An exit never waits for this queue, and never runs with an unknown
 *   class: it classifies on the spot (`curveClassification`).
 * - `peek` is for templates: the class when the page already knows it, else null while the curve
 *   waits for the worker; reading it again after the answer lands gives the class (reactive).
 *   Nothing is queued during SSR.
 * - Curves are sent as plain snapshots (`$state.snapshot`): a worker message cannot clone a
 *   `$state` proxy.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
	knownClassification,
	rememberClassification,
	type CurveClassification
} from '#lib/gate-verdicts.ts';
import { createLatestClient, type WorkerClientOptions } from './client.ts';
import { handleGateRequest, type Band, type GateInput } from './gate-handler.ts';

/** A gate worker client of its own (the page's editor and verdict clients never share it). */
function classifyClient(options: WorkerClientOptions) {
	const client = createLatestClient<GateInput, ReturnType<typeof handleGateRequest>>(
		() => new Worker(new URL('./gate.worker.ts', import.meta.url), { type: 'module' }),
		handleGateRequest,
		options
	);
	return {
		async classify(bands: readonly Band[], preampDb: number): Promise<CurveClassification> {
			const response = await client.request({ bands, preampDb, type: 'classify' });
			if (response.type !== 'classify') throw new Error('Unexpected gate response');
			return response.classification;
		},
		dispose: () => client.dispose()
	};
}

export interface ClassifierCurve {
	readonly bands: readonly Band[];
	readonly preampDb: number;
}

export interface Classifier {
	/** The known class of `curve`, else null (the curve is queued for the worker). Reactive. */
	peek(curve: ClassifierCurve): CurveClassification | null;
	/** The class of `curve`: the page's when known, else the worker's (queued, one at a time). */
	classify(curve: ClassifierCurve, signal?: AbortSignal): Promise<CurveClassification>;
	/** Stops the worker; queued and later requests reject with an `AbortError`. */
	dispose(): void;
}

interface Job {
	key: string;
	bands: readonly Band[];
	preampDb: number;
	signal: AbortSignal | undefined;
	resolve: (classification: CurveClassification) => void;
	reject: (error: unknown) => void;
}

/** Answers kept for curves the page cache cannot key (plain-data curves never need them). */
const ANSWERS_KEPT = 256;

function abortError(): DOMException {
	return new DOMException('Classification cancelled', 'AbortError');
}

export function createClassifier(options: WorkerClientOptions = {}): Classifier {
	let worker: ReturnType<typeof classifyClient> | null = null;
	let disposed = false;
	let running = false;
	/** Bumped when an answer lands, so a `peek` read in a template or effect reads again. */
	let revision = $state(0);
	const queue: Job[] = [];
	/** Curves queued by `peek` and not answered yet (one request each). */
	const peeking = new SvelteSet<string>();
	const answers = new SvelteMap<string, CurveClassification>();

	/** Dedupe key of a queued curve (the page cache keys the class itself exactly). */
	const keyOf = (bands: readonly Band[], preampDb: number) => JSON.stringify([preampDb, bands]);

	function known(bands: readonly Band[], preampDb: number, key: string) {
		return knownClassification(bands, preampDb) ?? answers.get(key) ?? null;
	}

	async function pump(): Promise<void> {
		if (running) return;
		running = true;
		try {
			for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
				if (disposed || job.signal?.aborted) {
					job.reject(abortError());
					continue;
				}
				const cached = known(job.bands, job.preampDb, job.key);
				if (cached !== null) {
					job.resolve(cached);
					continue;
				}
				try {
					worker ??= classifyClient(options);
					const classification = await worker.classify(job.bands, job.preampDb);
					rememberClassification(job.bands, job.preampDb, classification);
					answers.delete(job.key);
					if (answers.size >= ANSWERS_KEPT) {
						const oldest = answers.keys().next();
						if (!oldest.done) answers.delete(oldest.value);
					}
					answers.set(job.key, classification);
					revision++;
					job.resolve(classification);
				} catch (error) {
					job.reject(disposed ? abortError() : error);
				}
			}
		} finally {
			running = false;
		}
	}

	function classify(curve: ClassifierCurve, signal?: AbortSignal): Promise<CurveClassification> {
		if (disposed || signal?.aborted) return Promise.reject(abortError());
		const bands: readonly Band[] = $state.snapshot(curve.bands);
		const preampDb = curve.preampDb;
		const key = keyOf(bands, preampDb);
		return new Promise<CurveClassification>((resolve, reject) => {
			queue.push({ key, bands, preampDb, signal, resolve, reject });
			void pump();
		});
	}

	return {
		peek(curve) {
			void revision;
			const key = keyOf(curve.bands, curve.preampDb);
			const cached = known(curve.bands, curve.preampDb, key);
			if (cached !== null || disposed || typeof window === 'undefined') return cached;
			if (!peeking.has(key)) {
				peeking.add(key);
				classify(curve)
					.catch((error: unknown) => {
						if (!(error instanceof DOMException && error.name === 'AbortError')) {
							console.warn('Background classification failed', error);
						}
					})
					.finally(() => peeking.delete(key));
			}
			return null;
		},
		classify,
		dispose() {
			if (disposed) return;
			disposed = true;
			worker?.dispose();
			worker = null;
			for (const job of queue.splice(0)) job.reject(abortError());
		}
	};
}
