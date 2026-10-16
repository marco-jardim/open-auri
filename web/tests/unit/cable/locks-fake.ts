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

/** Waiters per shared `held` set, woken whenever a lock of that set is released. */
const waiters = new WeakMap<Set<string>, (() => void)[]>();

function wake(held: Set<string>) {
	const queue = waiters.get(held) ?? [];
	waiters.set(held, []);
	for (const waiter of queue) waiter();
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
				// Writes: never wait, report null instead.
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
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					const queue = waiters.get(held) ?? [];
					waiters.set(
						held,
						queue.filter((waiter) => waiter !== attempt)
					);
					reject(abortError(signal as AbortSignal));
				};
				const attempt = () => {
					if (held.has(name)) {
						waiters.set(held, [...(waiters.get(held) ?? []), attempt]);
						return;
					}
					signal?.removeEventListener('abort', onAbort);
					resolve();
				};
				signal?.addEventListener('abort', onAbort, { once: true });
				attempt();
			});
			record.granted = true;
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
