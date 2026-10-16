// Plain per-key bookkeeping for the Comunidade components: values that never drive rendering
// (requests in flight, audible preview time, already reported lineages). Deliberately not
// reactive, so it lives in a plain module rather than as a Map inside a `.svelte(.ts)` file.
export interface KeyedStore<V> {
	get(key: string): V | undefined;
	has(key: string): boolean;
	set(key: string, value: V): void;
	delete(key: string): void;
}

export function createKeyedStore<V>(): KeyedStore<V> {
	const entries = new Map<string, V>();
	return {
		get: (key) => entries.get(key),
		has: (key) => entries.has(key),
		set: (key, value) => {
			entries.set(key, value);
		},
		delete: (key) => {
			entries.delete(key);
		}
	};
}
