import type {
	ChannelBackend,
	StorageChange,
	StorageOptions
} from '../../../src/lib/state/storage.ts';

export class MemoryStorage implements Storage {
	private values = new Map<string, string>();
	failure: Error | null = null;
	get length() {
		return this.values.size;
	}
	clear() {
		this.values.clear();
	}
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}
	removeItem(key: string) {
		if (this.failure) throw this.failure;
		this.values.delete(key);
	}
	setItem(key: string, value: string) {
		if (this.failure) throw this.failure;
		this.values.set(key, value);
	}
}

export function createTabs(indexedDB: IDBFactory | null = null) {
	const local = new MemoryStorage();
	const sessions = [new MemoryStorage(), new MemoryStorage()];
	const listeners = new Map<number, (change: StorageChange) => void>();
	const channels = new Map<number, (event: { data: unknown }) => void>();
	const pending: (() => void)[] = [];
	function options(tab: number): StorageOptions {
		const channel: ChannelBackend = {
			postMessage(data) {
				for (const [other, listener] of channels) {
					if (other !== tab) pending.push(() => listener({ data: structuredClone(data) }));
				}
			},
			addEventListener(_type, listener) {
				channels.set(tab, listener);
			},
			removeEventListener() {
				channels.delete(tab);
			},
			close() {
				channels.delete(tab);
			}
		};
		return {
			local: {
				getItem: (key) => local.getItem(key),
				setItem(key, value) {
					local.setItem(key, value);
					for (const [other, listener] of listeners) {
						if (other !== tab)
							pending.push(() => listener({ area: 'local', key, newValue: value }));
					}
				},
				removeItem(key) {
					local.removeItem(key);
					for (const [other, listener] of listeners) {
						if (other !== tab) pending.push(() => listener({ area: 'local', key, newValue: null }));
					}
				}
			},
			session: sessions[tab],
			indexedDB,
			channel: () => channel,
			listen(listener) {
				listeners.set(tab, listener);
				return () => {
					listeners.delete(tab);
				};
			}
		};
	}
	return {
		local,
		sessions,
		options,
		deliver() {
			while (pending.length) pending.shift()?.();
		},
		emit(tab: number, change: StorageChange) {
			listeners.get(tab)?.(change);
		}
	};
}
