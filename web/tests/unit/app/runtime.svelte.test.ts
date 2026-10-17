import { afterEach, describe, expect, test, vi } from 'vitest';
import { CABLE_INFLIGHT_KEY } from '#lib/cable/index.ts';
import {
	INFLIGHT_MARKER_KEY,
	INSTRUMENT_ROUTES,
	IDLE_TIMEOUT_MS,
	hasInflightMarker,
	isInstrumentRoute,
	isTurnstileRoute,
	loadAppRuntime,
	runtimeTrigger,
	whenIdle
} from '#lib/app/runtime.ts';
import { createAppContext, type AppContext } from '#lib/app/context.svelte.ts';
import { LazyModule } from '#lib/app/lazy.svelte.ts';
import type { ClientApp } from '#lib/app/index.ts';
import { fakeAppOptions } from './fakes.ts';

const contexts: AppContext[] = [];
afterEach(() => {
	for (const context of contexts.splice(0)) context.dispose();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
function context(): AppContext {
	const created = createAppContext();
	contexts.push(created);
	return created;
}

describe('runtime triggers (spec §5.3 L1, §5.4 W2)', () => {
	test('the layout reads the same marker key as the cable service', () => {
		expect(INFLIGHT_MARKER_KEY).toBe(CABLE_INFLIGHT_KEY);
	});

	test('instrument routes and a rescue marker import at once; every other route on idle', () => {
		expect([...INSTRUMENT_ROUTES].sort()).toEqual(
			[
				'/',
				'/biblioteca',
				'/c/[id]',
				'/cabo',
				'/comparar',
				'/comunidade',
				'/soe-como-x',
				'/teste-cego',
				'/u/[apelido]'
			].sort()
		);
		for (const route of INSTRUMENT_ROUTES) expect(runtimeTrigger(route, false)).toBe('now');
		for (const route of ['/offline', '/docs', '/entrar', '/conta', '/admin', null, undefined]) {
			expect(isInstrumentRoute(route)).toBe(false);
			expect(runtimeTrigger(route, false)).toBe('idle');
			expect(runtimeTrigger(route, true)).toBe('now');
		}
	});

	test('Turnstile preconnect only on the auth routes that render it (W7)', () => {
		for (const route of ['/entrar', '/criar-conta', '/esqueci-senha', '/redefinir-senha']) {
			expect(isTurnstileRoute(route)).toBe(true);
		}
		for (const route of ['/', '/comunidade', '/conta', '/verificar-email', null, undefined]) {
			expect(isTurnstileRoute(route)).toBe(false);
		}
	});

	test('the marker read is synchronous and tolerates unreadable storage', () => {
		const store = new Map<string, string>();
		const storage = { getItem: (key: string) => store.get(key) ?? null };
		expect(hasInflightMarker(storage)).toBe(false);
		store.set(CABLE_INFLIGHT_KEY, '{"at":1}');
		expect(hasInflightMarker(storage)).toBe(true);
		expect(hasInflightMarker(null)).toBe(false);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const blocked = {
			getItem(): string | null {
				throw new DOMException('denied', 'SecurityError');
			}
		};
		expect(hasInflightMarker(blocked)).toBe(false);
		expect(warn).toHaveBeenCalledOnce();
		localStorage.setItem(CABLE_INFLIGHT_KEY, 'x');
		try {
			expect(hasInflightMarker()).toBe(true);
		} finally {
			localStorage.removeItem(CABLE_INFLIGHT_KEY);
		}
		expect(hasInflightMarker()).toBe(false);
	});

	test('idle scheduling uses requestIdleCallback with the 1500 ms timeout, else a short timer', () => {
		const ric = vi.fn<(callback: () => void, options?: { timeout: number }) => number>(() => 7);
		const cic = vi.fn<(handle: number) => void>();
		vi.stubGlobal('requestIdleCallback', ric);
		vi.stubGlobal('cancelIdleCallback', cic);
		const callback = vi.fn();
		const cancel = whenIdle(callback);
		expect(ric).toHaveBeenCalledWith(expect.any(Function), { timeout: IDLE_TIMEOUT_MS });
		expect(IDLE_TIMEOUT_MS).toBe(1500);
		ric.mock.calls[0]?.[0]();
		expect(callback).toHaveBeenCalledOnce();
		cancel();
		expect(cic).toHaveBeenCalledWith(7);

		vi.useFakeTimers();
		try {
			vi.stubGlobal('requestIdleCallback', undefined);
			const late = vi.fn();
			whenIdle(late);
			vi.advanceTimersByTime(299);
			expect(late).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(late).toHaveBeenCalledOnce();
			const cancelled = vi.fn();
			whenIdle(cancelled, 100)();
			vi.advanceTimersByTime(500);
			expect(cancelled).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test('the runtime chunk is imported once and exposes the app factory', async () => {
		const first = loadAppRuntime();
		expect(loadAppRuntime()).toBe(first);
		const runtime = await first;
		expect(typeof runtime.createClientApp).toBe('function');
	});
});

describe('async app context (client stays null before the mount)', () => {
	test('mount loads the runtime, shares one promise and publishes after prepare', async () => {
		const app = context();
		expect(app.client).toBeNull();
		expect(app.status).toBe('idle');
		const seen: (ClientApp | null)[] = [];
		const prepare = vi.fn(async (client: ClientApp) => {
			// The bridge is wired before the app is visible to the layout or any page.
			seen.push(app.client);
			expect(client.cable).toBeDefined();
		});
		const first = app.mount(fakeAppOptions().options, { prepare });
		const second = app.mount(fakeAppOptions().options, { prepare });
		expect(second).toBe(first);
		expect(app.status).toBe('loading');
		expect(app.client).toBeNull();
		const client = await first;
		expect(client).not.toBeNull();
		expect(app.client).toBe(client);
		expect(app.status).toBe('ready');
		expect(prepare).toHaveBeenCalledOnce();
		expect(seen).toEqual([null]);
		await expect(app.mount()).resolves.toBe(client);
	});

	test('a failing prepare disposes the app, reports an error and the next mount retries', async () => {
		const app = context();
		const failure = new Error('bridge failed');
		const disposals: ReturnType<typeof vi.fn>[] = [];
		const prepare = vi.fn((client: ClientApp) => {
			const original = client.dispose;
			const spy = vi.fn(() => original());
			client.dispose = spy;
			disposals.push(spy);
			throw failure;
		});
		await expect(app.mount(fakeAppOptions().options, { prepare })).rejects.toBe(failure);
		expect(prepare).toHaveBeenCalledOnce();
		expect(disposals[0]).toHaveBeenCalledOnce();
		expect(app.client).toBeNull();
		expect(app.status).toBe('error');
		const retried = await app.mount(fakeAppOptions().options);
		expect(retried).not.toBeNull();
		expect(retried).not.toBe(prepare.mock.calls[0]?.[0]);
		expect(app.status).toBe('ready');
	});

	test('dispose during the load publishes nothing', async () => {
		const app = context();
		const pending = app.mount(fakeAppOptions().options);
		app.dispose();
		expect(app.status).toBe('idle');
		await expect(pending).resolves.toBeNull();
		expect(app.client).toBeNull();
		expect(app.status).toBe('idle');
	});

	test('dispose while prepare runs disposes the late app', async () => {
		const app = context();
		const releases: (() => void)[] = [];
		const disposals: ReturnType<typeof vi.fn>[] = [];
		const prepare = vi.fn((client: ClientApp) => {
			const original = client.dispose;
			const spy = vi.fn(() => original());
			client.dispose = spy;
			disposals.push(spy);
			return new Promise<void>((resolve) => releases.push(resolve));
		});
		const pending = app.mount(fakeAppOptions().options, { prepare });
		await expect.poll(() => releases.length).toBe(1);
		app.dispose();
		releases[0]?.();
		await expect(pending).resolves.toBeNull();
		expect(disposals[0]).toHaveBeenCalledOnce();
		expect(app.client).toBeNull();
	});
});

describe('lazy islands', () => {
	test('loads a module default once, keeps it reactive and retries after a failure', async () => {
		const component = { name: 'Island' };
		const importer = vi
			.fn<() => Promise<{ default: typeof component }>>()
			.mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
			.mockResolvedValue({ default: component });
		const island = new LazyModule(importer);
		expect(island.current).toBeNull();
		const onerror = vi.fn();
		island.request(onerror);
		await expect.poll(() => onerror.mock.calls.length).toBe(1);
		expect(island.current).toBeNull();
		const [a, b] = [island.load(), island.load()];
		await expect(a).resolves.toBe(component);
		await expect(b).resolves.toBe(component);
		expect(importer).toHaveBeenCalledTimes(2);
		expect(island.current).toBe(component);
		await expect(island.load()).resolves.toBe(component);
		expect(importer).toHaveBeenCalledTimes(2);
	});

	test('a request without a handler logs the failure', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const island = new LazyModule(() => Promise.reject(new Error('offline')));
		island.request();
		await expect.poll(() => warn.mock.calls.length).toBe(1);
	});
});
