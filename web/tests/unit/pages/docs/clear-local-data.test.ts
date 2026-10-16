import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, test, vi } from 'vitest';
import { clearLocalData, confirmedClear } from '#lib/components/pages/docs/clear-local-data.ts';

function storage(entries: Record<string, string>) {
	const data = new Map(Object.entries(entries));
	return {
		get length() {
			return data.size;
		},
		key: (index: number) => [...data.keys()][index] ?? null,
		removeItem: (key: string) => {
			data.delete(key);
		},
		data
	};
}

describe('confirmed local-only removal', () => {
	test('cancellation touches neither backend getters nor preparation', async () => {
		const backend = vi.fn(() => {
			throw new Error('must not read storage');
		});
		const prepare = vi.fn();
		expect(await confirmedClear(false, backend, prepare)).toBe(false);
		expect(backend).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
	});
	test('removes all and only oa.* keys and deletes the real named fake database', async () => {
		const factory = new IDBFactory();
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open('open-auri', 1);
			request.onupgradeneeded = () => request.result.createObjectStore('audio');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const local = storage({
			'oa.current': 'curve',
			'oa.lang': 'pt-BR',
			'oa.future.key': 'owned',
			'other.app': 'keep',
			oa: 'keep'
		});
		const session = storage({ 'oa.flash.session': '4', unrelated: 'keep' });
		const prepare = vi.fn(() => database.close());
		const deletion = vi.spyOn(factory, 'deleteDatabase');
		expect(
			await confirmedClear(true, () => ({ local, session, indexedDB: factory }), prepare)
		).toBe(true);
		expect(prepare).toHaveBeenCalledOnce();
		expect(deletion).toHaveBeenCalledExactlyOnceWith('open-auri');
		expect([...local.data.entries()]).toEqual([
			['other.app', 'keep'],
			['oa', 'keep']
		]);
		expect([...session.data.entries()]).toEqual([['unrelated', 'keep']]);
		expect(await factory.databases()).toEqual([]);
	});
	test('storage access or deletion errors are surfaced, not swallowed', async () => {
		const factory = new IDBFactory();
		vi.spyOn(factory, 'deleteDatabase').mockImplementation(() => {
			throw new DOMException('denied', 'SecurityError');
		});
		await expect(
			clearLocalData({ local: storage({}), session: storage({}), indexedDB: factory })
		).rejects.toThrow('denied');
		await expect(
			confirmedClear(true, () => {
				throw new Error('blocked storage');
			})
		).rejects.toThrow('blocked storage');
	});
	test('another open tab is reported as blocked instead of hanging or claiming success', async () => {
		const factory = new IDBFactory();
		const database = await new Promise<IDBDatabase>((resolve) => {
			const request = factory.open('open-auri', 1);
			request.onsuccess = () => resolve(request.result);
		});
		try {
			await expect(
				clearLocalData({ local: storage({}), session: storage({}), indexedDB: factory })
			).rejects.toThrow('blocked');
		} finally {
			database.close();
		}
	});
});
