// Filter labels persisted with the curve (design A, open-auri/preset@2): `CurveData.labels` in the
// editor store, `oa.current`, the undo history and the local library. Never part of the curve
// signature, the library dedupe key or S1.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import { createLibraryStore, createStorage } from '../../../src/lib/state/index.ts';
import type { CurveData } from '../../../src/lib/state/index.ts';
import { createCurveStore, CURRENT_STORAGE_KEY } from '../../../src/lib/state/curve.svelte.ts';
import { LibraryUpdateError } from '../../../src/lib/state/library.svelte.ts';
import {
	checkedCurve,
	checkedLabels,
	curveSignature,
	sameLabels
} from '../../../src/lib/state/model.ts';
import { MemoryStorage } from './fakes.ts';

const disposables: { dispose(): void }[] = [];
function own<T extends { dispose(): void }>(value: T): T {
	disposables.push(value);
	return value;
}
afterEach(() => {
	for (const disposable of disposables.reverse()) disposable.dispose();
	disposables.length = 0;
});

function adapter(local = new MemoryStorage(), indexedDB: IDBFactory | null = new IDBFactory()) {
	return own(createStorage({ local, session: new MemoryStorage(), indexedDB, channel: null }));
}
/** Ten entries; missing ones are null. */
function ten(entries: readonly (string | null)[]): (string | null)[] {
	return Array.from({ length: 10 }, (_, index) => entries[index] ?? null);
}
function padrao(name = 'Padrão'): CurveData {
	return {
		name,
		source: 'custom',
		preampDb: PADRAO_AURI.preampDb,
		bands: PADRAO_AURI.bands
	};
}
function clock(start = 1_000) {
	let at = start;
	return () => ++at;
}

describe('checkedCurve and checkedLabels (lenient core normalizeLabels)', () => {
	it('loads legacy records without labels as null', () => {
		const curve = checkedCurve({ ...padrao(), schema: 1, updatedAt: 1 });
		expect(curve.labels).toBeNull();
		expect(Object.isFrozen(curve)).toBe(true);
	});

	it('normalizes like the S5 name, drops refused entries and malformed lists', () => {
		const raw = ten(['  Ｇｒａｖｅ  ', 'evil.com', 'a\tb', 'x'.repeat(25), '', 'Ar']);
		const labels = checkedLabels(raw);
		expect(labels).toEqual(ten(['Grave', null, null, null, null, 'Ar']));
		expect(Object.isFrozen(labels)).toBe(true);
		const malformed: unknown[] = [
			undefined,
			null,
			'Grave',
			{},
			ten([]),
			Array(9).fill('a'),
			ten(['evil.com'])
		];
		for (const value of malformed) expect(checkedLabels(value)).toBeNull();
		// A malformed list never makes the curve unreadable.
		const curve = checkedCurve({ ...padrao(), labels: 'Grave', schema: 1, updatedAt: 1 });
		expect(curve.labels).toBeNull();
	});

	it('keeps labels out of the curve signature and S1', () => {
		const plain = checkedCurve({ ...padrao(), schema: 1, updatedAt: 1 });
		const named = checkedCurve({ ...padrao(), labels: ten(['Grave']), schema: 1, updatedAt: 1 });
		expect(curveSignature(named)).toBe(curveSignature(plain));
		expect(encodeS1(named)).toBe(encodeS1(plain));
		expect(sameLabels(null, undefined)).toBe(true);
		expect(sameLabels(named.labels, ten(['Grave']))).toBe(true);
		expect(sameLabels(named.labels, null)).toBe(false);
	});

	it('sameLabels: absent, null and an all-null list are the same (no labels)', () => {
		for (const none of [null, undefined, ten([]), [], [null, null]]) {
			expect(sameLabels(none, null), JSON.stringify(none)).toBe(true);
			expect(sameLabels(undefined, none), JSON.stringify(none)).toBe(true);
			expect(sameLabels(ten([]), none), JSON.stringify(none)).toBe(true);
			expect(sameLabels(none, ten(['Grave'])), JSON.stringify(none)).toBe(false);
			expect(sameLabels(ten(['Grave']), none), JSON.stringify(none)).toBe(false);
		}
		// Named lists are still compared entry by entry.
		expect(sameLabels(ten(['Grave']), ten([null, 'Grave']))).toBe(false);
		expect(sameLabels(ten(['Grave', 'Ar']), ten(['Grave', 'Ar']))).toBe(true);
	});
});

describe('curve store labels', () => {
	it('loads a legacy oa.current with labels = null', () => {
		const local = new MemoryStorage();
		local.setItem(CURRENT_STORAGE_KEY, JSON.stringify({ ...padrao(), schema: 1, updatedAt: 5 }));
		const store = own(createCurveStore({ storage: adapter(local), now: clock() }));
		expect(store.current.labels).toBeNull();
		expect(store.labels).toEqual([]);
	});

	it('persists labels in oa.current and reloads them', () => {
		const local = new MemoryStorage();
		const storage = adapter(local);
		const store = own(createCurveStore({ storage, now: clock() }));
		expect(store.set(padrao())).toBe(true);
		expect(store.setLabels(['Grave', null, ' Ar '])).toBe(true);
		expect(store.labels).toEqual(ten(['Grave', null, 'Ar']));
		const saved = JSON.parse(local.getItem(CURRENT_STORAGE_KEY) ?? 'null');
		expect(saved.labels).toEqual(ten(['Grave', null, 'Ar']));
		const reloaded = own(createCurveStore({ storage, now: clock(10_000) }));
		expect(reloaded.current.labels).toEqual(ten(['Grave', null, 'Ar']));
	});

	it('a label-only set is a real, undoable change that never dirties the cable', () => {
		const store = own(createCurveStore({ storage: adapter(), now: clock() }));
		store.set(padrao());
		store.markWritten();
		const before = store.current;
		const undo = store.undoCount;
		expect(store.set({ ...before, labels: ten(['Sub']) })).toBe(true);
		expect(store.current.labels).toEqual(ten(['Sub']));
		expect(store.current.updatedAt).toBeGreaterThan(before.updatedAt);
		expect(store.undoCount).toBe(undo + 1);
		expect(store.dirty).toBe(false);
		// The same labels again: a no-op.
		expect(store.set({ ...store.current, labels: ten(['Sub']) })).toBe(true);
		expect(store.undoCount).toBe(undo + 1);
		expect(store.undo()).toBe(true);
		expect(store.current.labels).toBeNull();
		expect(store.redo()).toBe(true);
		expect(store.current.labels).toEqual(ten(['Sub']));
	});

	it('update keeps labels; loadPreset and a set without labels clear them', () => {
		const store = own(createCurveStore({ storage: adapter(), now: clock() }));
		store.set({ ...padrao(), labels: ten(['Grave']) });
		expect(store.update({ preampDb: PADRAO_AURI.preampDb - 1 })).toBe(true);
		expect(store.current.labels).toEqual(ten(['Grave']));
		expect(store.loadPreset(NEUTRO.id)).toBe(true);
		expect(store.current.labels).toBeNull();
		store.set({ ...padrao(), labels: ten(['Grave']) });
		store.set(padrao('Outra'));
		expect(store.current.labels).toBeNull();
		// All-null labels are no labels.
		store.set({ ...padrao(), labels: ten([]) });
		expect(store.current.labels).toBeNull();
	});
});

describe('library labels', () => {
	async function library(storage = adapter()) {
		let next = 0;
		const store = own(createLibraryStore({ storage, now: clock(), id: () => `id-${++next}` }));
		await store.ready;
		return store;
	}

	it('saves labels with the item and loads legacy records as null', async () => {
		const storage = adapter();
		await storage.updateRecords('library', () => ({
			put: [
				{
					...padrao('Legada'),
					id: 'legacy',
					s1: encodeS1(padrao()),
					favorite: false,
					createdAt: 1,
					updatedAt: 1
				}
			]
		}));
		const store = await library(storage);
		const items = await store.list();
		expect(items[0]?.labels).toBeNull();
		const saved = await store.save({ ...padrao(), labels: ten(['Grave', 'evil.com']) });
		expect(saved?.labels).toEqual(ten(['Grave']));
		expect(saved?.id).toBe('legacy');
	});

	it('keeps the previous labels only for the same S1; a permuted re-save drops them', async () => {
		const store = await library();
		const first = await store.save({ ...padrao(), labels: ten(['Grave']) });
		expect(first?.labels).toEqual(ten(['Grave']));
		// Same curve, no labels key: the record keeps its labels.
		const again = await store.save(padrao('Renomeada'));
		expect(again?.id).toBe(first?.id);
		expect(again?.labels).toEqual(ten(['Grave']));
		// Explicit null clears them.
		const cleared = await store.save({ ...padrao(), labels: null });
		expect(cleared?.labels).toBeNull();
		await store.save({ ...padrao(), labels: ten(['Grave']) });
		// Same canonical curve in another wire order: deduplicated, labels dropped.
		const permuted = { ...padrao(), bands: [...PADRAO_AURI.bands].reverse() };
		expect(encodeS1(permuted)).not.toBe(encodeS1(padrao()));
		const moved = await store.save(permuted);
		expect(moved?.id).toBe(first?.id);
		expect(moved?.labels).toBeNull();
		expect(store.items).toHaveLength(1);
	});

	it('update sets labels with the strict S5 rules and otherwise keeps them', async () => {
		const store = await library();
		const item = await store.save({ ...padrao(), labels: ten(['Grave']) });
		if (!item) throw new Error('save failed');
		const renamed = await store.update(item.id, { name: 'Outro nome' });
		expect(renamed.labels).toEqual(ten(['Grave']));
		const relabelled = await store.update(item.id, { labels: ten([null, ' Ar ']) });
		expect(relabelled.labels).toEqual(ten([null, 'Ar']));
		const unchanged = await store.update(item.id, { labels: ten([null, 'Ar']) });
		expect(unchanged.updatedAt).toBe(relabelled.updatedAt);
		const error = await store.update(item.id, { labels: ten(['evil.com']) }).then(
			() => null,
			(cause: unknown) => cause
		);
		expect(error).toBeInstanceOf(LibraryUpdateError);
		if (!(error instanceof LibraryUpdateError)) return;
		expect(error.code).toBe('invalid-text');
		expect(error.issues).toContainEqual({ field: 'labels', code: 'env:url' });
		const count = await store.update(item.id, { labels: ['a'] }).then(
			() => null,
			(cause: unknown) => cause
		);
		expect(count).toBeInstanceOf(LibraryUpdateError);
		expect((await store.update(item.id, { labels: null })).labels).toBeNull();
	});
});
