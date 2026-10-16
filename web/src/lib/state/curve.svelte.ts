import { getPreset } from 'open-auri/catalog';
import { createStorage, type ClientStorage } from './storage.ts';
import { checkedCurve, curveSignature, neutralCurve, nextTimestamp } from './model.ts';
import type { Clock, CurrentCurve, CurveData } from './model.ts';
import { storageStatus } from './status.svelte.ts';

export const CURRENT_STORAGE_KEY = 'oa.current';
export const UNDO_LIMIT = 100;

export function createCurveStore(options: { storage?: ClientStorage; now?: Clock } = {}) {
	const storage = options.storage ?? createStorage();
	const status = storageStatus(storage);
	const now = options.now ?? Date.now;
	function parse(raw: string | null): CurrentCurve | null {
		if (raw === null) return null;
		try {
			return checkedCurve(JSON.parse(raw));
		} catch (cause) {
			storage.report(cause, CURRENT_STORAGE_KEY, true);
			return null;
		}
	}
	let value = $state.raw<CurrentCurve>(
		parse(storage.read('local', CURRENT_STORAGE_KEY)) ?? neutralCurve()
	);
	let past = $state.raw<CurrentCurve[]>([]);
	let future = $state.raw<CurrentCurve[]>([]);
	let written = $state.raw<CurrentCurve | null>(null);
	function persist(next: CurrentCurve) {
		value = next;
		storage.write('local', CURRENT_STORAGE_KEY, JSON.stringify(next));
	}
	const stop = storage.onStorage((event) => {
		if (event.area !== 'local' || (event.key !== CURRENT_STORAGE_KEY && event.key !== null)) return;
		let incoming = parse(event.key === null ? null : event.newValue);
		const persisted = parse(storage.readPersisted('local', CURRENT_STORAGE_KEY));
		// The backend breaks equal-timestamp races; delayed events cannot roll a tab back.
		if (persisted && (!incoming || persisted.updatedAt >= incoming.updatedAt)) {
			incoming = persisted;
		}
		if ((event.key === null || event.newValue === null) && !persisted) {
			value = neutralCurve();
			past = [];
			future = [];
			storage.acceptExternal('local', CURRENT_STORAGE_KEY);
			return;
		}
		if (incoming && incoming.updatedAt > value.updatedAt) {
			value = incoming;
			past = [];
			future = [];
			storage.acceptExternal('local', CURRENT_STORAGE_KEY);
		} else if (persisted && persisted.updatedAt === value.updatedAt) {
			value = persisted;
		}
	});
	function timestamp() {
		const latest = parse(storage.read('local', CURRENT_STORAGE_KEY));
		return nextTimestamp(now, Math.max(value.updatedAt, latest?.updatedAt ?? 0));
	}
	function set(input: CurveData): boolean {
		try {
			const next = checkedCurve({ ...input, schema: 1, updatedAt: timestamp() });
			if (
				curveSignature(next) === curveSignature(value) &&
				next.name === value.name &&
				next.source === value.source
			) {
				return true;
			}
			past = [...past, value].slice(-UNDO_LIMIT);
			future = [];
			persist(next);
			return true;
		} catch (cause) {
			storage.report(cause, 'curve:set', true);
			return false;
		}
	}
	return {
		get current() {
			return value;
		},
		get dirty() {
			return written === null || curveSignature(value) !== curveSignature(written);
		},
		get lastWritten() {
			return written;
		},
		get canUndo() {
			return past.length > 0;
		},
		get canRedo() {
			return future.length > 0;
		},
		get undoCount() {
			return past.length;
		},
		get redoCount() {
			return future.length;
		},
		get error() {
			return status.error;
		},
		set,
		update(patch: Partial<CurveData>) {
			return set({ ...value, ...patch });
		},
		loadPreset(id: string) {
			const preset = getPreset(id);
			return preset
				? set({
						name: preset.label,
						source: `preset:${id}`,
						preampDb: preset.preampDb,
						bands: preset.bands
					})
				: false;
		},
		undo() {
			const previous = past.at(-1);
			if (!previous) return false;
			future = [...future, value].slice(-UNDO_LIMIT);
			past = past.slice(0, -1);
			persist(checkedCurve({ ...previous, updatedAt: timestamp() }));
			return true;
		},
		redo() {
			const next = future.at(-1);
			if (!next) return false;
			past = [...past, value].slice(-UNDO_LIMIT);
			future = future.slice(0, -1);
			persist(checkedCurve({ ...next, updatedAt: timestamp() }));
			return true;
		},
		/** Call only after a real successful write, with the snapshot actually sent. */
		markWritten(snapshot: CurrentCurve = value) {
			try {
				written = checkedCurve(snapshot);
				return true;
			} catch (cause) {
				storage.report(cause, 'curve:markWritten', true);
				return false;
			}
		},
		dispose() {
			stop();
			status.dispose();
			if (!options.storage) storage.dispose();
		}
	};
}
