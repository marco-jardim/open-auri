import { afterEach, describe, expect, test, vi } from 'vitest';
import { FakeHID, FakeHIDDevice, createFakeClock } from 'open-auri/transport';
import {
	NATIVE_FRESHNESS_TIMEOUT_MS,
	NativeFreshnessError,
	assertNativeWriteFresh
} from '#lib/cable/native-freshness.ts';
import { createCableService } from '#lib/cable/service.ts';
import { CONFIRMED, T0, TRUSTED_CLICK, memoryFlash, memoryJournal, padrao } from './harness.ts';

vi.mock('$app/env', () => ({ version: 'current' }));
vi.mock('$app/paths', () => ({ resolve: () => '/site/' }));

afterEach(() => {
	vi.useRealTimers();
});

function fetchVersion(value: unknown) {
	return vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(value)));
}

describe('native write policy freshness', () => {
	test('checks the Kit version file without using the HTTP cache and accepts the current deploy', async () => {
		const fetch = fetchVersion({ version: 'current' });
		await expect(assertNativeWriteFresh({ fetch })).resolves.toBeUndefined();
		expect(fetch).toHaveBeenCalledWith('/site/_app/version.json', {
			cache: 'no-store',
			headers: { 'cache-control': 'no-cache' },
			signal: expect.any(AbortSignal)
		});
	});

	test('compares against the injected bundle version and refuses a different deploy', async () => {
		await expect(
			assertNativeWriteFresh({ fetch: fetchVersion({ version: 'current' }), version: 'cached' })
		).rejects.toMatchObject({ name: 'NativeFreshnessError', reason: 'newer' });
	});

	test('fails closed when offline', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('offline'));
		await expect(assertNativeWriteFresh({ fetch })).rejects.toMatchObject({
			name: 'NativeFreshnessError',
			reason: 'unavailable'
		});
	});

	test.each([404, 503])('fails closed for HTTP %s', async (status) => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response(JSON.stringify({ version: 'current' }), { status }));
		await expect(assertNativeWriteFresh({ fetch })).rejects.toMatchObject({
			reason: 'unavailable'
		});
	});

	test.each([null, [], {}, { version: null }, { version: 1 }, { version: '' }])(
		'fails closed for malformed version data %j',
		async (data) => {
			await expect(assertNativeWriteFresh({ fetch: fetchVersion(data) })).rejects.toMatchObject({
				reason: 'unavailable'
			});
		}
	);

	test('fails closed for invalid JSON', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('not JSON'));
		await expect(assertNativeWriteFresh({ fetch })).rejects.toMatchObject({
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
			const check = assertNativeWriteFresh({ fetch });
			const refused = expect(check).rejects.toMatchObject({ reason: 'unavailable' });
			await vi.advanceTimersByTimeAsync(NATIVE_FRESHNESS_TIMEOUT_MS);
			await refused;
			expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	test('clears the timeout after a successful check', async () => {
		vi.useFakeTimers();
		await assertNativeWriteFresh({ fetch: fetchVersion({ version: 'current' }) });
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('desktop and simulation are independent of remote native policy', () => {
	test.each(['real', 'simulated'] as const)('%s never checks freshness', async (mode) => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValue(new NativeFreshnessError('newer'));
		const clock = createFakeClock(0, { autoAdvance: true });
		const hid = new FakeHID({ devices: [new FakeHIDDevice({ clock })] });
		const service = createCableService({
			hid: mode === 'real' ? hid : null,
			nativeFreshness: { fetch, version: 'cached' },
			clock,
			journal: memoryJournal(),
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
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			service.dispose();
		}
	});
});
