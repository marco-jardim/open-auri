import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { isExperimentalKind } from 'open-auri/safety';
import { parseFlashState, serializeFlashState } from 'open-auri/policy';
import { getAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import {
	CABLE_INFLIGHT_KEY,
	CABLE_WRITTEN_EVENT,
	NEUTRAL_CURVE,
	createCableService,
	writtenLevelDb,
	type CableServiceDeps,
	type CableWrittenDetail,
	type QueueOutcome,
	type WriteOutcome
} from '#lib/cable/index.ts';
import { createClientState, type CurrentCurve, type StorageOptions } from '#lib/state/index.ts';
import { yolo, type YoloState } from '#lib/state/yolo.svelte.ts';
import type { WriteProfile } from '#lib/cable/types.ts';
import { createToastStore, type ToastStore } from '#lib/components/chrome/toast.ts';
import { m } from '#lib/paraglide/messages.js';

export interface ClientAppOptions {
	storage?: StorageOptions;
	now?: () => number;
	/** Browser singleton by default; tests supply an isolated engine. */
	audio?: AudioEngine;
	cable?: Pick<
		CableServiceDeps,
		'hid' | 'clock' | 'userActivation' | 'locks' | 'tabId' | 'livePolicy'
	>;
	/**
	 * Toast region store. The root layout creates it before the runtime chunk loads and injects
	 * it, so the same region serves messages from before and after the mount (FUX.2).
	 */
	toasts?: ToastStore;
	/** This tab's Modo YOLO (memory only). The module singleton by default; tests isolate it. */
	yolo?: YoloState;
}

/** Options of `requestWrite`. */
export interface WriteRequestOptions {
	/**
	 * `'yolo'`: open the checklist with the YOLO gate profile. Honoured only while Modo YOLO is on
	 * in this tab; otherwise nothing opens. While the free preview is on nothing opens for any
	 * profile (see `requestWrite`).
	 */
	profile?: WriteProfile;
}

/** Explicit factory: the layout calls this only on mount, never during SSR. */
export function createClientApp(options: ClientAppOptions = {}) {
	const now = options.now ?? Date.now;
	const yoloState = options.yolo ?? yolo;
	// The curve store adopts other tabs' curves and undo steps under this app's Modo YOLO (an
	// injected `yolo` included), never the module singleton's.
	const state = createClientState({
		...options.storage,
		now,
		profile: () => yoloState.profile
	});
	const audio = options.audio ?? getAudioEngine();
	const toasts = options.toasts ?? createToastStore();
	let pending = $state.raw<CurrentCurve | null>(null);
	/** Gate profile of the open checklist (`'yolo'` only when asked for while YOLO was on). */
	let pendingProfile = $state<WriteProfile>('standard');
	let disposed = false;
	let started: Promise<void> | undefined;

	const cable = createCableService({
		...options.cable,
		now,
		journal: {
			append(entry) {
				if (!state.journal.append(entry)) throw new Error('Could not persist cable journal');
			},
			last: () => state.journal.entries.at(-1) ?? null
		},
		flash: {
			get() {
				// Pure read: it runs inside the checklist's derived evaluation, so it must not mutate state.
				// parseFlashState(raw, now) keeps the core's conservative cooldown anchor; cross-tab
				// updates arrive through the flash store's storage-event subscription.
				return parseFlashState(serializeFlashState(state.flash.state), now());
			},
			record: (at) => state.flash.recordWrite(at),
			touch: (at) => state.flash.touchWrite(at),
			// Inside the write lock only: adopt counters/spacing another tab persisted.
			sync: (at) => {
				state.flash.canWriteNow(at);
			}
		},
		// Persisted source: the last `ok` journal entry, so a reload or another tab keeps the
		// loudness jump warning (journal updates from other tabs arrive via storage events).
		lastWrittenLevelDb: () => {
			const entry = state.journal.lastOk;
			return entry === null ? null : writtenLevelDb(entry);
		},
		sessionWriteCount: () => state.flash.state.session,
		// Modo YOLO, read live at every checklist evaluation: off, or the free preview on, refuses
		// a YOLO write (the per-write confirmation is the checklist's own item).
		yoloSession: () => yoloState.enabled && yoloState.writeBlock() === null,
		// Same localStorage (and failure reporting) as the rest of the app state.
		inflight: {
			read: () => state.storage.readPersisted('local', CABLE_INFLIGHT_KEY),
			write: (value) => state.storage.write('local', CABLE_INFLIGHT_KEY, value),
			// Another tab stored or removed its marker: the service waits for that writer's lock.
			subscribe: (listener) =>
				state.storage.onStorage((event) => {
					if (event.area !== 'local') return;
					if (event.key === CABLE_INFLIGHT_KEY || event.key === null) listener();
				})
		}
	});
	let cableState = $state.raw(cable.getState());
	/** A close asked for while writing; applied once the write ends, so `pending` never wedges. */
	let closeAfterWrite = false;
	const unsubscribe = cable.subscribe((next) => {
		cableState = next;
		if (closeAfterWrite && !next.writing) {
			closeAfterWrite = false;
			pending = null;
		}
	});

	function written(event: Event) {
		const detail = (event as CustomEvent<CableWrittenDetail>).detail;
		// Mark exactly the sent snapshot, not an editor value changed during the write. A Modo
		// YOLO write (`detail.profile === 'yolo'`) is the cable's contents all the same.
		state.curve.markWritten({
			...(pending ?? state.curve.current),
			name: detail.entry.name,
			bands: detail.bands,
			preampDb: detail.preampDb,
			updatedAt: detail.at
		});
	}
	cable.events.addEventListener(CABLE_WRITTEN_EVENT, written);

	return {
		state,
		audio,
		/** Read status/connect/subscribe here. Writes belong only to PreWriteChecklist. */
		cable,
		toasts,
		get cableState() {
			return cableState;
		},
		get pendingWrite() {
			return pending;
		},
		/** Gate profile of the open checklist. */
		get pendingProfile(): WriteProfile {
			return pending === null ? 'standard' : pendingProfile;
		},
		/** This tab's Modo YOLO. */
		yolo: yoloState,
		get experimentalWrite() {
			return pending?.bands.some((band) => isExperimentalKind(band.kind)) ?? false;
		},
		/** Editor-only actions: these never connect, mint a gesture or write. */
		loadNeutral: () => state.curve.loadPreset(NEUTRO.id),
		loadAuriDefault: () => state.curve.loadPreset(PADRAO_AURI.id),
		/**
		 * Open a checklist on an immutable copy. No cable I/O here. `$state.snapshot` also copies
		 * deep `$state` proxies (a page's selected tape), which `structuredClone` cannot clone.
		 *
		 * While the free preview is on, no checklist opens, whatever the profile: what is heard
		 * is a memory-only draft, not the curve a write would send. The refusal is a toast. Every
		 * page (top bar, Curva, Cabo, Biblioteca, shared curve) goes through here; only
		 * `requestRescue` stays available.
		 */
		requestWrite(curve: CurrentCurve = state.curve.current, request: WriteRequestOptions = {}) {
			if (cableState.writing || pending !== null) return;
			if (yoloState.writeBlock() !== null) {
				toasts.push(m.yolo_reason_free_preview(), { tone: 'error' });
				return;
			}
			const yoloWrite = request.profile === 'yolo';
			// A YOLO checklist opens only while YOLO is on in this tab.
			if (yoloWrite && !yoloState.enabled) return;
			pendingProfile = yoloWrite ? 'yolo' : 'standard';
			pending = $state.snapshot(curve);
		},
		requestRescue() {
			if (!cableState.writing && pending === null) {
				// The rescue is always the standard Neutro write.
				pendingProfile = 'standard';
				pending = {
					schema: 1,
					...NEUTRAL_CURVE,
					bands: NEUTRAL_CURVE.bands.map((band) => ({ ...band })),
					source: `preset:${NEUTRO.id}`,
					// The rescue curve is the Neutro preset: presets never carry filter labels.
					labels: null,
					updatedAt: now()
				};
			}
		},
		/** Closes the checklist; asked mid-write, it closes as soon as that write ends. */
		closeChecklist() {
			if (cableState.writing) {
				closeAfterWrite = pending !== null;
				return;
			}
			closeAfterWrite = false;
			pending = null;
		},
		/**
		 * Called by PreWriteChecklist. Nothing to feed back: the last written level comes from the
		 * persisted journal, and simulated/interrupted writes never clean the editor.
		 */
		onWriteResult(outcome: WriteOutcome | QueueOutcome) {
			void outcome;
		},
		/** Idempotent restore only: neither restore may play audio or write a curve. */
		start() {
			// getAudioEngine restores its singleton on creation; don't attach its stored file twice.
			return (started ??= Promise.all([
				state.ready,
				cable.ready,
				cable.restore(),
				options.audio ? audio.restore() : undefined
			]).then(() => undefined));
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			cable.events.removeEventListener(CABLE_WRITTEN_EVENT, written);
			cable.dispose();
			audio.stop();
			state.dispose();
			toasts.clear();
		}
	};
}

export type ClientApp = ReturnType<typeof createClientApp>;
