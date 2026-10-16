import { SvelteMap } from 'svelte/reactivity';
import { canonKey, encodeS1 } from 'open-auri/share';
import { checkedCurve, isTimestamp, nextTimestamp } from './model.ts';
import type { Clock, CurveData } from './model.ts';
import { createStorage, isRecord, type ClientStorage } from './storage.ts';
import { storageStatus } from './status.svelte.ts';

export interface LibraryItem extends CurveData {
	readonly id: string;
	readonly s1: string;
	readonly favorite: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
}
export interface LibraryInput extends CurveData {
	id?: string;
	favorite?: boolean;
	updatedAt?: number;
}

function checkedItem(value: unknown): LibraryItem {
	if (
		!isRecord(value) ||
		typeof value.id !== 'string' ||
		!value.id ||
		typeof value.s1 !== 'string' ||
		typeof value.favorite !== 'boolean' ||
		!isTimestamp(value.createdAt) ||
		!isTimestamp(value.updatedAt) ||
		value.createdAt > value.updatedAt
	) {
		throw new TypeError('Invalid library item structure');
	}
	const curve = checkedCurve({ ...value, schema: 1 });
	if (encodeS1(curve) !== value.s1) throw new TypeError('Library S1 does not match its curve');
	return Object.freeze({
		id: value.id,
		name: curve.name,
		source: curve.source,
		preampDb: curve.preampDb,
		bands: curve.bands,
		s1: value.s1,
		favorite: value.favorite,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt
	});
}

export function createLibraryStore(
	options: { storage?: ClientStorage; now?: Clock; id?: () => string } = {}
) {
	const storage = options.storage ?? createStorage();
	const status = storageStatus(storage);
	const now = options.now ?? Date.now;
	const id = options.id ?? (() => globalThis.crypto.randomUUID());
	let items = $state.raw<readonly LibraryItem[]>([]);
	let loading = $state(true);
	let generation = 0;
	let disposed = false;
	function validate(values: Record<string, unknown>[], deduplicate = true) {
		const unique = new SvelteMap<string, LibraryItem>();
		const all: LibraryItem[] = [];
		for (const value of values) {
			try {
				const item = checkedItem(value);
				all.push(item);
				const key = canonKey(item.bands, item.preampDb);
				const previous = unique.get(key);
				if (!previous || item.updatedAt > previous.updatedAt) unique.set(key, item);
			} catch (cause) {
				storage.report(cause, 'library:load', true);
			}
		}
		return (deduplicate ? [...unique.values()] : all).sort(
			(a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
		);
	}
	async function refresh() {
		const token = ++generation;
		const values = await storage.loadRecords('library');
		if (!disposed && token === generation) {
			items = validate(values);
			loading = false;
		}
	}
	const ready = refresh();
	const stop = storage.onDatabase((store) => {
		if (store === 'library') void refresh();
	});
	let queue = Promise.resolve();
	function enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const task = queue.then(operation);
		queue = task.then(() => undefined);
		return task;
	}
	async function change(
		update: (values: LibraryItem[]) => { put?: LibraryItem[]; remove?: string[] }
	) {
		await ready;
		++generation;
		const values = await storage.updateRecords('library', (values) => {
			const next = update(validate(values, false));
			return { ...next, put: next.put?.map((item) => ({ ...item })) };
		});
		if (!disposed) items = validate(values);
	}
	return {
		ready,
		get items() {
			return items;
		},
		get loading() {
			return loading;
		},
		get error() {
			return status.error;
		},
		refresh,
		async list() {
			await refresh();
			return items;
		},
		save(input: LibraryInput): Promise<LibraryItem | null> {
			// Snapshot before yielding: callers cannot change what is persisted in flight.
			let curve: ReturnType<typeof checkedCurve>;
			let requestedId: string | undefined;
			let favorite: boolean | undefined;
			let updatedAt: number | undefined;
			try {
				requestedId = input.id;
				favorite = input.favorite;
				updatedAt = input.updatedAt;
				curve = checkedCurve({ ...input, schema: 1, updatedAt: updatedAt ?? now() });
				encodeS1(curve);
				if (
					(requestedId !== undefined && !requestedId) ||
					(favorite !== undefined && typeof favorite !== 'boolean')
				) {
					throw new TypeError('Invalid library input');
				}
			} catch (cause) {
				storage.report(cause, 'library:save', true);
				return Promise.resolve(null);
			}
			return enqueue(async () => {
				let result: LibraryItem | null = null;
				await change((values) => {
					const key = canonKey(curve.bands, curve.preampDb);
					const duplicates = values.filter((item) => canonKey(item.bands, item.preampDb) === key);
					const duplicate = duplicates[0];
					const previous = values.find((item) => item.id === requestedId) ?? duplicate;
					const latest =
						duplicate && duplicate.updatedAt > (previous?.updatedAt ?? -1) ? duplicate : previous;
					if (latest && updatedAt !== undefined && updatedAt <= latest.updatedAt) {
						result = latest;
						return {};
					}
					const at = updatedAt ?? nextTimestamp(now, latest?.updatedAt);
					result = checkedItem({
						...curve,
						id: duplicate?.id ?? previous?.id ?? requestedId ?? id(),
						s1: encodeS1(curve),
						favorite: favorite ?? Boolean(previous?.favorite || duplicate?.favorite),
						createdAt: duplicate?.createdAt ?? previous?.createdAt ?? at,
						updatedAt: at
					});
					return {
						put: [result],
						remove: [...duplicates, ...(previous ? [previous] : [])]
							.filter((item) => item.id !== result?.id)
							.map((item) => item.id)
					};
				});
				return result;
			});
		},
		setFavorite(itemId: string, favorite: boolean): Promise<boolean> {
			return enqueue(async () => {
				let found = false;
				await change((values) => {
					const item = values.find((value) => value.id === itemId);
					if (!item || typeof favorite !== 'boolean') return {};
					found = true;
					return { put: [{ ...item, favorite, updatedAt: nextTimestamp(now, item.updatedAt) }] };
				});
				return found;
			});
		},
		remove(itemId: string) {
			return enqueue(() =>
				change((values) => {
					const item = values.find((value) => value.id === itemId);
					if (!item) return { remove: [itemId] };
					const key = canonKey(item.bands, item.preampDb);
					return {
						remove: values
							.filter((value) => canonKey(value.bands, value.preampDb) === key)
							.map((value) => value.id)
					};
				})
			);
		},
		dispose() {
			disposed = true;
			++generation;
			stop();
			status.dispose();
			if (!options.storage) storage.dispose();
		}
	};
}
