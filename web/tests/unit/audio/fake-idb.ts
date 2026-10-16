/**
 * Minimal in-memory IndexedDB for the unit project: open/upgrade with versions, object stores with
 * out-of-line keys, readonly/readwrite transactions with get/put/delete, async callbacks in the
 * spec's order (request success, then transaction complete).
 *
 * `fake-indexeddb` is not installed in this checkout; this covers exactly the subset the engine
 * uses. Swapping in `import 'fake-indexeddb/auto'` + `globalThis.indexedDB` needs no engine change.
 */

interface DbData {
	version: number;
	stores: Map<string, Map<string, unknown>>;
}

type Handler = (() => void) | null;

class FakeRequest {
	result: unknown = undefined;
	error: DOMException | null = null;
	onsuccess: Handler = null;
	onerror: Handler = null;
}

class FakeOpenRequest extends FakeRequest {
	onupgradeneeded: Handler = null;
	onblocked: Handler = null;
}

class FakeStringList {
	private readonly names: () => string[];
	constructor(names: () => string[]) {
		this.names = names;
	}
	contains(name: string): boolean {
		return this.names().includes(name);
	}
	get length(): number {
		return this.names().length;
	}
}

class FakeObjectStore {
	private readonly tx: FakeTransaction;
	private readonly data: Map<string, unknown>;
	constructor(tx: FakeTransaction, data: Map<string, unknown>) {
		this.tx = tx;
		this.data = data;
	}
	put(value: unknown, key: string): FakeRequest {
		return this.tx.schedule(() => {
			this.tx.requireWrite();
			if (this.tx.factory.failWrites) {
				throw new DOMException('quota exceeded', 'QuotaExceededError');
			}
			this.data.set(key, value);
			return key;
		});
	}
	get(key: string): FakeRequest {
		return this.tx.schedule(() => this.data.get(key));
	}
	delete(key: string): FakeRequest {
		return this.tx.schedule(() => {
			this.tx.requireWrite();
			this.data.delete(key);
			return undefined;
		});
	}
}

class FakeTransaction {
	oncomplete: Handler = null;
	onabort: Handler = null;
	onerror: Handler = null;
	error: DOMException | null = null;
	readonly factory: FakeIDBFactory;
	private readonly db: FakeDatabase;
	private readonly names: string[];
	private readonly mode: string;
	private pending = 0;
	private finished = false;
	constructor(factory: FakeIDBFactory, db: FakeDatabase, names: string[], mode: string) {
		this.factory = factory;
		this.db = db;
		this.names = names;
		this.mode = mode;
	}
	objectStore(name: string): FakeObjectStore {
		const data = this.db.data.stores.get(name);
		if (!data || !this.names.includes(name)) {
			throw new DOMException(`no store ${name}`, 'NotFoundError');
		}
		return new FakeObjectStore(this, data);
	}
	requireWrite(): void {
		if (this.mode !== 'readwrite') throw new DOMException('read only', 'ReadOnlyError');
	}
	schedule(operation: () => unknown): FakeRequest {
		const request = new FakeRequest();
		this.pending++;
		setTimeout(() => {
			if (this.finished) return;
			try {
				request.result = operation();
			} catch (error) {
				request.error = error instanceof DOMException ? error : new DOMException('failed');
				this.error = request.error;
				this.finished = true;
				request.onerror?.();
				this.onerror?.();
				this.onabort?.();
				return;
			}
			request.onsuccess?.();
			this.pending--;
			if (this.pending === 0) {
				this.finished = true;
				setTimeout(() => this.oncomplete?.(), 0);
			}
		}, 0);
		return request;
	}
}

class FakeDatabase {
	onversionchange: Handler = null;
	closed = false;
	upgrading = false;
	readonly objectStoreNames: FakeStringList;
	readonly data: DbData;
	private readonly factory: FakeIDBFactory;
	constructor(data: DbData, factory: FakeIDBFactory) {
		this.data = data;
		this.factory = factory;
		this.objectStoreNames = new FakeStringList(() => [...data.stores.keys()]);
	}
	get version(): number {
		return this.data.version;
	}
	createObjectStore(name: string): void {
		if (!this.upgrading) throw new DOMException('not upgrading', 'InvalidStateError');
		if (this.data.stores.has(name)) throw new DOMException(name, 'ConstraintError');
		this.data.stores.set(name, new Map());
	}
	transaction(names: string | string[], mode = 'readonly'): FakeTransaction {
		if (this.closed) throw new DOMException('closed', 'InvalidStateError');
		const list = typeof names === 'string' ? [names] : names;
		return new FakeTransaction(this.factory, this, list, mode);
	}
	close(): void {
		this.closed = true;
		this.factory.openConnections.delete(this);
	}
}

export class FakeIDBFactory {
	readonly databases = new Map<string, DbData>();
	readonly openConnections = new Set<FakeDatabase>();
	/** When true, every put fails with QuotaExceededError. */
	failWrites = false;

	open(name: string, version?: number): FakeOpenRequest {
		const request = new FakeOpenRequest();
		setTimeout(() => {
			const existing = this.databases.get(name);
			const oldVersion = existing?.version ?? 0;
			const target = version ?? (existing ? existing.version : 1);
			if (target < oldVersion) {
				request.error = new DOMException('requested version is lower', 'VersionError');
				request.onerror?.();
				return;
			}
			const data: DbData = existing ?? { version: 0, stores: new Map() };
			this.databases.set(name, data);
			const db = new FakeDatabase(data, this);
			this.openConnections.add(db);
			request.result = db;
			if (target > oldVersion) {
				data.version = target;
				db.upgrading = true;
				request.onupgradeneeded?.();
				db.upgrading = false;
			}
			request.onsuccess?.();
		}, 0);
		return request;
	}

	/** Raw read of a stored value, for assertions. */
	peek(dbName: string, store: string, key: string): unknown {
		return this.databases.get(dbName)?.stores.get(store)?.get(key);
	}

	asFactory(): IDBFactory {
		return this as unknown as IDBFactory;
	}
}
