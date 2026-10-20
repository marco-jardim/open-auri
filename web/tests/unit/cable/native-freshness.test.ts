import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeHID, FakeHIDDevice, createFakeClock } from 'open-auri/transport';
import {
	NATIVE_FRESHNESS_TIMEOUT_MS,
	NATIVE_LAST_GOOD_KEY,
	NativeFreshnessError,
	assertNativeWriteFresh,
	forgetNativeLastGood,
	reconcileNativeLastGood,
	type NativeLastGoodStorage
} from '#lib/cable/native-freshness.ts';
import { createCableService } from '#lib/cable/service.ts';
import {
	CONFIRMED,
	T0,
	TRUSTED_CLICK,
	memoryFlash,
	memoryJournal,
	memoryStorage,
	padrao
} from './harness.ts';

vi.mock('$app/env', () => ({ version: 'current' }));
vi.mock('$app/paths', () => ({ resolve: () => '/site/' }));

// Every test injects its own storage, so none depends on the runtime's Web Storage.
let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
	storage = memoryStorage();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function fetchVersion(value: unknown) {
	return vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(value)));
}

const offline = () => vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('offline'));
const lastGood = (value: unknown) => ({ [NATIVE_LAST_GOOD_KEY]: JSON.stringify(value) });

describe('native write policy freshness', () => {
	test('checks the Kit version file without using the HTTP cache and accepts the current deploy', async () => {
		const fetch = fetchVersion({ version: 'current' });
		await expect(assertNativeWriteFresh({ fetch, storage, now: () => T0 })).resolves.toEqual({
			basis: 'live',
			checkedAt: T0
		});
		expect(fetch).toHaveBeenCalledWith('/site/_app/version.json', {
			cache: 'no-store',
			headers: { 'cache-control': 'no-cache' },
			signal: expect.any(AbortSignal)
		});
	});

	test('compares against the injected bundle version and refuses a different deploy', async () => {
		await expect(
			assertNativeWriteFresh({
				fetch: fetchVersion({ version: 'current' }),
				version: 'cached',
				storage
			})
		).rejects.toMatchObject({ name: 'NativeFreshnessError', reason: 'newer' });
	});

	test('fails closed when offline', async () => {
		await expect(assertNativeWriteFresh({ fetch: offline(), storage })).rejects.toMatchObject({
			name: 'NativeFreshnessError',
			reason: 'unavailable'
		});
	});

	test.each([404, 503])('fails closed for HTTP %s', async (status) => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response(JSON.stringify({ version: 'current' }), { status }));
		await expect(assertNativeWriteFresh({ fetch, storage })).rejects.toMatchObject({
			reason: 'unavailable'
		});
	});

	test.each([null, [], {}, { version: null }, { version: 1 }, { version: '' }])(
		'fails closed for malformed version data %j',
		async (data) => {
			await expect(
				assertNativeWriteFresh({ fetch: fetchVersion(data), storage })
			).rejects.toMatchObject({
				reason: 'unavailable'
			});
		}
	);

	test('fails closed for invalid JSON', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('not JSON'));
		await expect(assertNativeWriteFresh({ fetch, storage })).rejects.toMatchObject({
			reason: 'unavailable'
		});
	});

	test.each(['fetch', 'json'] as const)(
		'bounds a stalled %s and aborts the request',
		async (stage) => {
			vi.useFakeTimers();
			const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
				if (stage === 'fetch') return new Promise<Response>(() => undefined);
				const response = new Response();
				vi.spyOn(response, 'json').mockImplementation(() => new Promise<unknown>(() => undefined));
				return response;
			});
			const check = assertNativeWriteFresh({ fetch, storage });
			const refused = expect(check).rejects.toMatchObject({ reason: 'unavailable' });
			await vi.advanceTimersByTimeAsync(NATIVE_FRESHNESS_TIMEOUT_MS);
			await refused;
			expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	test('clears the timeout after a successful check', async () => {
		vi.useFakeTimers();
		await assertNativeWriteFresh({ fetch: fetchVersion({ version: 'current' }), storage });
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('offline writes on the last-good confirmation', () => {
	const MONTH_AGO = T0 - 30 * 86_400_000;

	test('a live match records this build and the check time as last-good', async () => {
		const fetch = fetchVersion({ version: 'current' });
		await expect(assertNativeWriteFresh({ fetch, storage, now: () => T0 })).resolves.toEqual({
			basis: 'live',
			checkedAt: T0
		});
		expect(JSON.parse(storage.items.get(NATIVE_LAST_GOOD_KEY) ?? 'null')).toEqual({
			version: 'current',
			checkedAt: T0
		});
		// A later live check refreshes it.
		await assertNativeWriteFresh({
			fetch: fetchVersion({ version: 'current' }),
			storage,
			now: () => T0 + 1
		});
		expect(JSON.parse(storage.items.get(NATIVE_LAST_GOOD_KEY) ?? 'null')).toEqual({
			version: 'current',
			checkedAt: T0 + 1
		});
	});

	test('a newer deploy still refuses and forgets the last-good record', async () => {
		storage = memoryStorage(lastGood({ version: 'current', checkedAt: T0 }));
		await expect(
			assertNativeWriteFresh({ fetch: fetchVersion({ version: 'newer' }), storage })
		).rejects.toMatchObject({ name: 'NativeFreshnessError', reason: 'newer' });
		expect(storage.items.has(NATIVE_LAST_GOOD_KEY)).toBe(false);
		// This page can no longer write offline.
		await expect(assertNativeWriteFresh({ fetch: offline(), storage })).rejects.toMatchObject({
			reason: 'unavailable'
		});
	});

	const http503 = () => vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
	const invalidJson = () => vi.fn<typeof fetch>().mockResolvedValue(new Response('not JSON'));

	test.each([
		['offline', offline],
		['HTTP 503', http503],
		['malformed data', () => fetchVersion({ version: '' })],
		['invalid JSON', invalidJson]
	] as const)(
		'%s proceeds on a last-good record of this build, with no expiry',
		async (_label, fetch) => {
			const record = JSON.stringify({ version: 'current', checkedAt: MONTH_AGO });
			storage = memoryStorage({ [NATIVE_LAST_GOOD_KEY]: record });
			await expect(assertNativeWriteFresh({ fetch: fetch(), storage })).resolves.toEqual({
				basis: 'last-good',
				checkedAt: MONTH_AGO
			});
			// Not a new confirmation: the record is left as it was.
			expect(storage.items.get(NATIVE_LAST_GOOD_KEY)).toBe(record);
		}
	);

	test('a timed-out check proceeds on a last-good record of this build', async () => {
		vi.useFakeTimers();
		storage = memoryStorage(lastGood({ version: 'current', checkedAt: MONTH_AGO }));
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(() => new Promise<Response>(() => undefined));
		const check = assertNativeWriteFresh({ fetch, storage });
		const allowed = expect(check).resolves.toEqual({ basis: 'last-good', checkedAt: MONTH_AGO });
		await vi.advanceTimersByTimeAsync(NATIVE_FRESHNESS_TIMEOUT_MS);
		await allowed;
		expect(vi.getTimerCount()).toBe(0);
	});

	test('the injected bundle version must match the record', async () => {
		storage = memoryStorage(lastGood({ version: 'current', checkedAt: T0 }));
		await expect(
			assertNativeWriteFresh({ fetch: offline(), storage, version: 'cached' })
		).rejects.toMatchObject({ reason: 'unavailable' });
	});

	test.each([
		['another build', JSON.stringify({ version: 'older', checkedAt: T0 })],
		['not JSON', 'not JSON'],
		['null', 'null'],
		['an array', '[]'],
		['a string', '"current"'],
		['an empty object', '{}'],
		['no checkedAt', JSON.stringify({ version: 'current' })],
		['no version', JSON.stringify({ checkedAt: T0 })],
		['an empty version', JSON.stringify({ version: '', checkedAt: T0 })],
		['a numeric version', JSON.stringify({ version: 1, checkedAt: T0 })],
		['a string checkedAt', JSON.stringify({ version: 'current', checkedAt: String(T0) })],
		['a null checkedAt', JSON.stringify({ version: 'current', checkedAt: null })],
		['a negative checkedAt', JSON.stringify({ version: 'current', checkedAt: -1 })],
		['a fractional checkedAt', JSON.stringify({ version: 'current', checkedAt: 1.5 })],
		['an unsafe checkedAt', JSON.stringify({ version: 'current', checkedAt: 2 ** 53 })],
		['a checkedAt after 8.64e15', JSON.stringify({ version: 'current', checkedAt: 8.64e15 + 1 })],
		['an extra field', JSON.stringify({ version: 'current', checkedAt: T0, extra: true })]
	])('offline refuses with %s as the record', async (_label, raw) => {
		storage = memoryStorage({ [NATIVE_LAST_GOOD_KEY]: raw });
		await expect(assertNativeWriteFresh({ fetch: offline(), storage })).rejects.toMatchObject({
			name: 'NativeFreshnessError',
			reason: 'unavailable'
		});
	});

	test('no storage: live checks still pass and offline refuses', async () => {
		await expect(
			assertNativeWriteFresh({ fetch: fetchVersion({ version: 'current' }), storage: null })
		).resolves.toMatchObject({ basis: 'live' });
		await expect(assertNativeWriteFresh({ fetch: offline(), storage: null })).rejects.toMatchObject(
			{ reason: 'unavailable' }
		);
	});

	test('a throwing storage is tolerated: it only warns and counts as no record', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const broken: NativeLastGoodStorage = {
			getItem: () => {
				throw new DOMException('denied', 'SecurityError');
			},
			setItem: () => {
				throw new DOMException('full', 'QuotaExceededError');
			},
			removeItem: () => {
				throw new DOMException('denied', 'SecurityError');
			}
		};
		await expect(
			assertNativeWriteFresh({
				fetch: fetchVersion({ version: 'current' }),
				storage: broken,
				now: () => T0
			})
		).resolves.toEqual({ basis: 'live', checkedAt: T0 });
		await expect(
			assertNativeWriteFresh({ fetch: fetchVersion({ version: 'newer' }), storage: broken })
		).rejects.toMatchObject({ reason: 'newer' });
		await expect(
			assertNativeWriteFresh({ fetch: offline(), storage: broken })
		).rejects.toMatchObject({ reason: 'unavailable' });
		expect(warn).toHaveBeenCalledTimes(3);
	});

	test('defaults to localStorage and tolerates it being inaccessible', async () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
		const restore = () => {
			if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
			else Object.defineProperty(globalThis, 'localStorage', original);
		};
		try {
			const local = memoryStorage(lastGood({ version: 'current', checkedAt: MONTH_AGO }));
			Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
			await expect(assertNativeWriteFresh({ fetch: offline() })).resolves.toEqual({
				basis: 'last-good',
				checkedAt: MONTH_AGO
			});
			await assertNativeWriteFresh({ fetch: fetchVersion({ version: 'current' }), now: () => T0 });
			expect(JSON.parse(local.items.get(NATIVE_LAST_GOOD_KEY) ?? 'null')).toEqual({
				version: 'current',
				checkedAt: T0
			});

			const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			Object.defineProperty(globalThis, 'localStorage', {
				configurable: true,
				get() {
					throw new DOMException('denied', 'SecurityError');
				}
			});
			await expect(
				assertNativeWriteFresh({ fetch: fetchVersion({ version: 'current' }) })
			).resolves.toMatchObject({ basis: 'live' });
			await expect(assertNativeWriteFresh({ fetch: offline() })).rejects.toMatchObject({
				reason: 'unavailable'
			});
			expect(warn).toHaveBeenCalled();
		} finally {
			restore();
		}
	});
});

describe('forgetting the last-good record outside a write', () => {
	test('a record at the last valid Date still counts', async () => {
		storage = memoryStorage(lastGood({ version: 'current', checkedAt: 8.64e15 }));
		await expect(assertNativeWriteFresh({ fetch: offline(), storage })).resolves.toEqual({
			basis: 'last-good',
			checkedAt: 8.64e15
		});
	});

	test('forgetNativeLastGood removes the record and never throws', () => {
		storage = memoryStorage(lastGood({ version: 'current', checkedAt: T0 }));
		forgetNativeLastGood(storage);
		expect(storage.items.has(NATIVE_LAST_GOOD_KEY)).toBe(false);
		forgetNativeLastGood(storage);
		forgetNativeLastGood(null);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const broken = {
			...memoryStorage(),
			removeItem: () => {
				throw new DOMException('denied', 'SecurityError');
			}
		};
		expect(() => forgetNativeLastGood(broken)).not.toThrow();
		expect(warn).toHaveBeenCalledOnce();
	});

	test('reconcileNativeLastGood keeps only a valid record of this build', () => {
		const same = JSON.stringify({ version: 'current', checkedAt: T0 });
		storage = memoryStorage({ [NATIVE_LAST_GOOD_KEY]: same });
		reconcileNativeLastGood('current', storage);
		expect(storage.items.get(NATIVE_LAST_GOOD_KEY)).toBe(same);
		for (const raw of [
			JSON.stringify({ version: 'older', checkedAt: T0 }),
			JSON.stringify({ version: 'newer', checkedAt: T0 }),
			JSON.stringify({ version: 'current', checkedAt: 8.64e15 + 1 }),
			JSON.stringify({ version: 'current', checkedAt: T0, extra: 1 }),
			'not JSON'
		]) {
			storage = memoryStorage({ [NATIVE_LAST_GOOD_KEY]: raw });
			reconcileNativeLastGood('current', storage);
			expect(storage.items.has(NATIVE_LAST_GOOD_KEY), raw).toBe(false);
		}
		// Nothing stored, or no storage: nothing to do.
		storage = memoryStorage();
		reconcileNativeLastGood('current', storage);
		expect(storage.items.size).toBe(0);
		expect(() => reconcileNativeLastGood('current', null)).not.toThrow();
	});

	test('reconcile defaults to this build and localStorage, and tolerates a throwing one', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const local = memoryStorage(lastGood({ version: 'cached', checkedAt: T0 }));
		vi.stubGlobal('localStorage', local);
		try {
			reconcileNativeLastGood();
			expect(local.items.has(NATIVE_LAST_GOOD_KEY)).toBe(false);
			local.items.set(NATIVE_LAST_GOOD_KEY, JSON.stringify({ version: 'current', checkedAt: T0 }));
			reconcileNativeLastGood();
			expect(local.items.has(NATIVE_LAST_GOOD_KEY)).toBe(true);
			forgetNativeLastGood();
			expect(local.items.has(NATIVE_LAST_GOOD_KEY)).toBe(false);
			expect(warn).not.toHaveBeenCalled();

			vi.stubGlobal('localStorage', {
				getItem: () => {
					throw new DOMException('denied', 'SecurityError');
				},
				setItem: () => undefined,
				removeItem: () => undefined
			});
			expect(() => reconcileNativeLastGood()).not.toThrow();
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('desktop and simulation are independent of remote native policy', () => {
	test.each(['real', 'simulated'] as const)('%s never checks freshness', async (mode) => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValue(new NativeFreshnessError('newer'));
		const clock = createFakeClock(0, { autoAdvance: true });
		const hid = new FakeHID({ devices: [new FakeHIDDevice({ clock })] });
		const journal = memoryJournal();
		const service = createCableService({
			hid: mode === 'real' ? hid : null,
			nativeFreshness: { fetch, version: 'cached', storage },
			clock,
			journal,
			flash: memoryFlash(),
			now: () => T0 + clock.now(),
			lastWrittenLevelDb: () => null,
			sessionWriteCount: () => 0,
			userActivation: () => ({ isActive: true }),
			locks: null,
			inflight: null
		});
		try {
			await service.ready;
			await service.connect();
			const result = await service.write({
				bands: padrao.eqBands,
				preampDb: padrao.preampDb,
				experimental: false,
				confirmations: CONFIRMED,
				gesture: service.createGesture(TRUSTED_CLICK)
			});
			expect(result.status).toBe(mode === 'real' ? 'ok' : 'simulated');
			expect(result).not.toHaveProperty('freshness');
			// Desktop and simulated journal entries keep their old shape.
			expect(journal.entries).toHaveLength(1);
			expect(journal.entries[0]).not.toHaveProperty('freshness');
			expect(fetch).not.toHaveBeenCalled();
			expect(storage.items.size).toBe(0);
		} finally {
			service.dispose();
		}
	});
});
