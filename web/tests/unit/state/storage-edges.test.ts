import { afterEach, expect, test, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createStorage, type StorageChange } from '#lib/state/storage.ts';
import { MemoryStorage } from './fakes.ts';

const storages: ReturnType<typeof createStorage>[] = [];

afterEach(() => {
	for (const storage of storages.splice(0)) storage.dispose();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function setup(indexedDB: IDBFactory | null = null) {
	const local = new MemoryStorage();
	const session = new MemoryStorage();
	const storage = createStorage({ local, session, indexedDB, channel: null });
	storages.push(storage);
	return { storage, local, session };
}

test('read errors and non-Error failures notify subscribers, which can unsubscribe', () => {
	const { storage, local } = setup();
	const seen = vi.fn();
	const stop = storage.onError(seen);
	vi.spyOn(local, 'getItem').mockImplementationOnce(() => {
		throw new Error('Denied read');
	});
	expect(storage.read('local', 'protected')).toBeNull();
	expect(storage.error).toMatchObject({
		kind: 'unavailable',
		operation: 'read:protected',
		message: 'Denied read'
	});
	storage.report('Malformed record', 'parse', true);
	expect(storage.error).toEqual({
		kind: 'invalid',
		operation: 'parse',
		message: 'Malformed record'
	});
	expect(seen).toHaveBeenCalledTimes(3);
	stop();
	storage.report({ name: 'QuotaExceededError' }, 'write');
	expect(storage.error?.kind).toBe('quota');
	expect(seen).toHaveBeenCalledTimes(3);
});

test('failed removals stay removed in memory until an external persisted value is accepted', () => {
	const { storage, local } = setup();
	local.setItem('draft', 'old');
	local.failure = new DOMException('Full', 'QuotaExceededError');
	expect(storage.write('local', 'draft', null)).toBe(false);
	expect(storage.read('local', 'draft')).toBeNull();
	expect(storage.readPersisted('local', 'draft')).toBe('old');
	local.failure = null;
	local.setItem('draft', 'external');
	storage.acceptExternal('local', 'draft');
	expect(storage.read('local', 'draft')).toBe('external');
	expect(storage.write('session', 'token', 'x')).toBe(true);
	expect(storage.write('session', 'token', null)).toBe(true);
	expect(storage.read('session', 'token')).toBeNull();
});

test('a failed database read retains the last good records and returns a detached copy', async () => {
	const { storage } = setup(new IDBFactory());
	await storage.updateRecords('outbox', () => ({ put: [{ id: 'saved', payload: { value: 1 } }] }));
	vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementationOnce(() => {
		throw new Error('Read denied');
	});
	const values = await storage.loadRecords('outbox');
	expect(values).toEqual([{ id: 'saved', payload: { value: 1 } }]);
	expect(storage.error).toMatchObject({ operation: 'indexeddb:read:outbox', kind: 'unavailable' });
	values[0].payload = null;
	expect(await storage.loadRecords('outbox')).toEqual([{ id: 'saved', payload: { value: 1 } }]);
});

test('invalid update callbacks report an error without poisoning later serialized updates', async () => {
	const { storage } = setup();
	expect(
		await storage.updateRecords('library', () => {
			throw new Error('Bad update');
		})
	).toEqual([]);
	expect(storage.error).toMatchObject({ operation: 'indexeddb:update:library', kind: 'invalid' });
	const input = { id: 'good', nested: { value: 1 } };
	expect(
		await storage.updateRecords('library', () => ({ put: [{ missingId: true }, input] }))
	).toEqual([input]);
	input.nested.value = 2;
	expect(await storage.loadRecords('library')).toEqual([{ id: 'good', nested: { value: 1 } }]);
	expect(await storage.updateRecords('library', () => ({ remove: ['good'] }))).toEqual([]);
});

test('native storage events route local/session only and stop after disposal', () => {
	const local = new MemoryStorage();
	const session = new MemoryStorage();
	const browser = Object.assign(new EventTarget(), {
		localStorage: local,
		sessionStorage: session,
		indexedDB: null
	});
	vi.stubGlobal('window', browser);
	const storage = createStorage({ channel: null });
	storages.push(storage);
	const seen: StorageChange[] = [];
	storage.onStorage((event) => seen.push(event));
	function emit(storageArea: Storage | null) {
		const event = new Event('storage');
		Object.defineProperties(event, {
			storageArea: { value: storageArea },
			key: { value: 'preference' },
			newValue: { value: 'changed' }
		});
		browser.dispatchEvent(event);
	}
	emit(local);
	emit(session);
	emit(null);
	expect(seen).toEqual([
		{ key: 'preference', newValue: 'changed', area: 'local' },
		{ key: 'preference', newValue: 'changed', area: 'session' }
	]);
	storage.dispose();
	emit(local);
	expect(seen).toHaveLength(2);
});
