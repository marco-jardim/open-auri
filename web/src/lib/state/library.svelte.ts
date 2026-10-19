import { SvelteMap } from 'svelte/reactivity';
import { canonKey, encodeS1, EnvelopeError, normalizeLabels, normalizeText } from 'open-auri/share';
import { checkedCurve, isTimestamp, nextTimestamp, sameLabels } from './model.ts';
import type { Clock, CurveData, CurveLabels } from './model.ts';
import { createStorage, isRecord, type ClientStorage } from './storage.ts';
import { storageStatus } from './status.svelte.ts';

export interface LibraryItem extends CurveData {
	readonly id: string;
	readonly s1: string;
	/**
	 * S5 description, at most 280 code points. Loaded items always carry it ('' when never set);
	 * records written before it existed have no such field and load as ''.
	 */
	readonly description?: string;
	/**
	 * Filter labels by wire index of `s1` (core `normalizeLabels`). Loaded items always carry it
	 * (null when none); records written before labels existed load as null. Never part of the
	 * dedupe key (`canonKey`).
	 */
	readonly labels?: CurveLabels | null;
	readonly favorite: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
}
export interface LibraryInput extends CurveData {
	id?: string;
	favorite?: boolean;
	updatedAt?: number;
}

// S5 envelope bounds in code points (core `validateEnvelope`, src/share/envelope.mjs:403-404; the
// core does not export them). The text rules themselves are the core's `normalizeText`.
export const LIBRARY_NAME_MAX = 48;
export const LIBRARY_DESCRIPTION_MAX = 280;

export type LibraryTextField = 'name' | 'description' | 'labels';
/** Core envelope issue code (`env:length`, `env:url`, `env:url-like`, `env:pattern`, ...). */
export type LibraryTextCode = EnvelopeError['errors'][number]['code'];
export interface LibraryTextIssue {
	readonly field: LibraryTextField;
	readonly code: LibraryTextCode;
}
export interface LibraryTextPatch {
	name?: string;
	description?: string;
	/** Ten labels by wire index (strict S5 rules: refused text is `invalid-text`); null clears. */
	labels?: readonly (string | null)[] | null;
}
export type LibraryUpdateCode = 'invalid-text' | 'not-found';

/** Rejection of `update`: text refused by the S5 rules (with its issues) or an unknown id. */
export class LibraryUpdateError extends Error {
	readonly code: LibraryUpdateCode;
	readonly issues: readonly LibraryTextIssue[];
	constructor(code: LibraryUpdateCode, issues: readonly LibraryTextIssue[] = []) {
		const detail = issues.map((issue) => `${issue.field} ${issue.code}`).join(', ');
		super(code === 'not-found' ? 'Library item not found' : `Invalid library text: ${detail}`);
		this.name = 'LibraryUpdateError';
		this.code = code;
		this.issues = Object.freeze([...issues]);
	}
}

/** S5 text rules: core normalisation (NFKC, no controls or links, description ≤ 5 lines), bounds. */
function checkedText(
	field: LibraryTextField,
	value: unknown
): { value: string; issues: LibraryTextIssue[] } {
	const issue = (code: LibraryTextCode) => ({ field, code });
	if (typeof value !== 'string') return { value: '', issues: [issue('env:type')] };
	let text: string;
	try {
		text = normalizeText(value, { multiline: field === 'description', path: `/${field}` });
	} catch (cause) {
		if (!(cause instanceof EnvelopeError)) throw cause;
		const codes = new Set(cause.errors.map((error) => error.code));
		return { value: '', issues: [...codes].map(issue) };
	}
	const length = [...text].length;
	const [min, max] = field === 'name' ? [1, LIBRARY_NAME_MAX] : [0, LIBRARY_DESCRIPTION_MAX];
	return { value: text, issues: length < min || length > max ? [issue('env:length')] : [] };
}

/** S5 label rules (core `normalizeLabels`, strict); null or an all-empty list clears. */
function checkedLabelPatch(value: unknown): {
	value: CurveLabels | null;
	issues: LibraryTextIssue[];
} {
	if (value === null) return { value: null, issues: [] };
	try {
		const labels = normalizeLabels(value);
		return { value: labels ? Object.freeze(labels) : null, issues: [] };
	} catch (cause) {
		if (!(cause instanceof EnvelopeError)) throw cause;
		const codes = new Set(cause.errors.map((error) => error.code));
		return {
			value: null,
			issues: [...codes].map((code): LibraryTextIssue => ({ field: 'labels', code }))
		};
	}
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
	// Records saved before descriptions existed have none: no migration, they load as ''.
	const description = value.description ?? '';
	if (typeof description !== 'string' || [...description].length > LIBRARY_DESCRIPTION_MAX) {
		throw new TypeError('Invalid library item description');
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
		description,
		// Records saved before labels existed have none: they load as null.
		labels: curve.labels,
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
			// No `labels` key: keep the kept record's labels, but only for the same wire order.
			let ownLabels: boolean;
			try {
				requestedId = input.id;
				favorite = input.favorite;
				updatedAt = input.updatedAt;
				ownLabels = input.labels !== undefined;
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
					const s1 = encodeS1(curve);
					const kept = duplicate ?? previous;
					// Labels name wire indexes: the input's own labels win; without them the kept
					// record's survive only for the same S1 (a permuted duplicate drops them).
					const keptLabels = kept?.s1 === s1 ? (kept.labels ?? null) : null;
					result = checkedItem({
						...curve,
						id: duplicate?.id ?? previous?.id ?? requestedId ?? id(),
						s1,
						// Re-saving overwrites the name; the description belongs to the kept record.
						description: kept?.description ?? '',
						labels: ownLabels ? curve.labels : keptLabels,
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
		/**
		 * Renames and/or describes an item with the S5 text rules (name 1–48 code points;
		 * description 0–280 and at most five lines; no links or controls), stored normalised.
		 * `labels` (ten entries by wire index, 1–24 code points each) follows the same rules;
		 * without it the item keeps its labels.
		 * Rejects with a LibraryUpdateError: `invalid-text` (with its issues, nothing written) or
		 * `not-found`. Resolves with the stored item; an unchanged text keeps its updatedAt.
		 */
		update(itemId: string, patch: LibraryTextPatch): Promise<LibraryItem> {
			// Validate and snapshot before yielding, as save does. Refused text is the user's input,
			// not a storage failure: it is not reported to the storage status.
			const issues: LibraryTextIssue[] = [];
			const text: { name?: string; description?: string } = {};
			for (const field of ['name', 'description'] as const) {
				if (patch[field] === undefined) continue;
				const checked = checkedText(field, patch[field]);
				issues.push(...checked.issues);
				text[field] = checked.value;
			}
			const labelPatch = patch.labels === undefined ? null : checkedLabelPatch(patch.labels);
			if (labelPatch) issues.push(...labelPatch.issues);
			if (issues.length) return Promise.reject(new LibraryUpdateError('invalid-text', issues));
			// The queued operation never rejects (a rejected task would block the queue): the
			// not-found rejection is raised after it.
			return enqueue(async () => {
				const outcome: { item?: LibraryItem } = {};
				await change((values) => {
					const item = values.find((value) => value.id === itemId);
					if (!item) return {};
					const name = text.name ?? item.name;
					const description = text.description ?? item.description ?? '';
					// Untouched labels stay with the item (same S1, same wire order).
					const labels = labelPatch ? labelPatch.value : (item.labels ?? null);
					if (
						name === item.name &&
						description === (item.description ?? '') &&
						sameLabels(labels, item.labels)
					) {
						outcome.item = item;
						return {};
					}
					outcome.item = checkedItem({
						...item,
						name,
						description,
						labels,
						updatedAt: nextTimestamp(now, item.updatedAt)
					});
					return { put: [outcome.item] };
				});
				return outcome.item ?? null;
			}).then((item) => {
				if (!item) throw new LibraryUpdateError('not-found');
				return item;
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
