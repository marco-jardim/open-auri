/**
 * The library merge is pipelined (biblioteca/social.ts `runMerge`): a batch goes out as soon as
 * its gate weight is full while the next items are still being classified, so progress moves
 * from the first batch on; a cancelled merge sends nothing more; a classification failure stops
 * it like a failed request. Weights are the gate runs of each classification (`gateRuns`).
 */
import { afterEach, expect, test, vi } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import type { ClassifiedCurve } from '#lib/gate-verdicts.ts';
import type { LibraryMergeItem, MergeReport } from '#lib/social/index.ts';
import {
	mergeBatches,
	runMerge,
	type MergeClassify
} from '#lib/components/pages/biblioteca/social.ts';

afterEach(() => vi.restoreAllMocks());

const STANDARD: ClassifiedCurve = {
	classification: { class: 'standard', waived: [], reasons: [] },
	gateRuns: 1
};

/** `count` merge items with distinct curves that decode (so each one is classified). */
function items(count: number): LibraryMergeItem[] {
	return Array.from({ length: count }, (_, index) => ({
		localId: `p${index}`,
		name: `Curva ${index}`,
		s1: encodeS1({
			preampDb: -3,
			bands: [
				{ kind: 'PK', freqHz: 100 + index * 10, gainDb: -3, qFactor: 1 },
				...NEUTRO.bands.slice(1)
			]
		})
	}));
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Every item is created on the account. */
const created = async (batch: LibraryMergeItem[]): Promise<MergeReport> => ({
	created: batch.map((entry) => ({ localId: entry.localId, lineageId: `lin-${entry.localId}` })),
	duplicates: [],
	rejected: [],
	conflicts: []
});

/** Answers the first `open` items at once; later ones wait for `gate` (or the signal). */
function classifyHolding(open: number, gate: Promise<void>) {
	let weighed = 0;
	const classify = vi.fn<MergeClassify>(async (_curve, signal) => {
		weighed += 1;
		if (weighed > open) {
			await new Promise<void>((resolve, reject) => {
				void gate.then(resolve);
				signal?.addEventListener('abort', () =>
					reject(new DOMException('Classification cancelled', 'AbortError'))
				);
			});
		}
		return STANDARD;
	});
	return { classify, weighed: () => weighed };
}

test('the first batch goes out while the next items are still being classified', async () => {
	const gate = deferred();
	const { classify, weighed } = classifyHolding(20, gate.promise);
	const mergeLibrary = vi.fn(created);
	const progress = vi.fn();
	const running = runMerge({ mergeLibrary }, items(25), progress, { classify });
	await vi.waitFor(() => expect(mergeLibrary).toHaveBeenCalledOnce());
	expect(mergeLibrary.mock.calls[0]?.[0]).toHaveLength(20);
	// Progress moved with the first batch, before the library is classified.
	await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(20, 25));
	// The 21st item is being classified right now; nothing after it yet.
	await vi.waitFor(() => expect(weighed()).toBe(21));
	expect(classify).toHaveBeenCalledTimes(21);
	gate.resolve();
	const outcome = await running;
	expect(mergeLibrary.mock.calls.map(([batch]) => batch.length)).toEqual([20, 5]);
	expect(progress.mock.calls).toEqual([
		[20, 25],
		[25, 25]
	]);
	expect(outcome).toMatchObject({ error: null, unsent: 0 });
	expect(outcome.handled).toHaveLength(25);
});

test('cancelling stops the classification and sends nothing more', async () => {
	const gate = deferred();
	const { classify } = classifyHolding(20, gate.promise);
	const mergeLibrary = vi.fn(created);
	const controller = new AbortController();
	const running = runMerge({ mergeLibrary }, items(45), undefined, {
		classify,
		signal: controller.signal
	});
	await vi.waitFor(() => expect(mergeLibrary).toHaveBeenCalledOnce());
	await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(21));
	// The classifier got the merge's signal (aborted with it).
	const signal = classify.mock.calls[20]?.[1];
	controller.abort();
	await expect(running).rejects.toSatisfy(
		(error: unknown) => error instanceof DOMException && error.name === 'AbortError'
	);
	expect(signal?.aborted).toBe(true);
	gate.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(mergeLibrary).toHaveBeenCalledOnce();
	expect(classify).toHaveBeenCalledTimes(21);
});

test('a classification failure stops the merge like a failed request, keeping what was sent', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	let weighed = 0;
	const classify = vi.fn<MergeClassify>(async () => {
		weighed += 1;
		if (weighed > 20) throw new Error('worker crashed');
		return STANDARD;
	});
	const mergeLibrary = vi.fn(created);
	const outcome = await runMerge({ mergeLibrary }, items(25), undefined, { classify });
	expect(mergeLibrary).toHaveBeenCalledOnce();
	expect(outcome).toMatchObject({ error: 'INTERNAL', unsent: 5 });
	expect(outcome.handled).toHaveLength(20);
});

test('weights are the gate runs: a rejection that ran the YOLO profile costs 2', async () => {
	// Rejected after the YOLO run (every standard code was waivable): two runs on the server.
	const classify = vi.fn<MergeClassify>(async () => ({
		classification: { class: 'rejected', waived: [], reasons: [] },
		gateRuns: 2
	}));
	expect((await mergeBatches(items(12), { classify })).map((batch) => batch.length)).toEqual([
		10, 2
	]);
	// Rejected on the standard profile alone: one run.
	classify.mockResolvedValue({
		classification: { class: 'rejected', waived: [], reasons: [] },
		gateRuns: 1
	});
	expect((await mergeBatches(items(25), { classify })).map((batch) => batch.length)).toEqual([
		20, 5
	]);
});
