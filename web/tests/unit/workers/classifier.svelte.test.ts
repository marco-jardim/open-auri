/**
 * The background classifier inside a real template (the shelf badges of Biblioteca): `peek`
 * runs while the template is evaluated, so its bookkeeping must never be a signal
 * (`state_unsafe_mutation`), and a library larger than the page cache (`CLASSIFICATIONS_KEPT`)
 * must settle: every tape classified exactly once, the queue drained, nothing queued again on
 * later passes. The client runs its synchronous fallback here, so each classification is one
 * `handleGateRequest` call of type `classify`.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import {
	CLASSIFICATIONS_KEPT,
	clearGateVerdicts,
	knownClassification
} from '#lib/gate-verdicts.ts';
import { handleGateRequest, type Band } from '#lib/workers/gate-handler.ts';
import { createClassifier, type Classifier } from '#lib/workers/classifier.svelte.ts';
import PeekShelf from './PeekShelf.svelte';

vi.mock('#lib/workers/gate-handler.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/workers/gate-handler.ts')>();
	return { ...actual, handleGateRequest: vi.fn(actual.handleGateRequest) };
});

let classifier: Classifier | null = null;
beforeEach(() => {
	clearGateVerdicts();
	vi.mocked(handleGateRequest).mockClear();
});
afterEach(async () => {
	await cleanup();
	classifier?.dispose();
	classifier = null;
	clearGateVerdicts();
});

const pad = (active: Band[]): Band[] => [...active, ...NEUTRO.bands.slice(active.length)];
const TAPES = 300;
/** Distinct standard curves: a −3 dB cut that moves with the index. */
const curves = Array.from({ length: TAPES }, (_, index) => ({
	bands: pad([{ kind: 'PK', freqHz: 100 + index, gainDb: -3, qFactor: 1 }]),
	preampDb: -3
}));

/** Every `classify` the worker client ran, with the curve it was asked about. */
const classified = () =>
	vi
		.mocked(handleGateRequest)
		.mock.calls.map(([request]) => request)
		.filter((request) => request.type === 'classify');

const frames = async (count: number) => {
	for (let frame = 0; frame < count; frame++) {
		await new Promise((resolve) => requestAnimationFrame(resolve));
	}
};

test('300 tapes are each classified once, the queue drains and nothing is queued again', async () => {
	expect(TAPES).toBeGreaterThan(CLASSIFICATIONS_KEPT);
	classifier = createClassifier({ worker: false });
	const screen = await render(PeekShelf, { classifier, curves });
	const badges = (state: string) => screen.container.querySelectorAll(`[data-class="${state}"]`);
	await expect.poll(() => badges('pending').length, { timeout: 30_000 }).toBe(0);
	expect(badges('standard')).toHaveLength(TAPES);
	expect(classified()).toHaveLength(TAPES);
	// Exactly once each: no curve was sent twice.
	const sent = new Set(classified().map((request) => JSON.stringify(request.bands)));
	expect(sent.size).toBe(TAPES);
	// The page cache evicted the first classes; the classifier never sends them back.
	expect(knownClassification(curves[0]?.bands ?? [], -3)).toBeNull();
	await frames(10);
	expect(classified()).toHaveLength(TAPES);
	// A new pass (the shelf sorted the other way) is answered without the worker.
	await screen.rerender({ curves: [...curves].reverse() });
	await frames(5);
	expect(badges('standard')).toHaveLength(TAPES);
	expect(classified()).toHaveLength(TAPES);
}, 60_000);
