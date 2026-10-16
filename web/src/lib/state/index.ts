import { createStorage, type StorageOptions } from './storage.ts';
import { createCurveStore } from './curve.svelte.ts';
import { createJournalStore } from './journal.svelte.ts';
import { createFlashStore } from './flash.svelte.ts';
import { createMeterRefStore } from './meterRef.svelte.ts';
import { createLibraryStore } from './library.svelte.ts';
import { createOutboxStore } from './outbox.svelte.ts';
import type { Clock } from './model.ts';

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

/** Own once in a client layout/context; no process-wide SSR singleton or duplicate locale state. */
export function createClientState(options: StorageOptions & { now?: Clock } = {}) {
	const storage = createStorage(options);
	const curve = createCurveStore({ storage, now: options.now });
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
