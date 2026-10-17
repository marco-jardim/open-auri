import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	SOCIAL_ATTACH_TIMEOUT_MS,
	SOCIAL_RETRY_INTERVAL_MS,
	SocialAttachTimeoutError,
	createSocialAttacher,
	raceAttach,
	type SocialAttacherOptions,
	type SocialStop
} from '#lib/app/social-attach.ts';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** Lets promise callbacks run (fake timers do not fake microtasks). */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

const RETRY_WARNING = 'Social runtime still unavailable; the outbox stays unavailable';
const APP = { id: 'app' };
type App = typeof APP;

function harness(overrides: Partial<SocialAttacherOptions<App>> = {}) {
	const clock = { value: 0 };
	const availability: boolean[] = [];
	const warn = vi.fn<(message: string, error: unknown) => void>();
	const attach = vi.fn<(client: App) => Promise<SocialStop>>();
	const owned = { value: true };
	const attacher = createSocialAttacher<App>({
		attach,
		owns: () => owned.value,
		onavailable: (available) => availability.push(available),
		now: () => clock.value,
		warn,
		...overrides
	});
	return { attacher, attach, clock, availability, warn, owned };
}

describe('raceAttach (first mount timeout, #35)', () => {
	test('the defaults: 8 s for the first attach, one retry per 10 s', () => {
		expect(SOCIAL_ATTACH_TIMEOUT_MS).toBe(8000);
		expect(SOCIAL_RETRY_INTERVAL_MS).toBe(10_000);
	});

	test('an attach that lands in time settles the race and clears its timer', async () => {
		const stop = vi.fn();
		const onlate = vi.fn();
		await expect(raceAttach(Promise.resolve(stop), 100, onlate)).resolves.toBe(stop);
		expect(vi.getTimerCount()).toBe(0);
		const failure = new TypeError('Failed to fetch dynamically imported module');
		await expect(raceAttach(Promise.reject(failure), 100, onlate)).rejects.toBe(failure);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(500);
		expect(onlate).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
	});

	test('a stalled attach rejects at the timeout; its late cleanup goes to onlate', async () => {
		const stalled = deferred<SocialStop>();
		const onlate = vi.fn();
		const rejected = vi.fn();
		raceAttach(stalled.promise, 100, onlate).catch(rejected);
		await vi.advanceTimersByTimeAsync(99);
		await settle();
		expect(rejected).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(rejected).toHaveBeenCalledOnce();
		const error: unknown = rejected.mock.calls[0]?.[0];
		expect(error).toBeInstanceOf(SocialAttachTimeoutError);
		expect(error).toMatchObject({ name: 'SocialAttachTimeoutError', timeoutMs: 100 });
		const stop = vi.fn();
		stalled.resolve(stop);
		await settle();
		expect(onlate).toHaveBeenCalledExactlyOnceWith(stop);
		expect(stop).not.toHaveBeenCalled();
	});

	test('a failure after the timeout is dropped (the timeout already reported it)', async () => {
		const stalled = deferred<SocialStop>();
		const onlate = vi.fn();
		const rejected = vi.fn();
		raceAttach(stalled.promise, 100, onlate).catch(rejected);
		await vi.advanceTimersByTimeAsync(100);
		await settle();
		stalled.reject(new TypeError('late'));
		await settle();
		expect(rejected).toHaveBeenCalledOnce();
		expect(rejected.mock.calls[0]?.[0]).toBeInstanceOf(SocialAttachTimeoutError);
		expect(onlate).not.toHaveBeenCalled();
	});
});

describe('createSocialAttacher (layout prepare and retry, #35)', () => {
	test('an attach in time keeps social available and returns its cleanup', async () => {
		const h = harness();
		const stop = vi.fn();
		h.attach.mockResolvedValue(stop);
		await expect(h.attacher.prepare(APP)).resolves.toBe(stop);
		expect(h.attach).toHaveBeenCalledExactlyOnceWith(APP);
		expect(h.attacher.unavailable).toBe(false);
		expect(h.availability).toEqual([]);
		// Nothing to retry while social is wired.
		h.clock.value = SOCIAL_RETRY_INTERVAL_MS * 3;
		expect(h.attacher.retry(APP)).toBe(false);
		expect(h.attach).toHaveBeenCalledOnce();
	});

	test('a failed first attach marks social unavailable and rejects for the context to log', async () => {
		const h = harness();
		const failure = new TypeError('Failed to fetch dynamically imported module');
		h.attach.mockRejectedValue(failure);
		await expect(h.attacher.prepare(APP)).rejects.toBe(failure);
		expect(h.attacher.unavailable).toBe(true);
		expect(h.availability).toEqual([false]);
		// The context logs the prepare failure; the attacher adds nothing of its own.
		expect(h.warn).not.toHaveBeenCalled();
	});

	test('a stalled first attach times out; when it lands later it wires the live app', async () => {
		const h = harness();
		const stalled = deferred<SocialStop>();
		h.attach.mockReturnValue(stalled.promise);
		const rejected = vi.fn();
		h.attacher.prepare(APP).catch(rejected);
		await vi.advanceTimersByTimeAsync(SOCIAL_ATTACH_TIMEOUT_MS - 1);
		await settle();
		expect(rejected).not.toHaveBeenCalled();
		expect(h.attacher.unavailable).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(rejected.mock.calls[0]?.[0]).toBeInstanceOf(SocialAttachTimeoutError);
		expect(h.attacher.unavailable).toBe(true);
		expect(h.availability).toEqual([false]);

		// Still running: a retry would only wait on the same chunk request.
		h.clock.value = SOCIAL_RETRY_INTERVAL_MS * 5;
		expect(h.attacher.retry(APP)).toBe(false);
		expect(h.attach).toHaveBeenCalledOnce();

		const stop = vi.fn();
		stalled.resolve(stop);
		await settle();
		expect(h.attacher.unavailable).toBe(false);
		expect(h.availability).toEqual([false, true]);
		expect(stop).not.toHaveBeenCalled();
	});

	test('a late attach for an app that is no longer live is undone', async () => {
		const h = harness();
		const stalled = deferred<SocialStop>();
		h.attach.mockReturnValue(stalled.promise);
		h.attacher.prepare(APP).catch(() => undefined);
		await vi.advanceTimersByTimeAsync(SOCIAL_ATTACH_TIMEOUT_MS);
		await settle();
		h.owned.value = false;
		const stop = vi.fn();
		stalled.resolve(stop);
		await settle();
		expect(stop).toHaveBeenCalledOnce();
		expect(h.attacher.unavailable).toBe(true);
		expect(h.availability).toEqual([false]);
	});

	test('retries start at most once per interval, never while one runs, and warn once', async () => {
		const h = harness();
		const failure = new TypeError('Failed to fetch dynamically imported module');
		h.attach.mockRejectedValue(failure);
		await expect(h.attacher.prepare(APP)).rejects.toBe(failure);

		// Every bar press, focus, write or rescue request inside the interval is a no-op.
		for (const at of [0, 1, 5000, SOCIAL_RETRY_INTERVAL_MS - 1]) {
			h.clock.value = at;
			expect(h.attacher.retry(APP)).toBe(false);
		}
		expect(h.attach).toHaveBeenCalledOnce();

		const running = deferred<SocialStop>();
		h.attach.mockReturnValueOnce(running.promise);
		h.clock.value = SOCIAL_RETRY_INTERVAL_MS;
		expect(h.attacher.retry(APP)).toBe(true);
		h.clock.value = SOCIAL_RETRY_INTERVAL_MS * 4;
		expect(h.attacher.retry(APP)).toBe(false);
		expect(h.attach).toHaveBeenCalledTimes(2);
		running.reject(failure);
		await settle();
		expect(h.warn).toHaveBeenCalledExactlyOnceWith(RETRY_WARNING, failure);

		// The next attempt is paced from the start of the previous one; it fails quietly.
		h.clock.value = SOCIAL_RETRY_INTERVAL_MS * 4 + 1;
		expect(h.attacher.retry(APP)).toBe(true);
		await settle();
		expect(h.attacher.retry(APP)).toBe(false);
		h.clock.value = SOCIAL_RETRY_INTERVAL_MS * 6;
		expect(h.attacher.retry(APP)).toBe(true);
		await settle();
		expect(h.attach).toHaveBeenCalledTimes(4);
		expect(h.warn).toHaveBeenCalledOnce();
		expect(h.attacher.unavailable).toBe(true);
	});

	test('a successful retry ends the outage; a later outage warns again', async () => {
		const h = harness();
		const failure = new TypeError('offline');
		h.attach.mockRejectedValue(failure);
		await expect(h.attacher.prepare(APP)).rejects.toBe(failure);
		h.clock.value = SOCIAL_RETRY_INTERVAL_MS;
		expect(h.attacher.retry(APP)).toBe(true);
		await settle();
		expect(h.warn).toHaveBeenCalledOnce();

		const stop = vi.fn();
		h.attach.mockResolvedValueOnce(stop);
		h.clock.value = SOCIAL_RETRY_INTERVAL_MS * 2;
		expect(h.attacher.retry(APP)).toBe(true);
		await settle();
		expect(h.attacher.unavailable).toBe(false);
		expect(h.availability).toEqual([false, true]);
		expect(stop).not.toHaveBeenCalled();
		expect(h.attacher.retry(APP)).toBe(false);

		// A new app mount whose attach fails starts a new outage with its own single warning.
		h.clock.value = SOCIAL_RETRY_INTERVAL_MS * 3;
		await expect(h.attacher.prepare(APP)).rejects.toBe(failure);
		h.clock.value = SOCIAL_RETRY_INTERVAL_MS * 4;
		expect(h.attacher.retry(APP)).toBe(true);
		await settle();
		expect(h.warn).toHaveBeenCalledTimes(2);
		expect(h.availability).toEqual([false, true, false]);
	});

	test('a retry needs a live app; wiring that lands for a replaced app is undone', async () => {
		const h = harness();
		h.attach.mockRejectedValueOnce(new TypeError('offline'));
		await expect(h.attacher.prepare(APP)).rejects.toBeInstanceOf(TypeError);
		h.clock.value = SOCIAL_RETRY_INTERVAL_MS;
		expect(h.attacher.retry(null)).toBe(false);
		expect(h.attacher.retry(undefined)).toBe(false);
		h.owned.value = false;
		expect(h.attacher.retry(APP)).toBe(false);
		expect(h.attach).toHaveBeenCalledOnce();

		h.owned.value = true;
		const landing = deferred<SocialStop>();
		h.attach.mockReturnValueOnce(landing.promise);
		expect(h.attacher.retry(APP)).toBe(true);
		h.owned.value = false;
		const stop = vi.fn();
		landing.resolve(stop);
		await settle();
		expect(stop).toHaveBeenCalledOnce();
		expect(h.attacher.unavailable).toBe(true);
	});

	test('an attach that throws synchronously counts as a failed attempt', async () => {
		const failure = new Error('sync');
		const h = harness({
			attach: () => {
				throw failure;
			}
		});
		await expect(h.attacher.prepare(APP)).rejects.toBe(failure);
		expect(h.attacher.unavailable).toBe(true);
		h.clock.value = SOCIAL_RETRY_INTERVAL_MS;
		expect(h.attacher.retry(APP)).toBe(true);
		await settle();
		expect(h.warn).toHaveBeenCalledExactlyOnceWith(RETRY_WARNING, failure);
		// The failed retry is over: the next one is only paced, not blocked.
		h.clock.value = SOCIAL_RETRY_INTERVAL_MS * 2;
		expect(h.attacher.retry(APP)).toBe(true);
	});

	test('defaults: the real clock and console.warn', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		vi.setSystemTime(1_000_000);
		const failure = new TypeError('offline');
		const attacher = createSocialAttacher<App>({
			attach: () => Promise.reject(failure),
			owns: () => true,
			onavailable: () => undefined
		});
		await expect(attacher.prepare(APP)).rejects.toBe(failure);
		expect(attacher.retry(APP)).toBe(false);
		vi.setSystemTime(1_000_000 + SOCIAL_RETRY_INTERVAL_MS);
		expect(attacher.retry(APP)).toBe(true);
		await settle();
		expect(warn).toHaveBeenCalledExactlyOnceWith(RETRY_WARNING, failure);
	});
});
