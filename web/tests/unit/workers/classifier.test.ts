/**
 * The background classifier (workers/classifier.svelte.ts): bulk classes (shelf badges, merge
 * weights) on a gate worker client of its own, one queued curve at a time, each answer kept for
 * the page's synchronous exits. Here (Node) the client runs its synchronous fallback.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { classifyCurve } from 'open-auri/safety';
import {
	clearGateVerdicts,
	knownClassification,
	type CurveClassification
} from '#lib/gate-verdicts.ts';
import { createClassifier } from '#lib/workers/classifier.svelte.ts';
import type { Band } from '#lib/workers/gate-handler.ts';

const pad = (active: Band[]): Band[] => [...active, ...NEUTRO.bands.slice(active.length)];
const yolo = { bands: pad([{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]), preampDb: -0.5 };
const plain = { bands: NEUTRO.bands.slice(), preampDb: NEUTRO.preampDb };

beforeEach(() => clearGateVerdicts());
afterEach(() => clearGateVerdicts());

test('classes come back in order, equal to the core, and stay known to the page', async () => {
	const classifier = createClassifier({ worker: false });
	const answers = await Promise.all([classifier.classify(yolo), classifier.classify(plain)]);
	expect(answers.map((answer) => answer.classification.class)).toEqual(['yolo', 'standard']);
	expect(answers[0]?.classification).toEqual(
		classifyCurve(yolo.bands, yolo.preampDb, { experimental: true })
	);
	// The runs the server counts: the YOLO profile ran for the YOLO curve only.
	expect(answers.map((answer) => answer.gateRuns)).toEqual([2, 1]);
	expect(knownClassification(yolo.bands, yolo.preampDb)?.class).toBe('yolo');
	expect(knownClassification(plain.bands, plain.preampDb)?.class).toBe('standard');
	classifier.dispose();
});

test('dispose rejects what is still queued and every later request', async () => {
	const classifier = createClassifier({ worker: false });
	const first = classifier.classify(yolo);
	const second = classifier.classify(plain);
	classifier.dispose();
	const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
	const settled = await Promise.allSettled([first, second, classifier.classify(yolo)]);
	for (const outcome of settled.slice(1)) {
		expect(outcome.status).toBe('rejected');
		if (outcome.status === 'rejected') expect(isAbort(outcome.reason)).toBe(true);
	}
	// The first one was already with the worker: it lands or is aborted, never left pending.
	expect(['fulfilled', 'rejected']).toContain(settled[0]?.status);
});

test('an aborted request never reaches the worker', async () => {
	const classifier = createClassifier({ worker: false });
	const controller = new AbortController();
	controller.abort();
	await expect(classifier.classify(yolo, controller.signal)).rejects.toSatisfy(
		(error: unknown) => error instanceof DOMException && error.name === 'AbortError'
	);
	expect(knownClassification(yolo.bands, yolo.preampDb)).toBeNull();
	classifier.dispose();
});

test('peek reads the page cache and queues nothing during SSR', () => {
	const classifier = createClassifier({ worker: false });
	expect(typeof window).toBe('undefined');
	expect(classifier.peek(yolo)).toBeNull();
	const known: CurveClassification | null = knownClassification(yolo.bands, yolo.preampDb);
	expect(known).toBeNull();
	classifier.dispose();
});
