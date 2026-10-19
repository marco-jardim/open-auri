// The merge banner cancels its merge when it goes away: the classifier gets the banner's signal,
// aborted on unmount, so no batch is sent after that and its worker is disposed. While it runs,
// progress moves as each batch goes out (the batches are pipelined with the classification).
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import { m } from '#lib/paraglide/messages.js';
import type { LibraryMergeItem, MergeReport } from '#lib/social/index.ts';
import MergeBanner from '#lib/components/pages/biblioteca/MergeBanner.svelte';
import {
	readMergeFlag,
	type KeyValueStorage,
	type LocalLibraryItem
} from '#lib/components/pages/biblioteca/social.ts';

const mocks = vi.hoisted(() => ({
	/** Items answered at once; later ones wait until aborted. */
	open: 0,
	signals: [] as (AbortSignal | undefined)[],
	dispose: vi.fn()
}));
vi.mock('#lib/workers/classifier.svelte.ts', () => ({
	createClassifier: () => ({
		peek: () => null,
		classify: (_curve: unknown, signal?: AbortSignal) => {
			mocks.signals.push(signal);
			if (mocks.signals.length <= mocks.open) {
				return Promise.resolve({
					classification: { class: 'standard', waived: [], reasons: [] },
					gateRuns: 1
				});
			}
			return new Promise((_resolve, reject) => {
				signal?.addEventListener('abort', () =>
					reject(new DOMException('Classification cancelled', 'AbortError'))
				);
			});
		},
		dispose: mocks.dispose
	})
}));

afterEach(async () => {
	await cleanup();
	mocks.open = 0;
	mocks.signals = [];
	mocks.dispose.mockReset();
});

function memoryStorage(): KeyValueStorage {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => {
			data.set(key, value);
		}
	};
}

/** Local items whose codes decode, so each one is classified for its weight. */
function locals(count: number): LocalLibraryItem[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `loc${index}`,
		name: `Curva ${index}`,
		s1: encodeS1({
			preampDb: -3,
			bands: [
				{ kind: 'PK', freqHz: 100 + index * 10, gainDb: -3, qFactor: 1 },
				...NEUTRO.bands.slice(1)
			]
		}),
		updatedAt: 10
	}));
}

const mergeLibrary = () =>
	vi.fn(async (batch: LibraryMergeItem[]): Promise<MergeReport> => ({
		created: batch.map((entry) => ({ localId: entry.localId, lineageId: `l-${entry.localId}` })),
		duplicates: [],
		rejected: [],
		conflicts: []
	}));

test('unmounting mid-merge aborts the classification: no batch is sent after it', async () => {
	mocks.open = 20;
	const api = { mergeLibrary: mergeLibrary() };
	const storage = memoryStorage();
	const screen = await render(MergeBanner, {
		items: locals(45),
		account: 'u-ana',
		verified: true,
		api,
		storage,
		locale: 'pt-BR'
	});
	await page.getByRole('button', { name: m.biblioteca_social_merge_action() }).click();
	// The first batch went out while the 21st item is still being classified.
	await expect.poll(() => api.mergeLibrary.mock.calls.length).toBe(1);
	await expect
		.element(page.getByRole('status'))
		.toMatchTextContent(m.biblioteca_social_merge_running({ done: 20, total: 45 }));
	await expect.poll(() => mocks.signals.length).toBe(21);
	const signal = mocks.signals[20];
	expect(signal?.aborted).toBe(false);
	await screen.unmount();
	expect(signal?.aborted).toBe(true);
	await expect.poll(() => mocks.dispose.mock.calls.length).toBe(1);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(api.mergeLibrary).toHaveBeenCalledOnce();
	expect(mocks.signals).toHaveLength(21);
	// Cancelled, not finished: the merge flag is not written.
	expect(readMergeFlag(storage, 'u-ana').handled).toEqual([]);
});

test('unmounting before any batch went out sends nothing', async () => {
	const api = { mergeLibrary: mergeLibrary() };
	const screen = await render(MergeBanner, {
		items: locals(3),
		account: 'u-ana',
		verified: true,
		api,
		storage: memoryStorage(),
		locale: 'pt-BR'
	});
	await page.getByRole('button', { name: m.biblioteca_social_merge_action() }).click();
	await expect.poll(() => mocks.signals.length).toBe(1);
	await screen.unmount();
	expect(mocks.signals[0]?.aborted).toBe(true);
	await expect.poll(() => mocks.dispose.mock.calls.length).toBe(1);
	expect(api.mergeLibrary).not.toHaveBeenCalled();
});
