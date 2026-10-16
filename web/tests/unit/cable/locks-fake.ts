/**
 * Fake Web Locks manager and in-flight marker storage (no DOM, no node:* imports, so both node
 * and browser tests can use them). Services that share one `held` set behave like tabs of the
 * same origin; services that share one `MemoryInflight` share its `localStorage` key.
 */
import type { InflightPort, WriteLock, WriteLockManager } from '../../../src/lib/cable/types.ts';

export interface MemoryLocks extends WriteLockManager {
	/** Lock names currently held (shared between "tabs"). */
	readonly held: Set<string>;
	/** Every `request` call, in order: name and whether it was granted. */
	readonly requests: { name: string; granted: boolean }[];
	query(): Promise<{ held: WriteLock[] }>;
}

function expectIfAvailable(options: { ifAvailable?: unknown }) {
	if (options.ifAvailable !== true) throw new Error('cable write lock must use ifAvailable');
}

export function memoryLocks(held: Set<string> = new Set()): MemoryLocks {
	const requests: { name: string; granted: boolean }[] = [];
	return {
		held,
		requests,
		async request<T>(
			name: string,
			options: { ifAvailable: true },
			callback: (lock: WriteLock | null) => Promise<T>
		): Promise<T> {
			// The service always asks with { ifAvailable: true }: never wait, report null instead.
			expectIfAvailable(options);
			const granted = !held.has(name);
			requests.push({ name, granted });
			if (!granted) return callback(null);
			held.add(name);
			try {
				return await callback({ name });
			} finally {
				held.delete(name);
			}
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
}

export function memoryInflight(initial: string | null = null): MemoryInflight {
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
		}
	};
	return port;
}
