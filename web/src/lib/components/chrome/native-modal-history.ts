import { isNativeAndroid } from '#lib/cable/native/gate.ts';

interface Overlay {
	canDismiss: () => boolean;
	dismiss: () => void;
}

const STATE_KEY = 'oa.nativeModal';
const overlays: Overlay[] = [];
let entry: { id: string; url: string } | undefined;
let removing = false;

/**
 * One same-URL history fence for the native modal stack. Capacitor's default Back goes
 * through WebView history, so each press consumes this fence instead of leaving the app.
 * Nested modals share it: after Back, re-arm only if another modal (or a close guard) remains.
 */
function sync(): void {
	if (removing) return;
	if (overlays.length > 0 && !entry) {
		entry = { id: crypto.randomUUID(), url: location.href };
		// Copy SvelteKit's history metadata (same index): even a router that saw the pop back to
		// the page's own entry would take it as the current entry. No route or scroll change.
		history.pushState({ ...history.state, [STATE_KEY]: entry.id }, '', entry.url);
	} else if (overlays.length === 0 && entry) {
		if (history.state?.[STATE_KEY] === entry.id && location.href === entry.url) {
			// Traversal is asynchronous. A sheet opened in the meantime must wait for this pop,
			// otherwise the cleanup would consume the new sheet's entry instead.
			removing = true;
			history.back();
		} else {
			// Navigation already replaced the entry: never go back across a real route change.
			entry = undefined;
		}
	}
}

function pop(event: PopStateEvent): void {
	if (!entry) return;
	const samePage = location.href === entry.url;
	entry = undefined;
	const cleanup = removing;
	removing = false;
	if (!samePage) return;
	// This is our same-page fence, not a router navigation (including the UI-close pop).
	event.stopImmediatePropagation();
	if (!cleanup) {
		const top = overlays.at(-1);
		if (top?.canDismiss()) {
			top.dismiss();
			// Let the controlled parent's Svelte update unregister it. If a caller refuses
			// dismissal, keep the fence instead of leaving a still-open modal unprotected.
			queueMicrotask(sync);
			return;
		}
	}
	sync();
}

/**
 * Installed once, when this module is evaluated. The root layout imports it statically, so this
 * runs during hydration, before SvelteKit's client router adds its own `popstate` listener on
 * `window` (`_start_router()`, after hydration). `window` is the event's target, so `capture`
 * gives no precedence there: registration order decides which listener runs first and can stop
 * the other. Without an active fence (always, outside the app) it returns at once.
 */
if (typeof window !== 'undefined') window.addEventListener('popstate', pop, true);

/** Register only while a modal is open. Browsers/desktop never get a history entry. */
export function nativeModalHistory(overlay: Overlay): () => void {
	if (!isNativeAndroid()) return () => undefined;
	overlays.push(overlay);
	sync();
	return () => {
		const index = overlays.indexOf(overlay);
		if (index !== -1) overlays.splice(index, 1);
		sync();
	};
}
