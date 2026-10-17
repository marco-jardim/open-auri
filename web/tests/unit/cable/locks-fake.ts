/**
 * Fake Web Locks manager and in-flight marker storage (no DOM, no node:* imports, so both node
 * and browser tests can use them). Services that share one `held` set behave like tabs of the
 * same origin; services that share one `MemoryInflight` share its `localStorage` key.
 */
import type { InflightPort, WriteLock, WriteLockManager } from '../../../src/lib/cable/types.ts';

export interface MemoryLocks extends WriteLockManager {
	/** Lock names currently held (shared between "tabs"). */
	readonly held: Set<string>;
	/** Every `ifAvailable` request, in order: name and whether it was granted. */
	readonly requests: { name: string; granted: boolean }[];
	/** Every waiting request (no `ifAvailable`), in order, and whether it was granted yet. */
	readonly waits: { name: string; granted: boolean }[];
	query(): Promise<{ held: WriteLock[] }>;
}

interface Waiter {
	readonly name: string;
	/** Called once the lock is already marked as held for this waiter. */
	readonly grant: () => void;
}

/**
 * Waiting requests per shared `held` set, oldest first (one queue for every name, like the
 * per-origin lock manager). Woken whenever a lock of that set is released.
 */
const waiters = new WeakMap<Set<string>, Waiter[]>();

function queueOf(held: Set<string>): Waiter[] {
	let queue = waiters.get(held);
	if (!queue) {
		queue = [];
		waiters.set(held, queue);
	}
	return queue;
}

/**
 * Like the real API: a name is grantable only when nobody holds it and nobody waits for it.
 * Through this fake a queued name is always held (`wake` hands it over synchronously), so the
 * queue check only matters for waiting requests after a test edited `held` directly.
 */
function grantable(held: Set<string>, name: string): boolean {
	return !held.has(name) && !queueOf(held).some((waiter) => waiter.name === name);
}

/**
 * Grants every free name to its OLDEST waiter only (FIFO, one holder per name), marking the lock
 * held synchronously, before the waiter resumes: nothing (an `ifAvailable` request included)
 * can slip in between the release and the next grant.
 */
function wake(held: Set<string>) {
	const queue = queueOf(held);
	for (const waiter of [...queue]) {
		if (held.has(waiter.name)) continue;
		queue.splice(queue.indexOf(waiter), 1);
		held.add(waiter.name);
		waiter.grant();
	}
}

/** Releases `name` as if the tab holding it died (its pending callback never settles). */
export function killHolder(held: Set<string>, name: string) {
	held.delete(name);
	wake(held);
}

function abortError(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException('lock request aborted', 'AbortError');
}

export function memoryLocks(held: Set<string> = new Set()): MemoryLocks {
	const requests: { name: string; granted: boolean }[] = [];
	const waits: { name: string; granted: boolean }[] = [];
	async function run<T>(name: string, callback: (lock: WriteLock | null) => Promise<T>) {
		// Idempotent: a woken waiter was already marked as held by `wake`.
		held.add(name);
		try {
			return await callback({ name });
		} finally {
			held.delete(name);
			wake(held);
		}
	}
	return {
		held,
		requests,
		waits,
		async request<T>(
			name: string,
			options: { ifAvailable?: true; signal?: AbortSignal },
			callback: (lock: WriteLock | null) => Promise<T>
		): Promise<T> {
			if (options.ifAvailable === true) {
				// Writes: never wait, report null instead. Only the holder is checked, so a test that
				// clears `held` directly frees the lock for writes at once, as it always did.
				const granted = !held.has(name);
				requests.push({ name, granted });
				if (!granted) return callback(null);
				return run(name, callback);
			}
			// The interruption watcher: wait until the lock is free (or the signal aborts).
			const record = { name, granted: false };
			waits.push(record);
			const { signal } = options;
			if (signal?.aborted) throw abortError(signal);
			// A test may have freed a name by editing `held` directly: older waiters go first.
			wake(held);
			await new Promise<void>((resolve, reject) => {
				let onAbort: (() => void) | undefined;
				const waiter: Waiter = {
					name,
					grant: () => {
						if (onAbort) signal?.removeEventListener('abort', onAbort);
						record.granted = true;
						resolve();
					}
				};
				if (grantable(held, name)) {
					held.add(name);
					waiter.grant();
					return;
				}
				if (signal) {
					onAbort = () => {
						const queue = queueOf(held);
						const index = queue.indexOf(waiter);
						if (index >= 0) queue.splice(index, 1);
						reject(abortError(signal));
					};
					signal.addEventListener('abort', onAbort, { once: true });
				}
				queueOf(held).push(waiter);
			});
			return run(name, callback);
		},
		query() {
			return Promise.resolve({ held: [...held].map((name) => ({ name })) });
		}
	};
}

export interface MemoryInflight extends InflightPort {
	/** The raw stored value (null when absent). */
	value: string | null;
	/** Every write, in order (null = removal). */
	readonly writes: (string | null)[];
	/** When true, writes fail (quota/blocked storage). */
	failWrites: boolean;
	/**
	 * Delivers a `storage` event to every subscriber (like another tab's write). Writes never
	 * notify by themselves: real `storage` events are asynchronous and cross-tab only.
	 */
	announce(): void;
}

export function memoryInflight(initial: string | null = null): MemoryInflight {
	const listeners = new Set<() => void>();
	const port: MemoryInflight = {
		value: initial,
		writes: [],
		failWrites: false,
		read: () => port.value,
		write(value) {
			if (port.failWrites) return false;
			port.writes.push(value);
			port.value = value;
			return true;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		announce() {
			for (const listener of [...listeners]) listener();
		}
	};
	return port;
}
