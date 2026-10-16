import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { appendEntry, parseJournal, serializeJournal } from 'open-auri/policy';
import { canonKey, encodeS1 } from 'open-auri/share';
import {
	createClientState,
	createCurveStore,
	createFlashStore,
	createJournalStore,
	createLibraryStore,
	createMeterRefStore,
	createOutboxStore,
	createStorage
} from '../../../src/lib/state/index.ts';
import type { ClientStorage, CurveData } from '../../../src/lib/state/index.ts';
import { createTabs, MemoryStorage } from './fakes.ts';

const disposables: { dispose(): void }[] = [];
function own<T extends { dispose(): void }>(value: T): T {
	disposables.push(value);
	return value;
}
afterEach(() => {
	for (const disposable of disposables.reverse()) disposable.dispose();
	disposables.length = 0;
	vi.restoreAllMocks();
});

function adapter(
	local = new MemoryStorage(),
	session = new MemoryStorage(),
	indexedDB: IDBFactory | null = null
) {
	return own(createStorage({ local, session, indexedDB, channel: null }));
}
function curve(name = 'Neutro'): CurveData {
	return { name, source: 'custom', preampDb: NEUTRO.preampDb, bands: NEUTRO.bands };
}
function entry(at: number) {
	return {
		schema: 1 as const,
		at,
		name: `Write ${at}`,
		crc: NEUTRO.crc,
		preampDb: NEUTRO.preampDb,
		bands: NEUTRO.bands.map((band) => ({ ...band })),
		status: 'ok' as const,
		device: 'test device'
	};
}
async function seed(
	storage: ClientStorage,
	store: 'library' | 'outbox',
	values: Record<string, unknown>[]
) {
	await storage.updateRecords(store, () => ({ put: values }));
}

describe('storage keys and corruption', () => {
	it.each(['{', 'null', '[]', 'false', '42', '"broken"'])(
		'uses safe defaults for every malformed key: %s',
		async (raw) => {
			const local = new MemoryStorage();
			const session = new MemoryStorage();
			for (const key of [
				'oa.current',
				'oa.journal',
				'oa.flash.day',
				'oa.flash.total',
				'oa.flash.lastWriteAt',
				'oa.meter.ref'
			]) {
				local.setItem(key, raw);
			}
			session.setItem('oa.flash.session', raw);
			const state = own(
				createClientState({
					local,
					session,
					indexedDB: new IDBFactory(),
					channel: null,
					now: () => 1000
				})
			);
			await state.ready;
			expect(state.curve.current.name).toBe(NEUTRO.label);
			expect(state.curve.current.bands).toEqual(NEUTRO.bands);
			expect(state.curve.current.preampDb).toBe(-0.5);
			expect(state.journal.entries).toEqual([]);
			expect(state.flash.state.day).toEqual({ date: null, count: 0 });
			// Valid JSON numbers remain valid counters/timestamps; other corruption resets.
			expect(state.flash.state.total).toBe(raw === '42' ? 42 : 0);
			expect(state.flash.state.session).toBe(raw === '42' ? 42 : 0);
			expect(state.flash.canWriteNow(1000).ok).toBe(false);
			expect(state.meterRef.value).toBe(-18);
			expect(state.library.items).toEqual([]);
			expect(state.outbox.events).toEqual([]);
		}
	);

	it.each([
		{ schema: 2 },
		{ name: 3 },
		{ source: 'preset:' },
		{ source: 'untrusted' },
		{ preampDb: '0' },
		{ updatedAt: -1 },
		{ updatedAt: 1.5 },
		{ bands: [] },
		{ bands: [null, ...NEUTRO.bands.slice(1)] },
		{ bands: [{ kind: 'mystery' }, ...NEUTRO.bands.slice(1)] },
		{ bands: [{ kind: 'PK', freqHz: 100, gainDb: '1', qFactor: 1 }, ...NEUTRO.bands.slice(1)] },
		{ bands: [{ kind: 'PK', freqHz: 0, gainDb: 1, qFactor: 1 }, ...NEUTRO.bands.slice(1)] },
		{ bands: [{ kind: 'PK', freqHz: 100, gainDb: 1, qFactor: 0 }, ...NEUTRO.bands.slice(1)] }
	])('validates current structure as well as snapshotBands: %j', (patch) => {
		const local = new MemoryStorage();
		local.setItem(
			'oa.current',
			JSON.stringify({ ...curve(), schema: 1, updatedAt: 100, ...patch })
		);
		const store = own(createCurveStore({ storage: adapter(local) }));
		expect(store.current.source).toBe('preset:neutro');
		expect(store.error?.kind).toBe('invalid');
	});

	it('rejects holes and nonfinite values without changing the current curve', () => {
		const store = own(createCurveStore({ storage: adapter() }));
		const before = store.current;
		expect(store.update({ preampDb: NaN })).toBe(false);
		expect(store.update({ bands: new Array(10) })).toBe(false);
		expect(store.current).toBe(before);
		expect(store.undoCount).toBe(0);
	});

	it('drops corrupt IndexedDB records and mismatching S1 without losing valid records', async () => {
		const storage = adapter(undefined, undefined, new IDBFactory());
		await seed(storage, 'library', [
			{ id: 'bad', bands: [] },
			{ ...curve(), id: 'mismatch', favorite: false, s1: 'broken', createdAt: 1, updatedAt: 2 },
			{ ...curve(), id: 'good', favorite: true, s1: encodeS1(curve()), createdAt: 1, updatedAt: 2 }
		]);
		await seed(storage, 'outbox', [
			{ id: 'bad', type: false, payload: {}, createdAt: -1, updatedAt: 2 },
			{ id: 'good', type: 'favorite', payload: { curve: 'abc' }, createdAt: 1, updatedAt: 2 }
		]);
		const library = own(createLibraryStore({ storage }));
		const outbox = own(createOutboxStore({ storage }));
		await Promise.all([library.ready, outbox.ready]);
		expect(library.items.map((item) => item.id)).toEqual(['good']);
		expect(outbox.events.map((item) => item.id)).toEqual(['good']);
		expect(library.error?.kind).toBe('invalid');
	});

	it('does not access window on import and keeps SSR instances isolated', async () => {
		expect(typeof window).toBe('undefined');
		const first = own(createClientState({ channel: null }));
		const second = own(createClientState({ channel: null }));
		await Promise.all([first.ready, second.ready]);
		first.curve.update({ name: 'only first' });
		expect(second.curve.current.name).toBe('Neutro');
		expect(first.storage.error?.kind).toBe('unavailable');
	});
});

describe('curve history and written snapshot', () => {
	it('bounds both stacks at 100 and persists undo/redo with monotonic updatedAt', () => {
		const local = new MemoryStorage();
		const store = own(createCurveStore({ storage: adapter(local), now: () => 1000 }));
		for (let index = 1; index <= 120; index++) store.update({ name: String(index) });
		expect(store.undoCount).toBe(100);
		const beforeUndo = store.current.updatedAt;
		for (let index = 0; index < 100; index++) expect(store.undo()).toBe(true);
		expect(store.current.name).toBe('20');
		expect(store.undo()).toBe(false);
		expect(store.redoCount).toBe(100);
		for (let index = 0; index < 100; index++) expect(store.redo()).toBe(true);
		expect(store.current.name).toBe('120');
		expect(store.redo()).toBe(false);
		expect(store.current.updatedAt).toBeGreaterThan(beforeUndo);
		expect(JSON.parse(local.getItem('oa.current') ?? 'null')).toEqual(store.current);
		store.undo();
		store.update({ name: 'branch' });
		expect(store.canRedo).toBe(false);
	});

	it('compares DSP values, not metadata, with the actual successful write snapshot', () => {
		const store = own(createCurveStore({ storage: adapter() }));
		expect(store.dirty).toBe(true);
		const sent = store.current;
		store.markWritten(sent);
		expect(store.dirty).toBe(false);
		store.update({ name: 'rename' });
		expect(store.dirty).toBe(false);
		store.update({ preampDb: -1 });
		expect(store.dirty).toBe(true);
		store.markWritten(sent);
		expect(store.dirty).toBe(true);
		store.undo();
		expect(store.dirty).toBe(false);
		expect(Object.isFrozen(store.current.bands[0])).toBe(true);
	});

	it('loads exact catalog values and round-trips the storage contract', () => {
		const storage = adapter();
		const first = own(createCurveStore({ storage }));
		expect(first.loadPreset('padrao')).toBe(true);
		expect(first.current.bands).toEqual(PADRAO_AURI.bands);
		expect(first.current.preampDb).toBe(PADRAO_AURI.preampDb);
		const second = own(createCurveStore({ storage }));
		expect(second.current).toEqual(first.current);
		expect(first.loadPreset('missing')).toBe(false);
	});
});

describe('core policies', () => {
	it('uses core FIFO and serialization for the journal, including corrupt entries', () => {
		const local = new MemoryStorage();
		let expected: ReturnType<typeof parseJournal>['entries'] = [];
		for (let at = 1; at <= 500; at++) expected = appendEntry(expected, entry(at));
		local.setItem('oa.journal', JSON.stringify([null, ...expected]));
		const store = own(createJournalStore({ storage: adapter(local) }));
		expect(store.dropped).toBe(1);
		expect(store.append(entry(501))).toBe(true);
		expected = appendEntry(expected, entry(501));
		expect(store.entries).toEqual(expected);
		expect(store.entries[0].at).toBe(2);
		expect(local.getItem('oa.journal')).toBe(serializeJournal(expected));
		expect(store.append({ status: 'ok' })).toBe(false);
		expect(store.entries).toHaveLength(500);
	});

	it('exposes the newest ok entry (skipping interrupted/simulated) from persisted storage', () => {
		const local = new MemoryStorage();
		const store = own(createJournalStore({ storage: adapter(local) }));
		expect(store.lastOk).toBeNull();
		store.append({ ...entry(1), status: 'simulated' });
		expect(store.lastOk).toBeNull();
		store.append({ ...entry(2), preampDb: -4 });
		store.append({ ...entry(3), status: 'interrupted' });
		store.append({ ...entry(4), status: 'simulated' });
		expect(store.lastOk).toMatchObject({ at: 2, preampDb: -4, status: 'ok' });
		const copy = store.lastOk;
		if (copy === null) throw new Error('missing ok entry');
		copy.preampDb = 0;
		expect(store.lastOk?.preampDb).toBe(-4);
		// A new instance (reload or another tab) reads the same answer from storage.
		const reopened = own(createJournalStore({ storage: adapter(local) }));
		expect(reopened.lastOk).toMatchObject({ at: 2, preampDb: -4 });
	});

	it('tracks cooldown, real writes, rollover, sessions and the advisory notice', () => {
		const local = new MemoryStorage();
		const session = new MemoryStorage();
		let now = new Date(2026, 9, 16, 12).getTime();
		const store = own(createFlashStore({ storage: adapter(local, session), now: () => now }));
		expect(store.canWriteNow()).toEqual({ ok: false, waitMs: 2000 });
		expect(store.canWriteNow(now + 1999).ok).toBe(false);
		for (let index = 0; index < 50; index++) {
			now += 2000;
			expect(store.canWriteNow().ok).toBe(true);
			store.recordWrite();
		}
		expect(store.dailyNotice()).toBe(true);
		expect(store.state).toMatchObject({ total: 50, session: 50, day: { count: 50 } });
		expect(local.getItem('oa.flash.total')).toBe('50');
		expect(local.getItem('oa.flash.session')).toBeNull();
		expect(session.getItem('oa.flash.session')).toBe('50');
		now = new Date(2026, 9, 17, 12).getTime();
		store.recordWrite();
		expect(store.state).toMatchObject({ total: 51, session: 51, day: { count: 1 } });
		expect(store.dailyNotice()).toBe(false);
		const reopened = own(createFlashStore({ storage: adapter(local, session), now: () => now }));
		expect(reopened.state.session).toBe(51);
		const otherSession = own(createFlashStore({ storage: adapter(local), now: () => now }));
		expect(otherSession.state.session).toBe(0);
		expect(otherSession.state.total).toBe(51);
	});

	it('rebases a backwards clock once so polling eventually releases the cooldown', () => {
		const local = new MemoryStorage();
		local.setItem('oa.flash.lastWriteAt', '999999999');
		const store = own(createFlashStore({ storage: adapter(local), now: () => 1000 }));
		expect(store.canWriteNow(2999)).toEqual({ ok: false, waitMs: 1 });
		expect(store.canWriteNow(3000).ok).toBe(true);
		expect(local.getItem('oa.flash.lastWriteAt')).toBe('1000');
	});
});

describe('two tabs', () => {
	it('orders edits from equal clocks even before queued storage events arrive', () => {
		const tabs = createTabs();
		const a = own(
			createCurveStore({ storage: own(createStorage(tabs.options(0))), now: () => 1000 })
		);
		const b = own(
			createCurveStore({ storage: own(createStorage(tabs.options(1))), now: () => 1000 })
		);
		a.update({ name: 'first' });
		b.update({ name: 'second' });
		tabs.deliver();
		expect(a.current).toEqual(b.current);
		expect(a.current.name).toBe('second');
		expect(a.current.updatedAt).toBe(1001);
	});

	it('accepts newer external curves over a quota fallback and handles key removal', () => {
		const tabs = createTabs();
		const a = own(
			createCurveStore({ storage: own(createStorage(tabs.options(0))), now: () => 1000 })
		);
		const b = own(
			createCurveStore({ storage: own(createStorage(tabs.options(1))), now: () => 2000 })
		);
		tabs.local.failure = new DOMException('full', 'QuotaExceededError');
		a.update({ name: 'memory' });
		expect(a.current.name).toBe('memory');
		tabs.local.failure = null;
		b.update({ name: 'newer' });
		tabs.deliver();
		expect(a.current.name).toBe('newer');
		tabs.local.removeItem('oa.current');
		tabs.emit(0, { area: 'local', key: 'oa.current', newValue: null });
		expect(a.current.name).toBe('Neutro');
		expect(a.canUndo).toBe(false);
	});

	it('syncs current curves, ignores delayed old snapshots and resets local history', () => {
		const tabs = createTabs();
		const a = own(
			createCurveStore({ storage: own(createStorage(tabs.options(0))), now: () => 1000 })
		);
		const b = own(
			createCurveStore({ storage: own(createStorage(tabs.options(1))), now: () => 2000 })
		);
		a.update({ name: 'first' });
		tabs.deliver();
		expect(b.current.name).toBe('first');
		const old = JSON.stringify(a.current);
		b.update({ name: 'second' });
		tabs.deliver();
		expect(a.current.name).toBe('second');
		expect(a.canUndo).toBe(false);
		tabs.emit(0, { area: 'local', key: 'oa.current', newValue: old });
		expect(a.current.name).toBe('second');
		a.update({ preampDb: -2 });
		tabs.deliver();
		expect(b.current.preampDb).toBe(-2);
		expect(b.current.updatedAt).toBeGreaterThan(2000);
	});

	it('merges journal entries through core and syncs flash counters but not sessions', () => {
		const tabs = createTabs();
		let now = 1000;
		const a = own(createClientState({ ...tabs.options(0), now: () => now }));
		const b = own(createClientState({ ...tabs.options(1), now: () => now }));
		a.journal.append(entry(1));
		b.journal.append(entry(2));
		a.meterRef.set(-20);
		now += 2000;
		a.flash.recordWrite();
		tabs.deliver();
		expect(a.journal.entries.map((value) => value.at)).toEqual([1, 2]);
		expect(b.journal.entries.map((value) => value.at)).toEqual([1, 2]);
		expect(b.flash.state.total).toBe(1);
		expect(b.flash.state.session).toBe(0);
		expect(b.flash.canWriteNow().ok).toBe(false);
		expect(b.meterRef.value).toBe(-20);
		now += 2000;
		b.flash.recordWrite();
		tabs.deliver();
		expect(a.flash.state.total).toBe(2);
		expect(a.flash.state.session).toBe(1);
	});

	it('end-of-write touch moves lastWriteAt (also in other tabs) without counting again', () => {
		const tabs = createTabs();
		let now = 10_000;
		const a = own(createClientState({ ...tabs.options(0), now: () => now }));
		const b = own(createClientState({ ...tabs.options(1), now: () => now }));
		// Attempt counted before the first byte, then the write ends 400 ms later.
		a.flash.recordWrite();
		now += 400;
		a.flash.touchWrite();
		expect(a.flash.state).toMatchObject({ total: 1, session: 1, lastWriteAt: 10_400 });
		expect(a.flash.state.day.count).toBe(1);
		// A repeated touch at the same instant changes nothing and never counts.
		a.flash.touchWrite(10_400);
		expect(a.flash.state).toMatchObject({ total: 1, session: 1, lastWriteAt: 10_400 });
		tabs.deliver();
		expect(b.flash.state).toMatchObject({ total: 1, session: 0, lastWriteAt: 10_400 });
		// 2 s after the start but only 1.6 s after the end: still waiting, in both tabs.
		now = 12_000;
		expect(a.flash.canWriteNow()).toEqual({ ok: false, waitMs: 400 });
		expect(b.flash.canWriteNow()).toEqual({ ok: false, waitMs: 400 });
		now = 12_400;
		expect(b.flash.canWriteNow().ok).toBe(true);
		// A touch alone from the other tab is merged as well.
		b.flash.touchWrite(12_500);
		tabs.deliver();
		expect(a.flash.state).toMatchObject({ total: 1, session: 1, lastWriteAt: 12_500 });
	});

	it('syncs library/outbox changes by BroadcastChannel and rejects stale updatedAt', async () => {
		const tabs = createTabs(new IDBFactory());
		const a = own(createClientState({ ...tabs.options(0), now: () => 1000 }));
		const b = own(createClientState({ ...tabs.options(1), now: () => 2000 }));
		await Promise.all([a.ready, b.ready]);
		const saved = await a.library.save(curve('saved'));
		tabs.deliver();
		await vi.waitFor(() => expect(b.library.items[0]?.name).toBe('saved'));
		expect(saved).not.toBeNull();
		await b.library.setFavorite(saved?.id ?? '', true);
		tabs.deliver();
		await vi.waitFor(() => expect(a.library.items[0]?.favorite).toBe(true));
		await a.library.save({ ...curve('stale'), id: saved?.id, favorite: false, updatedAt: 1 });
		expect(a.library.items[0].favorite).toBe(true);
		const event = await a.outbox.append({
			id: 'event',
			type: 'installed',
			payload: { curve: 'saved' },
			updatedAt: 10
		});
		tabs.deliver();
		await vi.waitFor(() => expect(b.outbox.events[0]?.id).toBe('event'));
		await b.outbox.append({ id: 'event', type: 'stale', payload: null, updatedAt: 1 });
		expect(b.outbox.events[0].type).toBe('installed');
		await b.outbox.remove(event?.id ?? '');
		await b.library.remove(saved?.id ?? '');
		tabs.deliver();
		await vi.waitFor(() => {
			expect(a.outbox.events).toEqual([]);
			expect(a.library.items).toEqual([]);
		});
	});
});

describe('library, outbox and quota fallback', () => {
	it('creates the database/stores and deduplicates reordered bands using core canonKey', async () => {
		const indexedDB = new IDBFactory();
		const storage = adapter(undefined, undefined, indexedDB);
		const store = own(createLibraryStore({ storage, now: () => 1000 }));
		await store.ready;
		const input: CurveData = {
			name: 'Auri',
			source: 'preset:padrao',
			preampDb: PADRAO_AURI.preampDb,
			bands: PADRAO_AURI.bands
		};
		const first = await store.save(input);
		const reordered = {
			...input,
			name: 'Reordered',
			bands: [...input.bands].reverse(),
			favorite: true
		};
		expect(canonKey(input.bands, input.preampDb)).toBe(
			canonKey(reordered.bands, reordered.preampDb)
		);
		const second = await store.save(reordered);
		expect(store.items).toHaveLength(1);
		expect(second?.id).toBe(first?.id);
		expect(second?.createdAt).toBe(first?.createdAt);
		expect(second?.favorite).toBe(true);
		expect(second?.bands).toEqual(reordered.bands);
		const databases = await indexedDB.databases();
		expect(databases.map((database) => database.name)).toEqual(['open-auri']);
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('open-auri');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		expect([...db.objectStoreNames]).toEqual(['audio', 'library', 'outbox']);
		db.close();
	});

	it('serializes concurrent deduplication in shared IndexedDB transactions', async () => {
		const indexedDB = new IDBFactory();
		const a = own(
			createLibraryStore({ storage: adapter(undefined, undefined, indexedDB), id: () => 'a' })
		);
		const b = own(
			createLibraryStore({ storage: adapter(undefined, undefined, indexedDB), id: () => 'b' })
		);
		await Promise.all([a.ready, b.ready]);
		const saved = await Promise.all([a.save(curve('a')), b.save(curve('b'))]);
		expect(saved[0]?.id).toBe(saved[1]?.id);
		expect(await a.list()).toHaveLength(1);
	});

	it('keeps local/session writes in memory and surfaces quota errors without throwing', () => {
		const local = new MemoryStorage();
		const session = new MemoryStorage();
		const storage = adapter(local, session);
		const store = own(createCurveStore({ storage }));
		const flash = own(createFlashStore({ storage, now: () => 1000 }));
		local.failure = new DOMException('full', 'QuotaExceededError');
		session.failure = new DOMException('full', 'QuotaExceededError');
		expect(() => store.update({ name: 'memory' })).not.toThrow();
		expect(() => flash.recordWrite(3000)).not.toThrow();
		expect(store.current.name).toBe('memory');
		expect(JSON.parse(storage.read('local', 'oa.current') ?? 'null').name).toBe('memory');
		expect(storage.read('session', 'oa.flash.session')).toBe('1');
		expect(store.error?.kind).toBe('quota');
		local.failure = null;
		store.update({ name: 'persisted after recovery' });
		expect(JSON.parse(local.getItem('oa.current') ?? 'null').name).toBe('persisted after recovery');
	});

	it('keeps IndexedDB writes and removals in memory on quota failure and refresh', async () => {
		const storage = adapter(undefined, undefined, new IDBFactory());
		const library = own(createLibraryStore({ storage }));
		const outbox = own(createOutboxStore({ storage }));
		await Promise.all([library.ready, outbox.ready]);
		vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
			throw new DOMException('full', 'QuotaExceededError');
		});
		const saved = await library.save(curve('memory'));
		expect(saved?.name).toBe('memory');
		expect(library.error?.kind).toBe('quota');
		expect((await library.list())[0]?.name).toBe('memory');
		const pending = await outbox.append({ type: 'favorite', payload: { id: 'x' } });
		expect(outbox.events).toHaveLength(1);
		await outbox.refresh();
		expect(outbox.events[0].id).toBe(pending?.id);
		await library.remove(saved?.id ?? '');
		await outbox.remove(pending?.id ?? '');
		expect(await library.list()).toEqual([]);
		expect(await outbox.list()).toEqual([]);
	});

	it('handles disabled IndexedDB and rejects invalid inputs without rejections', async () => {
		const storage = adapter();
		const library = own(createLibraryStore({ storage }));
		const outbox = own(createOutboxStore({ storage }));
		await Promise.all([library.ready, outbox.ready]);
		expect(await library.save({ ...curve(), preampDb: -0.55 })).toBeNull();
		expect(await outbox.append({ type: '', payload: null })).toBeNull();
		expect(await library.save(curve('offline'))).not.toBeNull();
		expect(library.items[0].name).toBe('offline');
		expect(await outbox.append({ type: 'offline', payload: null })).not.toBeNull();
		expect(outbox.events).toHaveLength(1);
	});

	it('accepts only the three meter references and persists them', () => {
		const local = new MemoryStorage();
		const store = own(createMeterRefStore({ storage: adapter(local) }));
		for (const value of [-20, -14, -18] as const) {
			expect(store.set(value)).toBe(true);
			expect(store.value).toBe(value);
			expect(local.getItem('oa.meter.ref')).toBe(String(value));
		}
	});
});
