import { getPreset } from 'open-auri/catalog';
import { gateAccepts as sharedGateAccepts } from '../gate-verdicts.ts';
import { createStorage, type ClientStorage } from './storage.ts';
import { LABEL_COUNT } from 'open-auri/share';
import { checkedCurve, curveSignature, neutralCurve, nextTimestamp, sameLabels } from './model.ts';
import type { Clock, CurrentCurve, CurveData, CurveLabels } from './model.ts';
import { storageStatus } from './status.svelte.ts';
import { yolo, type YoloProfile } from './yolo.svelte.ts';

export const CURRENT_STORAGE_KEY = 'oa.current';
export const WRITTEN_STORAGE_KEY = 'oa.curve.written';
export const UNDO_LIMIT = 100;
const NO_LABELS: CurveLabels = Object.freeze([]);

export interface CurveStoreOptions {
	storage?: ClientStorage;
	now?: Clock;
	/**
	 * Gate profile of this tab's editor, read at every adoption: `'yolo'` while Modo YOLO is on in
	 * this tab. This tab's own `yolo` by default (memory only, so standard right after a load).
	 */
	profile?: () => YoloProfile;
}

/**
 * The verdicts of each stored curve by profile, read from the client's shared verdict cache
 * (`gate-verdicts.ts`, the one the audio engine and the Curva preview use, so a curve is judged
 * once for all of them). Stored curves are frozen, so this only remembers which shared verdict
 * each one got: the undo history (up to `UNDO_LIMIT` curves each way, scanned at every
 * `canUndo`/`canRedo` read) holds more curves than the shared cache keeps, and scanning it in
 * order through the cache alone would evict and judge every entry again at every read.
 */
const judged = new WeakMap<CurrentCurve, Partial<Record<YoloProfile, boolean>>>();

/**
 * Whether the write gate (full grid) accepts `curve` in `profile`: `'standard'`, every reason
 * blocks; `'yolo'`, the hard reasons (class 1) block. Experimental kinds pass with their flag, as
 * in the editor.
 */
export function gateAccepts(curve: CurrentCurve, profile: YoloProfile): boolean {
	const known = judged.get(curve) ?? {};
	const cached = known[profile];
	if (cached !== undefined) return cached;
	const ok = sharedGateAccepts(curve.bands, curve.preampDb, { profile });
	judged.set(curve, { ...known, [profile]: ok });
	return ok;
}

/**
 * The editor curve, its undo history and its persistence (`oa.current`).
 *
 * Hearing safety (C1): the editor gates every edit before `set`, and the free preview's
 * codec-only curves never reach the store (the Curva page keeps them in a memory-only draft).
 * On top of that, a curve this tab did not just make through its own gated edit is adopted only
 * when the gate of this tab's profile accepts it:
 * - another tab's curve (storage event) and an undo or redo step: a curve the standard gate
 *   accepts is always adopted (every profile edits it); a YOLO-only curve only while Modo YOLO is
 *   on here; a curve failing the YOLO hard reasons (codec-only) never. A refused curve from
 *   another tab leaves this tab's curve and history as they are; refused undo or redo steps are
 *   skipped (and dropped when an earlier step is adopted), so Desfazer goes to the newest curve
 *   this tab may use now, and `canUndo`/`canRedo` say whether there is one. An undo or redo step
 *   with the current curve's bands and preamp (labels or name only) is always adopted: it
 *   changes nothing that is heard or written;
 * - `oa.current` on load: YOLO is always off after a load, yet the YOLO curve a tab left there
 *   comes back to the editor (protected preview, no export: see curva/yolo.ts). Only a curve
 *   failing even the YOLO hard reasons (a codec-only curve from an older build or edited by
 *   hand) is refused: the editor starts on Neutro.
 */
export function createCurveStore(options: CurveStoreOptions = {}) {
	const storage = options.storage ?? createStorage();
	const status = storageStatus(storage);
	const now = options.now ?? Date.now;
	const profile = options.profile ?? (() => yolo.profile);
	/** Another tab's curve, an undo or a redo step: adopted only under this tab's profile. */
	function adoptable(curve: CurrentCurve): boolean {
		return gateAccepts(curve, 'standard') || (profile() === 'yolo' && gateAccepts(curve, 'yolo'));
	}
	/** `oa.current` on load: anything but a curve failing the YOLO hard reasons. */
	function restorable(curve: CurrentCurve | null): CurrentCurve | null {
		return curve && (gateAccepts(curve, 'standard') || gateAccepts(curve, 'yolo')) ? curve : null;
	}
	/**
	 * Index of the newest entry of `stack` this tab may adopt now, or -1. An entry with the bands
	 * and preamp of the current curve is a labels-only (or name-only) step: adopting it changes
	 * nothing that is heard or written, so it is always adoptable. Without this, renaming the
	 * filters of a YOLO-only curve restored with YOLO off could never be undone.
	 */
	function newestAdoptable(stack: readonly CurrentCurve[]): number {
		const current = curveSignature(value);
		for (let index = stack.length - 1; index >= 0; index--) {
			const entry = stack[index];
			if (entry && (curveSignature(entry) === current || adoptable(entry))) return index;
		}
		return -1;
	}
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
		restorable(parse(storage.read('local', CURRENT_STORAGE_KEY))) ?? neutralCurve()
	);
	let past = $state.raw<CurrentCurve[]>([]);
	let future = $state.raw<CurrentCurve[]>([]);
	// Last snapshot really written to the cable; persisted so a reload after a write stays clean.
	let written = $state.raw<CurrentCurve | null>(readWritten());
	// True once the user changed the curve in this session (set/update/preset/undo/redo).
	let edited = $state(false);
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
			// C1: a curve this tab may not adopt now keeps this tab's curve and history.
			if (!adoptable(incoming)) return;
			value = incoming;
			past = [];
			future = [];
			storage.acceptExternal('local', CURRENT_STORAGE_KEY);
		} else if (persisted && persisted.updatedAt === value.updatedAt && adoptable(persisted)) {
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
				next.source === value.source &&
				sameLabels(next.labels, value.labels)
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
		/** An undo step this tab may adopt now exists (C1: see `undo`). */
		get canUndo() {
			return newestAdoptable(past) >= 0;
		},
		/** A redo step this tab may adopt now exists (C1: see `redo`). */
		get canRedo() {
			return newestAdoptable(future) >= 0;
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
		/**
		 * Custom band names by wire index, from the current curve (`CurveData.labels`, persisted
		 * with it in `oa.current`, the undo history and the library). Empty when none is set.
		 * Curva reads and writes them through `band-labels.svelte.ts`.
		 */
		get labels(): CurveLabels {
			return value.labels ?? NO_LABELS;
		},
		/**
		 * Sets the labels of the current curve (padded or cut to ten entries, normalized by core
		 * `normalizeLabels`): a label-only change is a real, persisted, undoable edit.
		 */
		setLabels(next: readonly (string | null)[]) {
			return set({
				...value,
				labels: Array.from({ length: LABEL_COUNT }, (_, index) => next[index] ?? null)
			});
		},
		set,
		update(patch: Partial<CurveData>) {
			return set({ ...value, ...patch });
		},
		/** A preset never carries labels: loading one clears them. */
		loadPreset(id: string) {
			const preset = getPreset(id);
			return preset
				? set({
						name: preset.label,
						source: `preset:${id}`,
						preampDb: preset.preampDb,
						bands: preset.bands,
						labels: null
					})
				: false;
		},
		/**
		 * Back to the newest earlier curve this tab may adopt now (C1): steps it may not (a YOLO-only
		 * curve once YOLO is off here) are skipped and dropped. A step with the current bands and
		 * preamp (a rename) is always taken: it changes nothing heard. Nothing changes, and false,
		 * when there is none.
		 */
		undo() {
			const index = newestAdoptable(past);
			const previous = past[index];
			if (index < 0 || !previous) return false;
			future = [...future, value].slice(-UNDO_LIMIT);
			past = past.slice(0, index);
			persist(checkedCurve({ ...previous, updatedAt: timestamp() }));
			return true;
		},
		/** Like `undo`, forwards: refused redo steps are skipped and dropped. */
		redo() {
			const index = newestAdoptable(future);
			const next = future[index];
			if (index < 0 || !next) return false;
			past = [...past, value].slice(-UNDO_LIMIT);
			future = future.slice(0, index);
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
