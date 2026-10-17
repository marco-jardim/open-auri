/**
 * The Web Locks fake itself (issue #19): the cross-tab tests rely on it granting like the real
 * API, i.e. one holder per name, waiters served in FIFO order, and the hand-over to the next
 * waiter happening at release time, so no `ifAvailable` request can slip in between.
 */
import { describe, expect, test } from 'vitest';
import { killHolder, memoryLocks } from './locks-fake.ts';

const NAME = 'oa-test-lock';
const OTHER = 'oa-other-lock';

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = () => settle();
	});
	return { promise, resolve };
}

/** Lets every pending microtask and the current timer phase run. */
function flush(): Promise<void> {
	return new Promise((settle) => setTimeout(settle, 0));
}

describe('memoryLocks (Web Locks fake)', () => {
	test('two waiters on a held lock: one grant at a time, in FIFO order', async () => {
		// Held by a tab that never releases by itself.
		const locks = memoryLocks(new Set([NAME]));
		const order: string[] = [];
		const releaseFirst = deferred();
		const releaseSecond = deferred();
		const first = locks.request(NAME, {}, async (lock) => {
			order.push(`first:${lock?.name}`);
			await releaseFirst.promise;
		});
		const second = locks.request(NAME, {}, async (lock) => {
			order.push(`second:${lock?.name}`);
			await releaseSecond.promise;
		});
		await flush();
		expect(order).toEqual([]);
		expect(locks.waits).toEqual([
			{ name: NAME, granted: false },
			{ name: NAME, granted: false }
		]);

		killHolder(locks.held, NAME);
		// Handed over synchronously, to the oldest waiter only.
		expect(locks.held.has(NAME)).toBe(true);
		expect(locks.waits.map((wait) => wait.granted)).toEqual([true, false]);
		await flush();
		expect(order).toEqual([`first:${NAME}`]);
		expect(locks.waits.map((wait) => wait.granted)).toEqual([true, false]);

		releaseFirst.resolve();
		await first;
		expect(locks.held.has(NAME)).toBe(true);
		expect(locks.waits.map((wait) => wait.granted)).toEqual([true, true]);
		await flush();
		expect(order).toEqual([`first:${NAME}`, `second:${NAME}`]);

		releaseSecond.resolve();
		await second;
		expect(locks.held.size).toBe(0);
	});

	test('an ifAvailable request right after a release finds the lock already handed over', async () => {
		const locks = memoryLocks(new Set([NAME]));
		const entered: string[] = [];
		const watcher = locks.request(NAME, {}, async () => {
			entered.push('watcher');
		});
		await flush();

		killHolder(locks.held, NAME);
		// Same tick as the release, before the woken waiter resumes.
		const write = await locks.request(NAME, { ifAvailable: true }, async (lock) => lock);
		expect(write).toBeNull();
		expect(locks.requests).toEqual([{ name: NAME, granted: false }]);

		await watcher;
		expect(entered).toEqual(['watcher']);
		expect(locks.held.has(NAME)).toBe(false);
	});

	test('across tabs: an aborted waiter leaves the queue and the next one keeps its turn', async () => {
		const held = new Set([NAME]);
		const tabA = memoryLocks(held);
		const tabB = memoryLocks(held);
		const tabC = memoryLocks(held);
		const order: string[] = [];
		const controller = new AbortController();
		const aborted = tabA.request(NAME, { signal: controller.signal }, async () => {
			order.push('a');
		});
		const releaseB = deferred();
		const b = tabB.request(NAME, {}, async () => {
			order.push('b');
			await releaseB.promise;
		});
		const c = tabC.request(NAME, {}, async () => {
			order.push('c');
		});
		await flush();

		controller.abort();
		await expect(aborted).rejects.toBe(controller.signal.reason);

		killHolder(held, NAME);
		await flush();
		expect(order).toEqual(['b']);
		expect(tabA.waits).toEqual([{ name: NAME, granted: false }]);
		expect(tabB.waits).toEqual([{ name: NAME, granted: true }]);
		expect(tabC.waits).toEqual([{ name: NAME, granted: false }]);

		releaseB.resolve();
		await Promise.all([b, c]);
		expect(order).toEqual(['b', 'c']);
		expect(held.size).toBe(0);
	});

	test('names are independent: a free name is granted while another one has a queue', async () => {
		const locks = memoryLocks(new Set([NAME]));
		const queued = locks.request(NAME, {}, async () => 'queued');
		const other = await locks.request(OTHER, {}, async (lock) => lock?.name);
		expect(other).toBe(OTHER);
		expect(locks.waits.map((wait) => wait.granted)).toEqual([false, true]);

		killHolder(locks.held, NAME);
		expect(await queued).toBe('queued');
		expect(locks.held.size).toBe(0);
	});
});
