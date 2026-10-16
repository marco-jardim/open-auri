/** Browser persistence boundary. Construct per browser/app, never during SSR module import. */
export type StorageArea = 'local' | 'session';
export type DatabaseStore = 'audio' | 'library' | 'outbox';
type RecordStore = Exclude<DatabaseStore, 'audio'>;
export type StorageBackend = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface StorageChange {
	key: string | null;
	newValue: string | null;
	area: StorageArea;
}
export interface ChannelBackend {
	postMessage(value: unknown): void;
	addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
	removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
	close(): void;
}
export interface StorageOptions {
	local?: StorageBackend | null;
	session?: StorageBackend | null;
	indexedDB?: IDBFactory | null;
	listen?: (listener: (event: StorageChange) => void) => () => void;
	channel?: (() => ChannelBackend) | null;
}
export interface StorageFailure {
	kind: 'quota' | 'unavailable' | 'invalid';
	operation: string;
	message: string;
}
export interface RecordChanges {
	put?: Record<string, unknown>[];
	remove?: string[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** No browser globals are read until this factory is called. null explicitly disables a backend. */
export function createStorage(options: StorageOptions = {}) {
	let error: StorageFailure | null = null;
	const errorListeners = new Set<(error: StorageFailure | null) => void>();
	function report(cause: unknown, operation: string, invalid = false) {
		const name = isRecord(cause) && typeof cause.name === 'string' ? cause.name : '';
		error = {
			kind: invalid ? 'invalid' : name === 'QuotaExceededError' ? 'quota' : 'unavailable',
			operation,
			message: cause instanceof Error ? cause.message : String(cause)
		};
		for (const listener of errorListeners) listener(error);
	}
	function browserValue<T>(get: () => T): T | null {
		try {
			return get();
		} catch (cause) {
			report(cause, 'access');
			return null;
		}
	}
	const browser = typeof window !== 'undefined';
	const local =
		options.local === undefined && browser
			? browserValue(() => window.localStorage)
			: (options.local ?? null);
	const session =
		options.session === undefined && browser
			? browserValue(() => window.sessionStorage)
			: (options.session ?? null);
	const factory =
		options.indexedDB === undefined && browser
			? browserValue(() => window.indexedDB)
			: (options.indexedDB ?? null);
	const memory = {
		local: new Map<string, string | null>(),
		session: new Map<string, string | null>()
	};
	const changes = new Set<(event: StorageChange) => void>();
	const databaseListeners = new Set<(store: DatabaseStore) => void>();
	const records = {
		library: new Map<string, Record<string, unknown>>(),
		outbox: new Map<string, Record<string, unknown>>()
	};
	const volatileStores = new Set<DatabaseStore>();
	let disposed = false;
	let database: Promise<IDBDatabase | null> | undefined;
	let channel: ChannelBackend | null = null;
	try {
		channel =
			options.channel === undefined
				? browser && typeof BroadcastChannel !== 'undefined'
					? new BroadcastChannel('open-auri')
					: null
				: (options.channel?.() ?? null);
	} catch (cause) {
		report(cause, 'channel');
	}
	function onMessage(event: { data: unknown }) {
		const data = event.data;
		if (
			isRecord(data) &&
			data.type === 'indexeddb' &&
			(data.store === 'audio' || data.store === 'library' || data.store === 'outbox')
		) {
			for (const listener of databaseListeners) listener(data.store);
		}
	}
	channel?.addEventListener('message', onMessage);
	function onStorage(event: StorageChange) {
		for (const listener of changes) listener(event);
	}
	const stopListening =
		options.listen?.(onStorage) ??
		(browser
			? (() => {
					const listener = (event: StorageEvent) => {
						if (event.storageArea === local) {
							onStorage({ key: event.key, newValue: event.newValue, area: 'local' });
						} else if (event.storageArea === session) {
							onStorage({ key: event.key, newValue: event.newValue, area: 'session' });
						}
					};
					window.addEventListener('storage', listener);
					return () => window.removeEventListener('storage', listener);
				})()
			: () => undefined);

	function read(area: StorageArea, key: string, persisted = false): string | null {
		if (!persisted && memory[area].has(key)) return memory[area].get(key) ?? null;
		try {
			return (area === 'local' ? local : session)?.getItem(key) ?? null;
		} catch (cause) {
			report(cause, `read:${key}`);
			return null;
		}
	}
	function write(area: StorageArea, key: string, value: string | null): boolean {
		memory[area].set(key, value);
		try {
			const backend = area === 'local' ? local : session;
			if (!backend) throw new Error(`${area}Storage unavailable; using memory`);
			if (value === null) backend.removeItem(key);
			else backend.setItem(key, value);
			memory[area].delete(key);
			return true;
		} catch (cause) {
			report(cause, `write:${key}`);
			return false;
		}
	}
	function open(): Promise<IDBDatabase | null> {
		if (database) return database;
		database = new Promise((resolve) => {
			if (!factory || disposed) {
				resolve(null);
				return;
			}
			try {
				const request = factory.open('open-auri', 1);
				let settled = false;
				request.onupgradeneeded = () => {
					for (const store of ['audio', 'library', 'outbox']) {
						if (!request.result.objectStoreNames.contains(store)) {
							request.result.createObjectStore(
								store,
								store === 'audio' ? undefined : { keyPath: 'id' }
							);
						}
					}
				};
				request.onsuccess = () => {
					if (settled || disposed) {
						request.result.close();
						resolve(null);
					} else {
						request.result.onversionchange = () => request.result.close();
						resolve(request.result);
					}
				};
				const fail = (cause: unknown) => {
					settled = true;
					report(cause, 'indexeddb:open');
					resolve(null);
				};
				request.onerror = () => fail(request.error);
				request.onblocked = () => fail(new Error('IndexedDB upgrade blocked; using memory'));
			} catch (cause) {
				report(cause, 'indexeddb:open');
				resolve(null);
			}
		});
		return database;
	}
	function cache(store: RecordStore, values: Record<string, unknown>[]) {
		records[store].clear();
		for (const value of values)
			if (typeof value.id === 'string') records[store].set(value.id, value);
	}
	let queue = Promise.resolve();
	async function loadRecords(store: RecordStore): Promise<Record<string, unknown>[]> {
		await queue;
		const db = await open();
		if (!db || volatileStores.has(store)) return structuredClone([...records[store].values()]);
		try {
			const values = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
				const tx = db.transaction(store, 'readonly');
				const request = tx.objectStore(store).getAll();
				tx.oncomplete = () => resolve((request.result as unknown[]).filter(isRecord));
				tx.onabort = () => reject(tx.error ?? new Error('IndexedDB read aborted'));
			});
			cache(store, values);
			return values;
		} catch (cause) {
			report(cause, `indexeddb:read:${store}`);
			return structuredClone([...records[store].values()]);
		}
	}
	function updateRecords(
		store: RecordStore,
		update: (values: Record<string, unknown>[]) => RecordChanges
	) {
		const task = queue.then(async () => {
			const db = await open();
			let planned: RecordChanges | undefined;
			let base = [...records[store].values()];
			let persisted = false;
			try {
				if (volatileStores.has(store)) {
					planned = update(structuredClone(base));
				} else if (!db) {
					report(new Error('IndexedDB unavailable; using memory'), `indexeddb:write:${store}`);
					volatileStores.add(store);
					planned = update(structuredClone(base));
				} else {
					await new Promise<void>((resolve, reject) => {
						const tx = db.transaction(store, 'readwrite');
						const objectStore = tx.objectStore(store);
						const request = objectStore.getAll();
						request.onsuccess = () => {
							try {
								base = (request.result as unknown[]).filter(isRecord);
								planned = update(structuredClone(base));
								for (const id of planned.remove ?? []) objectStore.delete(id);
								for (const value of planned.put ?? []) objectStore.put(value);
							} catch (cause) {
								reject(cause);
								tx.abort();
							}
						};
						tx.oncomplete = () => resolve();
						tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
					});
					persisted = true;
				}
			} catch (cause) {
				report(cause, `indexeddb:write:${store}`);
				volatileStores.add(store);
			}
			try {
				planned ??= update(structuredClone(base));
				cache(store, base);
				for (const id of planned.remove ?? []) records[store].delete(id);
				for (const value of planned.put ?? []) {
					if (typeof value.id === 'string') records[store].set(value.id, structuredClone(value));
				}
				if (persisted) channel?.postMessage({ type: 'indexeddb', store });
			} catch (cause) {
				report(cause, `indexeddb:update:${store}`, true);
			}
			return structuredClone([...records[store].values()]);
		});
		queue = task.then(() => undefined);
		return task;
	}
	return {
		read,
		write,
		loadRecords,
		updateRecords,
		report,
		readPersisted(area: StorageArea, key: string) {
			return read(area, key, true);
		},
		acceptExternal(area: StorageArea, key: string) {
			memory[area].delete(key);
		},
		get error() {
			return error;
		},
		onError(listener: (error: StorageFailure | null) => void) {
			errorListeners.add(listener);
			listener(error);
			return () => {
				errorListeners.delete(listener);
			};
		},
		onStorage(listener: (event: StorageChange) => void) {
			changes.add(listener);
			return () => {
				changes.delete(listener);
			};
		},
		onDatabase(listener: (store: DatabaseStore) => void) {
			databaseListeners.add(listener);
			return () => {
				databaseListeners.delete(listener);
			};
		},
		dispose() {
			disposed = true;
			stopListening();
			channel?.removeEventListener('message', onMessage);
			channel?.close();
			void database?.then((db) => db?.close());
			changes.clear();
			databaseListeners.clear();
			errorListeners.clear();
		}
	};
}

export type ClientStorage = ReturnType<typeof createStorage>;
