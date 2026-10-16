/**
 * The "write in progress" flag shared with code that must never reload the page mid-write (the
 * PWA update flow, the language toggle). `window.__oaWriteInProgress` stays the public contract
 * (see web/src/lib/pwa/README.md); this module also notifies listeners when it changes.
 *
 * Kept free of transport imports so chrome components can read it cheaply.
 */

type FlagScope = typeof globalThis & { __oaWriteInProgress?: boolean };

const changes = new EventTarget();
const CHANGE_EVENT = 'change';
let activeWrites = 0;

/** Whether a cable write is sending bytes right now (any service instance of this page). */
export function isWriteInProgress(): boolean {
	return (globalThis as FlagScope).__oaWriteInProgress === true;
}

/** Calls `listener` whenever the flag may have changed. Returns the unsubscribe function. */
export function onWriteProgress(listener: () => void): () => void {
	changes.addEventListener(CHANGE_EVENT, listener);
	return () => changes.removeEventListener(CHANGE_EVENT, listener);
}

function publish() {
	(globalThis as FlagScope).__oaWriteInProgress = activeWrites > 0;
	changes.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Runs `run` with the flag set (counts overlapping writes); always clears it afterwards. */
export async function withWriteFlag<T>(run: () => Promise<T>): Promise<T> {
	activeWrites += 1;
	publish();
	try {
		return await run();
	} finally {
		activeWrites -= 1;
		publish();
	}
}
