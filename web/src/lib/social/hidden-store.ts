import { writable } from 'svelte/store';
import type { SocialApi } from './api.ts';
import { HIDDEN_LIMIT, HIDDEN_STORAGE_KEY, hiddenId, isHidden, normalizeHidden, type HiddenLabels, type HiddenList, type HiddenTarget, type HiddenType } from './hidden.ts';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface HiddenState extends HiddenList {
	labels: HiddenLabels;
	ready: boolean;
	busy: boolean;
	error: boolean;
	signedIn: boolean;
}
type HiddenApi = Pick<SocialApi, 'myHidden' | 'putHidden' | 'deleteHidden'>;

function fromItems(items: (HiddenTarget & { label?: string | null })[]): ReturnType<typeof normalizeHidden> {
	return normalizeHidden({
		authors: items.filter((item) => item.targetType === 'author').map((item) => item.targetId),
		curves: items.filter((item) => item.targetType === 'curve').map((item) => item.targetId),
		labels: {
			authors: Object.fromEntries(items.filter((item) => item.targetType === 'author' && item.label).map((item) => [item.targetId, item.label])),
			curves: Object.fromEntries(items.filter((item) => item.targetType === 'curve' && item.label).map((item) => [item.targetId, item.label]))
		}
	});
}

/** Per-layout, never a process singleton. Account data is never written to localStorage. */
export function createHiddenStore(api: HiddenApi, storage: () => Storage | null = () =>
	typeof window === 'undefined' ? null : window.localStorage) {
	let state: HiddenState = { authors: [], curves: [], labels: { authors: {}, curves: {} }, ready: false, busy: false, error: false, signedIn: false };
	const store = writable(state);
	let actor: string | null | undefined;
	let generation = 0;
	let queue = Promise.resolve();
	function update(next: Partial<HiddenState>) {
		state = { ...state, ...next };
		store.set(state);
	}
	function local(): HiddenList {
		const raw = storage()?.getItem(HIDDEN_STORAGE_KEY);
		if (!raw) return { authors: [], curves: [] };
		try {
			return normalizeHidden(JSON.parse(raw));
		} catch (error) {
			console.warn('Invalid hidden items in browser storage', error);
			return { authors: [], curves: [] };
		}
	}
	async function sync() {
		const ticket = generation;
		update({ busy: true, error: false });
		let pending: HiddenList | undefined;
		try {
			pending = local();
			if (actor == null) {
				update({ ...pending, ready: true });
				return;
			}
			// PUT is an atomic union on the server. On overflow/failure, keep ALL local preferences
			// and keep UGC closed until the reader retries; never silently lose a hidden target.
			const result = pending.authors.length || pending.curves.length
				? await api.putHidden(pending) : await api.myHidden();
			if (ticket !== generation) return;
			storage()?.removeItem(HIDDEN_STORAGE_KEY);
			update({ ...fromItems(result.items), ready: true });
		} catch (error) {
			if (ticket === generation) {
				update({ error: true });
				// A full account plus a local list must still be manageable. Keep UGC closed,
				// but show both lists (at most 1000 per type) so the reader can free a slot.
				if (pending && actor != null) {
					try {
						const remote = fromItems((await api.myHidden()).items);
						if (ticket === generation) update({
							authors: [...new Set([...remote.authors, ...pending.authors])],
							curves: [...new Set([...remote.curves, ...pending.curves])],
							labels: { authors: { ...pending.labels?.authors, ...remote.labels.authors }, curves: { ...pending.labels?.curves, ...remote.labels.curves } },
							ready: false
						});
					} catch (readError) {
						console.warn('Account hidden items could not be read after a failed merge', readError);
					}
				}
			}
			console.warn('Hidden items could not sync', error);
		} finally {
			if (ticket === generation) update({ busy: false });
		}
	}
	function setUser(userId: string | null) {
		if (actor === userId) return queue;
		actor = userId;
		generation++;
		update({ authors: [], curves: [], labels: { authors: {}, curves: {} }, ready: false, busy: false, error: false, signedIn: userId !== null });
		queue = sync();
		return queue;
	}
	function change(type: HiddenType, rawId: string, hide: boolean, label?: string): Promise<void> {
		const ticket = generation;
		const id = hiddenId(type, rawId);
		if (!id) return Promise.reject(new Error('Invalid hidden target'));
		const task = queue.then(async () => {
			if (ticket !== generation || (!state.ready && hide)) throw new Error('Hidden items not ready');
			update({ busy: true, error: false });
			try {
				const key = type === 'author' ? 'authors' : 'curves';
				if (hide && !state[key].includes(id) && state[key].length >= HIDDEN_LIMIT) {
					throw new Error('Hidden items limit reached');
				}
				const next: HiddenList = { authors: [...state.authors], curves: [...state.curves],
					labels: { authors: { ...state.labels.authors }, curves: { ...state.labels.curves } } };
				next[key] = hide ? [...new Set([...next[key], id])] : next[key].filter((value) => value !== id);
				const labels = next.labels;
				if (labels && hide && label?.trim()) Object.defineProperty(labels[key], id, { value: label, enumerable: true, configurable: true });
				if (labels && !hide) delete labels[key][id];
				const normalized = normalizeHidden(next);
				if (actor != null) {
					const result = hide
						? await api.putHidden({ authors: type === 'author' ? [id] : [], curves: type === 'curve' ? [id] : [], labels: normalized.labels })
						: await api.deleteHidden({ targetType: type, targetId: id });
					if (ticket === generation) {
						const pending = local();
						if (!hide && (pending.authors.length || pending.curves.length)) {
							const remaining = normalizeHidden({ ...pending, [key]: pending[key].filter((value) => value !== id) });
							storage()?.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(remaining));
							await sync();
						} else {
							update({ ...fromItems(result.items), ready: true });
						}
					}
				} else {
					const target = storage();
					if (!target) throw new Error('Browser storage unavailable');
					target.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(normalized));
					update(normalized);
				}
			} catch (error) {
				if (ticket === generation) update({ error: true });
				throw error;
			} finally {
				if (ticket === generation) update({ busy: false });
			}
		});
		queue = task.catch((error: unknown) => console.warn('Hidden item change failed', error));
		return task;
	}
	return {
		subscribe: store.subscribe,
		setUser,
		retry: () => { queue = queue.then(sync); return queue; },
		hide: (type: HiddenType, id: string, label?: string) => change(type, id, true, label),
		unhide: (type: HiddenType, id: string) => change(type, id, false),
		visible: (id: string, author?: string | null) => state.ready && !isHidden(state, id, author)
	};
}
export type HiddenStore = ReturnType<typeof createHiddenStore>;
