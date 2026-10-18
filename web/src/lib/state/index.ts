import { createStorage, type StorageOptions } from './storage.ts';
import { createCurveStore } from './curve.svelte.ts';
import { createJournalStore } from './journal.svelte.ts';
import { createFlashStore } from './flash.svelte.ts';
import { createMeterRefStore } from './meterRef.svelte.ts';
import { createLibraryStore } from './library.svelte.ts';
import { createOutboxStore } from './outbox.svelte.ts';
import type { Clock } from './model.ts';
import type { YoloProfile } from './yolo.svelte.ts';

export { createStorage } from './storage.ts';
export { createCurveStore } from './curve.svelte.ts';
export { createJournalStore } from './journal.svelte.ts';
export { createFlashStore } from './flash.svelte.ts';
export { createMeterRefStore } from './meterRef.svelte.ts';
export { createLibraryStore } from './library.svelte.ts';
export { createOutboxStore } from './outbox.svelte.ts';
export type { CurveData, CurrentCurve, CurveSource, Bands } from './model.ts';
export type { ClientStorage, StorageOptions, StorageFailure } from './storage.ts';
export type { LibraryInput, LibraryItem } from './library.svelte.ts';
export type { PendingEvent, JsonValue } from './outbox.svelte.ts';
export type { MeterReference } from './meterRef.svelte.ts';

/**
 * Own once in a client layout/context; no process-wide SSR singleton or duplicate locale state.
 * `profile`: the editor's gate profile, read by the curve store at every adoption (the app's own
 * Modo YOLO); the module-level `yolo` when omitted.
 */
export function createClientState(
	options: StorageOptions & { now?: Clock; profile?: () => YoloProfile } = {}
) {
	const { profile, ...storageOptions } = options;
	const storage = createStorage(storageOptions);
	const curve = createCurveStore({ storage, now: options.now, ...(profile ? { profile } : {}) });
	const journal = createJournalStore({ storage });
	const flash = createFlashStore({ storage, now: options.now });
	const meterRef = createMeterRefStore({ storage });
	const library = createLibraryStore({ storage, now: options.now });
	const outbox = createOutboxStore({ storage, now: options.now });
	return {
		storage,
		curve,
		journal,
		flash,
		meterRef,
		library,
		outbox,
		ready: Promise.all([library.ready, outbox.ready]),
		dispose() {
			curve.dispose();
			journal.dispose();
			flash.dispose();
			meterRef.dispose();
			library.dispose();
			outbox.dispose();
			storage.dispose();
		}
	};
}
