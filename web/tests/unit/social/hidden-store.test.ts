import { get } from 'svelte/store';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHiddenStore } from '#lib/social/hidden-store.ts';
import {
	authorHiddenId,
	hiddenLabelText,
	HIDDEN_LIMIT,
	HIDDEN_STORAGE_KEY,
	isHidden,
	mergeHidden,
	normalizeHidden
} from '#lib/social/hidden.ts';

function memory() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		}
	};
}
function api() {
	return {
		myHidden: vi.fn(async () => ({ items: [] })),
		putHidden: vi.fn(async () => ({ items: [] })),
		deleteHidden: vi.fn(async () => ({ items: [] }))
	};
}

afterEach(() => vi.restoreAllMocks());

describe('hidden preferences format', () => {
	test('labels truncate at 80 code points without splitting supplementary characters', () => {
		expect(hiddenLabelText(` \n${'🎧'.repeat(81)}\t `)).toBe('🎧'.repeat(80));
		expect(hiddenLabelText(`${'a'.repeat(79)}🎧z`)).toBe(`${'a'.repeat(79)}🎧`);
	});
	test('validates, deduplicates, bounds each type, and keeps only associated plain-text labels', () => {
		const list = normalizeHidden({
			authors: [
				'GEOFF',
				'geoff',
				null,
				'<script>',
				...Array.from({ length: 600 }, (_, i) => `a${i}`)
			],
			curves: ['Lineage_A', 'Lineage_A', '', 1],
			labels: {
				authors: { geoff: 'Geoff\n', absent: 'not retained' },
				curves: { Lineage_A: 'A'.repeat(100) }
			}
		});
		expect(list.authors).toHaveLength(HIDDEN_LIMIT);
		expect(list.authors[0]).toBe('geoff');
		expect(list.curves).toEqual(['Lineage_A']);
		expect(list.labels.authors).toEqual({ geoff: 'Geoff' });
		expect(list.labels.curves.Lineage_A).toHaveLength(80);
		expect(normalizeHidden(null)).toMatchObject({ authors: [], curves: [] });
	});
	test('union and filtering use stable author and lineage ids, not editable display names', () => {
		const list = mergeHidden(
			{ authors: ['id1'], curves: ['curve1'] },
			{ authors: ['id1', 'id2'], curves: ['curve2'] }
		);
		expect(list.authors).toEqual(['id1', 'id2']);
		expect(list.curves).toEqual(['curve1', 'curve2']);
		expect(isHidden(list, 'other', authorHiddenId({ id: 'id1', username: 'renamed' }))).toBe(true);
		expect(isHidden(list, 'curve1', null)).toBe(true);
		expect(isHidden(list, 'other', null)).toBe(false);
	});
});

describe('hidden store', () => {
	test('unknown sessions retain local hides and request a session retry without treating them as anonymous', async () => {
		const storage = memory();
		storage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify({ authors: ['ana'], curves: ['blocked'] }));
		const remote = api();
		const retrySession = vi.fn();
		const store = createHiddenStore(remote, () => storage, retrySession);
		await store.setUser(undefined);
		expect(get(store)).toMatchObject({ authors: ['ana'], curves: ['blocked'], ready: false, error: true, loadError: true });
		expect(store.visible('anything')).toBe(false);
		await store.retry();
		expect(retrySession).toHaveBeenCalledOnce();
		expect(remote.myHidden).not.toHaveBeenCalled();
		await store.setUser(null);
		expect(store.visible('anything')).toBe(true);
		expect(store.visible('blocked')).toBe(false);
	});
	test('list-load errors are separate from failed writes and clear after a successful retry', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const remote = api();
		const store = createHiddenStore(remote, () => memory());
		await store.setUser('me');
		remote.putHidden.mockRejectedValueOnce(new Error('write failed'));
		await expect(store.hide('curve', 'blocked')).rejects.toThrow('write failed');
		expect(get(store)).toMatchObject({ ready: true, error: true, loadError: false });
		remote.myHidden.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
		await store.retry();
		expect(get(store)).toMatchObject({ ready: false, error: true, loadError: true });
		await store.retry();
		expect(get(store)).toMatchObject({ ready: true, error: false, loadError: false });
	});
	test('visitors persist labels with ids, restore across mounts and unhide without an API request', async () => {
		const storage = memory();
		const remote = api();
		const store = createHiddenStore(remote, () => storage);
		expect(store.visible('curve1', 'author1')).toBe(false);
		await store.setUser(null);
		await store.hide('author', 'author1', 'Geoff');
		await store.hide('curve', 'curve1', 'Night radio');
		expect(store.visible('another', 'author1')).toBe(false);
		expect(store.visible('curve1', 'another')).toBe(false);
		const restored = createHiddenStore(remote, () => storage);
		await restored.setUser(null);
		expect(get(restored).labels).toEqual({
			authors: { author1: 'Geoff' },
			curves: { curve1: 'Night radio' }
		});
		await restored.unhide('curve', 'curve1');
		await restored.unhide('author', 'author1');
		expect(restored.visible('curve1', 'author1')).toBe(true);
		expect(JSON.parse(storage.getItem(HIDDEN_STORAGE_KEY) ?? '')).toMatchObject({
			authors: [],
			curves: [],
			labels: { authors: {}, curves: {} }
		});
		expect(remote.myHidden).not.toHaveBeenCalled();
		expect(remote.putHidden).not.toHaveBeenCalled();
	});
	test('sign-in sends a union with cached labels and clears local data only after success', async () => {
		const storage = memory();
		storage.setItem(
			HIDDEN_STORAGE_KEY,
			JSON.stringify({
				authors: ['local'],
				curves: ['c1'],
				labels: { authors: { local: 'Local author' }, curves: { c1: 'Local curve' } }
			})
		);
		const putHidden = vi.fn(async () => ({
			items: [
				{ targetType: 'author' as const, targetId: 'local', createdAt: 1, label: 'Local author' },
				{ targetType: 'curve' as const, targetId: 'c1', createdAt: 1, label: 'Local curve' },
				{ targetType: 'curve' as const, targetId: 'remote', createdAt: 2, label: 'Remote curve' }
			]
		}));
		const store = createHiddenStore({ ...api(), putHidden }, () => storage);
		await store.setUser('user1');
		expect(putHidden).toHaveBeenCalledWith(
			expect.objectContaining({ authors: ['local'], curves: ['c1'] })
		);
		expect(get(store)).toMatchObject({
			authors: ['local'],
			curves: ['c1', 'remote'],
			signedIn: true,
			ready: true
		});
		expect(storage.getItem(HIDDEN_STORAGE_KEY)).toBeNull();
		await store.setUser(null);
		expect(get(store)).toMatchObject({
			authors: [],
			curves: [],
			labels: { authors: {}, curves: {} },
			signedIn: false
		});
	});
	test('failed merges retain local preferences, fail closed, and can be retried', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const storage = memory();
		storage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify({ authors: ['local'], curves: [] }));
		const remote = api();
		remote.putHidden.mockRejectedValueOnce(new Error('offline'));
		const store = createHiddenStore(remote, () => storage);
		await store.setUser('user1');
		expect(get(store)).toMatchObject({ ready: false, error: true, busy: false });
		expect(storage.getItem(HIDDEN_STORAGE_KEY)).not.toBeNull();
		await store.retry();
		expect(get(store).ready).toBe(true);
		expect(storage.getItem(HIDDEN_STORAGE_KEY)).toBeNull();
	});
	test('signed-in hide and unhide use the API and never write account preferences locally', async () => {
		const storage = memory();
		const putHidden = vi.fn(async () => ({
			items: [{ targetType: 'curve' as const, targetId: 'c1', createdAt: 1, label: 'Radio' }]
		}));
		const remote = { ...api(), putHidden };
		const store = createHiddenStore(remote, () => storage);
		await store.setUser('user1');
		await store.hide('curve', 'c1', 'Radio');
		expect(get(store).labels.curves.c1).toBe('Radio');
		await store.unhide('curve', 'c1');
		expect(remote.deleteHidden).toHaveBeenCalledWith({ targetType: 'curve', targetId: 'c1' });
		expect(get(store).curves).toEqual([]);
		expect(storage.getItem(HIDDEN_STORAGE_KEY)).toBeNull();
	});
	test('an overflowing sign-in merge remains manageable without dropping either list', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const storage = memory();
		storage.setItem(
			HIDDEN_STORAGE_KEY,
			JSON.stringify({
				authors: [],
				curves: ['pending'],
				labels: { authors: {}, curves: { pending: 'Pending' } }
			})
		);
		const items = Array.from({ length: 500 }, (_, i) => ({
			targetType: 'curve' as const,
			targetId: `remote${i}`,
			createdAt: 1,
			label: `Remote ${i}`
		}));
		const putHidden = vi.fn(async () => {
			throw new Error('QUOTA_EXCEEDED');
		});
		const store = createHiddenStore(
			{ ...api(), putHidden, myHidden: async () => ({ items }) },
			() => storage
		);
		await store.setUser('user1');
		expect(get(store).curves).toHaveLength(501);
		expect(get(store).ready).toBe(false);
		await store.unhide('curve', 'pending');
		expect(get(store).ready).toBe(true);
		expect(get(store).curves).toHaveLength(500);
		expect(storage.getItem(HIDDEN_STORAGE_KEY)).toBeNull();
	});
	test('enforces the local cap without dropping older targets; unhiding frees a slot', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const storage = memory();
		storage.setItem(
			HIDDEN_STORAGE_KEY,
			JSON.stringify({ authors: [], curves: Array.from({ length: 500 }, (_, i) => `c${i}`) })
		);
		const store = createHiddenStore(api(), () => storage);
		await store.setUser(null);
		await expect(store.hide('curve', 'overflow', 'Overflow')).rejects.toThrow('limit');
		expect(get(store).curves).toHaveLength(500);
		await store.unhide('curve', 'c0');
		await store.hide('curve', 'overflow', 'Overflow');
		expect(get(store).curves).toContain('overflow');
	});
	test('late account reads never populate a different session or clear its local list', async () => {
		let release: (value: {
			items: { targetType: 'curve'; targetId: string; createdAt: number; label: null }[];
		}) => void = () => undefined;
		const myHidden = () =>
			new Promise<{
				items: { targetType: 'curve'; targetId: string; createdAt: number; label: null }[];
			}>((resolve) => {
				release = resolve;
			});
		const storage = memory();
		const store = createHiddenStore({ ...api(), myHidden }, () => storage);
		const pending = store.setUser('old-account');
		await store.setUser(null);
		await store.hide('curve', 'local', 'Local');
		release({ items: [{ targetType: 'curve', targetId: 'old', createdAt: 1, label: null }] });
		await pending;
		expect(get(store).curves).toEqual(['local']);
		expect(storage.getItem(HIDDEN_STORAGE_KEY)).toContain('local');
	});
	test('bad JSON recovers safely; storage failures do not pretend the change was saved', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const storage = memory();
		storage.setItem(HIDDEN_STORAGE_KEY, '{broken');
		const store = createHiddenStore(api(), () => storage);
		await store.setUser(null);
		expect(get(store).ready).toBe(true);
		vi.spyOn(storage, 'setItem').mockImplementation(() => {
			throw new Error('quota');
		});
		await expect(store.hide('curve', 'c1')).rejects.toThrow('quota');
		expect(get(store)).toMatchObject({ curves: [], error: true, busy: false });
	});
});
