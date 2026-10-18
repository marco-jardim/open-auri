import { getPreset } from 'open-auri/catalog';
import { createStorage, type ClientStorage } from './storage.ts';
import { checkedCurve, curveSignature, neutralCurve, nextTimestamp } from './model.ts';
import type { Clock, CurrentCurve, CurveData } from './model.ts';
import { storageStatus } from './status.svelte.ts';

export const CURRENT_STORAGE_KEY = 'oa.current';
export const WRITTEN_STORAGE_KEY = 'oa.curve.written';
export const UNDO_LIMIT = 100;

export function createCurveStore(options: { storage?: ClientStorage; now?: Clock } = {}) {
	const storage = options.storage ?? createStorage();
	const status = storageStatus(storage);
	const now = options.now ?? Date.now;
	function parse(raw: string | null, key = CURRENT_STORAGE_KEY): CurrentCurve | null {
		if (raw === null) return null;
		try {
			return checkedCurve(JSON.parse(raw));
		} catch (cause) {
			storage.report(cause, key, true);
			return null;
		}
	}
	function readWritten() {
		return parse(storage.read('local', WRITTEN_STORAGE_KEY), WRITTEN_STORAGE_KEY);
	}
	let value = $state.raw<CurrentCurve>(
		parse(storage.read('local', CURRENT_STORAGE_KEY)) ?? neutralCurve()
	);
	let past = $state.raw<CurrentCurve[]>([]);
	let future = $state.raw<CurrentCurve[]>([]);
	// Last snapshot really written to the cable; persisted so a reload after a write stays clean.
	let written = $state.raw<CurrentCurve | null>(readWritten());
	// True once the user changed the curve in this session (set/update/preset/undo/redo).
	let edited = $state(false);
	// Custom names of the band slots (A to J), null where the automatic name applies. Client state
	// only for now: not part of CurveData, so neither `oa.current`, the undo history, share links
	// nor the library carry them. Loading another curve (any source but "custom") clears them.
	let labels = $state.raw<readonly (string | null)[]>([]);
	function persist(next: CurrentCurve) {
		value = next;
		edited = true;
		storage.write('local', CURRENT_STORAGE_KEY, JSON.stringify(next));
	}
	const stop = storage.onStorage((event) => {
		if (event.area !== 'local') return;
		if (event.key === WRITTEN_STORAGE_KEY || event.key === null) {
			// Another tab wrote (or the storage was cleared): its snapshot is authoritative.
			written = parse(
				event.key === null ? storage.readPersisted('local', WRITTEN_STORAGE_KEY) : event.newValue,
				WRITTEN_STORAGE_KEY
			);
			storage.acceptExternal('local', WRITTEN_STORAGE_KEY);
			if (event.key !== null) return;
		}
		if (event.key !== CURRENT_STORAGE_KEY && event.key !== null) return;
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
	function isDirty() {
		return written === null || curveSignature(value) !== curveSignature(written);
	}
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
			if (next.source !== 'custom') labels = [];
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
			return isDirty();
		},
		/**
		 * Chrome indicator: `dirty`, but only once there is something to compare against (a real
		 * write was ever recorded) or the user edited the curve in this session. A fresh profile
		 * that only loaded the default curve does not claim unsaved changes.
		 */
		get unsaved() {
			return (written !== null || edited) && isDirty();
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
		/** Custom band names by slot (client state only; Curva reads and writes them through
		 * `band-labels.svelte.ts`). */
		get labels() {
			return labels;
		},
		setLabels(next: readonly (string | null)[]) {
			labels = [...next];
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
				const next = checkedCurve(snapshot);
				written = next;
				storage.write('local', WRITTEN_STORAGE_KEY, JSON.stringify(next));
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
