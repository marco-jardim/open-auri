import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { isExperimentalKind } from 'open-auri/safety';
import { parseFlashState, serializeFlashState } from 'open-auri/policy';
import { getAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import {
	CABLE_WRITTEN_EVENT,
	NEUTRAL_CURVE,
	createCableService,
	type CableServiceDeps,
	type CableWrittenDetail,
	type QueueOutcome,
	type WriteOutcome
} from '#lib/cable/index.ts';
import { createClientState, type CurrentCurve, type StorageOptions } from '#lib/state/index.ts';
import { createToastStore } from '#lib/components/chrome/toast.ts';

export interface ClientAppOptions {
	storage?: StorageOptions;
	now?: () => number;
	/** Browser singleton by default; tests supply an isolated engine. */
	audio?: AudioEngine;
	cable?: Pick<CableServiceDeps, 'hid' | 'clock' | 'userActivation'>;
}

/** Explicit factory: the layout calls this only on mount, never during SSR. */
export function createClientApp(options: ClientAppOptions = {}) {
	const now = options.now ?? Date.now;
	const state = createClientState({ ...options.storage, now });
	const audio = options.audio ?? getAudioEngine();
	const toasts = createToastStore();
	let lastWrittenLevelDb: number | null = null;
	let pending = $state.raw<CurrentCurve | null>(null);
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
			record: (at) => state.flash.recordWrite(at)
		},
		lastWrittenLevelDb: () => lastWrittenLevelDb,
		sessionWriteCount: () => state.flash.state.session
	});
	let cableState = $state.raw(cable.getState());
	const unsubscribe = cable.subscribe((next) => (cableState = next));

	function written(event: Event) {
		const detail = (event as CustomEvent<CableWrittenDetail>).detail;
		lastWrittenLevelDb = detail.levelDb;
		// Mark exactly the sent snapshot, not an editor value changed during the write.
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
		get experimentalWrite() {
			return pending?.bands.some((band) => isExperimentalKind(band.kind)) ?? false;
		},
		/** Editor-only actions: these never connect, mint a gesture or write. */
		loadNeutral: () => state.curve.loadPreset(NEUTRO.id),
		loadAuriDefault: () => state.curve.loadPreset(PADRAO_AURI.id),
		/** Open a checklist on an immutable copy. No cable I/O here. */
		requestWrite(curve: CurrentCurve = state.curve.current) {
			if (!cableState.writing && pending === null) pending = structuredClone(curve);
		},
		requestRescue() {
			if (!cableState.writing && pending === null) {
				pending = {
					schema: 1,
					...NEUTRAL_CURVE,
					bands: NEUTRAL_CURVE.bands.map((band) => ({ ...band })),
					source: `preset:${NEUTRO.id}`,
					updatedAt: now()
				};
			}
		},
		closeChecklist() {
			if (!cableState.writing) pending = null;
		},
		/** Called by PreWriteChecklist; simulated/interrupted writes never clean the editor. */
		onWriteResult(outcome: WriteOutcome | QueueOutcome) {
			if (outcome.status === 'ok') lastWrittenLevelDb = outcome.levelDb;
		},
		/** Idempotent restore only: neither restore may play audio or write a curve. */
		start() {
			// getAudioEngine restores its singleton on creation; don't attach its stored file twice.
			return (started ??= Promise.all([
				state.ready,
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
