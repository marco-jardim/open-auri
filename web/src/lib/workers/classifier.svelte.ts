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
 * - The queue and the answers are plain bookkeeping (classifier-store.ts), never signals: `peek`
 *   fills them while a template is evaluated. The answers of a classifier are never evicted, so
 *   a tape is classified once however large the library is.
 * - `peek` is for templates: the class when it is known, else null while the curve waits for the
 *   worker. Only a curve still waiting reads `revision`, which is bumped at most once per
 *   animation frame however many answers land in it, so a template reads again after its answer
 *   and an answered badge never runs again for someone else's. Nothing is queued during SSR.
 * - Curves are sent as plain snapshots (`$state.snapshot`): a worker message cannot clone a
 *   `$state` proxy.
 */
import type { ClassifiedCurve, CurveClassification } from '#lib/gate-verdicts.ts';
import { createClassifierStore, curveKey } from './classifier-store.ts';
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
		async classify(
			bands: readonly Band[],
			preampDb: number,
			signal: AbortSignal | undefined
		): Promise<ClassifiedCurve> {
			const response = await client.request(
				{ bands, preampDb, type: 'classify' },
				signal ? { signal } : {}
			);
			if (response.type !== 'classify') throw new Error('Unexpected gate response');
			return { classification: response.classification, gateRuns: response.gateRuns };
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
	/**
	 * The class of `curve` and the gate runs it took: known, else the worker's (queued, one at a
	 * time). Aborting `signal` takes a queued request out of the queue at once.
	 */
	classify(curve: ClassifierCurve, signal?: AbortSignal): Promise<ClassifiedCurve>;
	/** Stops the worker; queued and later requests reject with an `AbortError`. */
	dispose(): void;
}

/** Runs `flush` on the next animation frame (a timer where there is none); returns the cancel. */
function nextFrame(flush: () => void): () => void {
	if (typeof requestAnimationFrame === 'function') {
		const handle = requestAnimationFrame(flush);
		return () => cancelAnimationFrame(handle);
	}
	const handle = setTimeout(flush, 16);
	return () => clearTimeout(handle);
}

export function createClassifier(options: WorkerClientOptions = {}): Classifier {
	let worker: ReturnType<typeof classifyClient> | null = null;
	let disposed = false;
	/** Bumped once per frame in which answers landed: a waiting `peek` reads again. */
	let revision = $state(0);
	let cancelFrame: (() => void) | null = null;

	const store = createClassifierStore({
		run(curve, signal) {
			worker ??= classifyClient(options);
			return worker.classify(curve.bands, curve.preampDb, signal);
		},
		onAnswer() {
			if (disposed || cancelFrame !== null) return;
			cancelFrame = nextFrame(() => {
				cancelFrame = null;
				if (!disposed) revision++;
			});
		}
	});

	return {
		peek(curve) {
			const key = curveKey(curve.bands, curve.preampDb);
			const answered = store.answered(key);
			if (answered !== null) return answered.classification;
			// Still waiting: read again when answers land.
			void revision;
			const known = store.known(curve.bands, curve.preampDb, key);
			if (known !== null) return known.classification;
			if (disposed || typeof window === 'undefined') return null;
			store.request(key, () => {
				const bands: readonly Band[] = $state.snapshot(curve.bands);
				return { bands, preampDb: curve.preampDb };
			});
			return null;
		},
		classify(curve, signal) {
			const bands: readonly Band[] = $state.snapshot(curve.bands);
			return store.classify({ bands, preampDb: curve.preampDb }, signal);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			cancelFrame?.();
			cancelFrame = null;
			store.dispose();
			worker?.dispose();
			worker = null;
		}
	};
}
