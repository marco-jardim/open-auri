import { afterEach, expect, test, vi } from 'vitest';
import {
	SocialApiError,
	type LibraryMergeItem,
	type MyShareItem,
	type SocialApi,
	type SocialErrorCode
} from '#lib/social/index.ts';
import {
	MERGE_KEY,
	SHARES_PAGES_MAX,
	defaultStorage,
	errorKind,
	isAbort,
	readMergeFlag,
	runMerge,
	sharesOf,
	toMergeItem,
	unmergedItems,
	writeMergeFlag,
	type KeyValueStorage
} from '#lib/components/pages/biblioteca/social.ts';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function storage(value: string | null = null): KeyValueStorage {
	const values = new Map<string, string>();
	if (value !== null) values.set(MERGE_KEY, value);
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, next) => {
			values.set(key, next);
		}
	};
}

test('storage is optional, including browsers which deny access to localStorage', () => {
	vi.stubGlobal('localStorage', undefined);
	expect(defaultStorage()).toBeNull();
	const memory = storage();
	vi.stubGlobal('localStorage', memory);
	expect(defaultStorage()).toBe(memory);
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		get: () => {
			throw new DOMException('Denied', 'SecurityError');
		}
	});
	expect(defaultStorage()).toBeNull();
	expect(warn).toHaveBeenCalledWith(
		JSON.stringify({ event: 'biblioteca.storage', error: 'SecurityError' })
	);
	expect(readMergeFlag(null, 'u')).toEqual({ offeredAt: null, handled: [] });
	expect(() => writeMergeFlag(null, 'u', { offeredAt: null, handled: [] })).not.toThrow();
});

test.each([
	'null',
	'[]',
	'false',
	'42',
	'"text"',
	'{}',
	'{"u":null}',
	'{"u":1}',
	'{"u":{}}',
	'{"u":{"offeredAt":"1","handled":[]}}',
	'{"u":{"offeredAt":1e999,"handled":[]}}',
	'{"u":{"offeredAt":0,"handled":null}}',
	'{"u":{"offeredAt":null,"handled":[1]}}'
])('invalid stored flags fall back safely: %s', (raw) => {
	expect(readMergeFlag(storage(raw), 'u')).toEqual({ offeredAt: null, handled: [] });
});

test('corrupt JSON, denied reads and quota writes are nonfatal and logged', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	expect(readMergeFlag(storage('{broken'), 'u')).toEqual({ offeredAt: null, handled: [] });
	const denied: KeyValueStorage = {
		getItem: () => {
			throw new DOMException('Denied', 'SecurityError');
		},
		setItem: () => {
			throw new DOMException('Full', 'QuotaExceededError');
		}
	};
	expect(readMergeFlag(denied, 'u')).toEqual({ offeredAt: null, handled: [] });
	expect(() => writeMergeFlag(denied, 'u', { offeredAt: 0, handled: [] })).not.toThrow();
	expect(warn.mock.calls.map(([message]) => JSON.parse(String(message)).event)).toEqual([
		'biblioteca.storage.read',
		'biblioteca.storage.read',
		'biblioteca.storage.read',
		'biblioteca.storage.write'
	]);
});

test('flags preserve other accounts, copy handled ids, and retain only the latest 2000', () => {
	const memory = storage('{"other":{"offeredAt":0,"handled":["old"]}}');
	const handled = Array.from({ length: 2002 }, (_, index) => `id-${index}`);
	writeMergeFlag(memory, 'u', { offeredAt: 0, handled });
	const flag = readMergeFlag(memory, 'u');
	expect(flag).toEqual({ offeredAt: 0, handled: handled.slice(2) });
	flag.handled.push('mutated');
	expect(readMergeFlag(memory, 'u').handled).not.toContain('mutated');
	expect(readMergeFlag(memory, 'other')).toEqual({ offeredAt: 0, handled: ['old'] });
});

test('dismissal compares timestamps strictly and handled ids are never offered again', () => {
	const items = [0, 1, 2].map((updatedAt) => ({
		id: String(updatedAt),
		updatedAt,
		name: 'Local',
		s1: 's1'
	}));
	expect(unmergedItems(items, { offeredAt: null, handled: ['2'] })).toEqual(items.slice(0, 2));
	expect(unmergedItems(items, { offeredAt: 1, handled: [] })).toEqual([items[2]]);
	expect(unmergedItems(items, { offeredAt: 1, handled: ['2'] })).toEqual([]);
	for (const locale of ['pt-BR', 'en-US', 'fr-FR']) {
		expect(toMergeItem(items[0], locale)).toEqual({
			localId: '0',
			name: 'Local',
			s1: 's1',
			lang: locale === 'en-US' ? 'en-US' : 'pt-BR'
		});
	}
});

test.each<[SocialErrorCode, ReturnType<typeof errorKind>]>([
	['OFFLINE', 'offline'],
	['NETWORK', 'offline'],
	['AUTH_REQUIRED', 'auth'],
	['REAUTH_REQUIRED', 'auth'],
	['EMAIL_NOT_VERIFIED', 'verify'],
	['GATE_REJECTED', 'gate'],
	['RATE_LIMITED', 'rate'],
	['QUOTA_EXCEEDED', 'rate'],
	['NOT_FOUND', 'missing'],
	['GONE', 'missing'],
	['INTERNAL', 'generic']
])('%s maps to the recoverable UI category %s', (code, kind) => {
	expect(errorKind(new SocialApiError(400, code))).toBe(kind);
});

test('only real abort DOMExceptions are cancellations; unknown failures are generic', () => {
	for (const error of [
		null,
		'offline',
		new Error('AbortError'),
		{ name: 'AbortError' },
		new DOMException('Other', 'SecurityError')
	]) {
		expect(isAbort(error)).toBe(false);
		expect(errorKind(error)).toBe('generic');
	}
	expect(isAbort(new DOMException('Cancelled', 'AbortError'))).toBe(true);
});

const mergeItems: LibraryMergeItem[] = [{ localId: 'a', s1: 's1', name: 'A' }];

test('an empty merge does no work or progress notifications', async () => {
	const mergeLibrary = vi.fn<SocialApi['mergeLibrary']>();
	const progress = vi.fn();
	expect(await runMerge({ mergeLibrary }, [], progress)).toEqual({
		report: { created: [], duplicates: [], rejected: [], conflicts: [] },
		handled: [],
		error: null,
		unsent: 0
	});
	expect(mergeLibrary).not.toHaveBeenCalled();
	expect(progress).not.toHaveBeenCalled();
});

test('unexpected merge failures stop immediately; cancellation is rethrown without logging', async () => {
	const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	const mergeLibrary = vi.fn<SocialApi['mergeLibrary']>().mockRejectedValueOnce('unexpected');
	const outcome = await runMerge({ mergeLibrary }, mergeItems);
	expect(outcome).toMatchObject({ error: 'INTERNAL', unsent: 1, handled: [] });
	expect(log).toHaveBeenCalledOnce();
	const abort = new DOMException('Cancelled', 'AbortError');
	mergeLibrary.mockRejectedValueOnce(abort);
	await expect(runMerge({ mergeLibrary }, mergeItems)).rejects.toBe(abort);
	expect(log).toHaveBeenCalledOnce();
});

test('all permanent rejections are handled, but transient rejections remain retryable', async () => {
	const codes = [
		'INVALID_CURVE',
		'GATE_REJECTED',
		'INVALID_TEXT',
		'DUPLICATE',
		'INTERNAL'
	] as const;
	const outcome = await runMerge(
		{
			mergeLibrary: async () => ({
				created: [],
				duplicates: [],
				conflicts: [],
				rejected: codes.map((code) => ({ localId: code, code }))
			})
		},
		codes.map((code) => ({ localId: code, s1: 's1', name: code }))
	);
	expect(outcome.handled).toEqual(codes.slice(0, 4));
	expect(outcome.report.rejected).toHaveLength(5);
	expect(outcome.error).toBeNull();
});

const share = (id: string, lineageId: string): MyShareItem => ({
	id,
	lineage: { id: lineageId, name: null },
	versionId: null,
	channel: null,
	createdAt: 0
});

test('sharesOf follows cursors in API order, filters other lineages and forwards cancellation', async () => {
	const myShares = vi
		.fn<SocialApi['myShares']>()
		.mockResolvedValueOnce({
			items: [share('first', 'target'), share('other', 'other')],
			nextCursor: 'page2'
		})
		.mockResolvedValueOnce({ items: [share('last', 'target')], nextCursor: null });
	const signal = new AbortController().signal;
	expect((await sharesOf({ myShares }, 'target', signal)).map((item) => item.id)).toEqual([
		'first',
		'last'
	]);
	expect(myShares.mock.calls).toEqual([
		[{ cursor: null }, { signal }],
		[{ cursor: 'page2' }, { signal }]
	]);
});

test('sharesOf bounds a never-ending cursor and supports calls without a signal', async () => {
	const myShares = vi
		.fn<SocialApi['myShares']>()
		.mockResolvedValue({ items: [share('match', 'target')], nextCursor: 'again' });
	expect(await sharesOf({ myShares }, 'target')).toHaveLength(SHARES_PAGES_MAX);
	expect(myShares).toHaveBeenCalledTimes(10);
	expect(myShares.mock.calls[0]).toEqual([{ cursor: null }, {}]);
	const failure = new SocialApiError(401, 'AUTH_REQUIRED');
	myShares.mockRejectedValueOnce(failure);
	await expect(sharesOf({ myShares }, 'target')).rejects.toBe(failure);
});
