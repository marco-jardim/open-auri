import { isNativeAndroid } from '#lib/cable/native/gate.ts';

/**
 * Android Back contract, matching MainActivity.NATIVE_BACK_SCRIPT:
 * `(window.__oaWriteInProgress === true || !window.dispatchEvent(new CustomEvent('oa:native-back',
 * { cancelable: true }))) ? 'consumed' : (window.__oaBackLeaves === true ? 'leave' : 'history')`.
 * A write consumes Back without dispatching the event. Otherwise preventDefault() consumes it
 * (closing only the topmost dismissible overlay, or keeping a busy overlay open). An uncanceled
 * event with __oaBackLeaves === true leaves the app even when WebView history exists; without
 * that flag MainActivity goes back in WebView history, or leaves if there is none.
 *
 * __oaBackLeaves is true only while the top registration is a blocked, non-consuming notice.
 * Every stack change/unregister refreshes it, as does each dispatched Back to recheck guards.
 * Such a notice never dismisses/acknowledges itself or an overlay below it. If any consuming
 * overlay below it is busy, the event is canceled instead: consuming always wins over leaving.
 */
export const NATIVE_BACK_EVENT = 'oa:native-back';

declare global {
	interface Window {
		__oaBackLeaves?: boolean;
	}
}

export interface NativeBackOverlay {
	/** Rechecked on each Back press (e.g. a write in progress, an unacknowledged notice). */
	canDismiss: () => boolean;
	dismiss: () => void;
	/** Defaults to true. A mandatory notice may let Back leave without acknowledging it. */
	consumeWhenBlocked?: boolean;
}

/** Open overlays, in opening order: the last one is the topmost. */
const overlays: NativeBackOverlay[] = [];

function setBackLeaves(leaves: boolean): void {
	if (typeof window !== 'undefined') window.__oaBackLeaves = leaves;
}

function syncBackLeaves(): void {
	const top = overlays.at(-1);
	setBackLeaves(!!top && top.consumeWhenBlocked === false && !top.canDismiss());
}

function onNativeBack(event: Event): void {
	const top = overlays.at(-1);
	if (!top) {
		setBackLeaves(false);
		return;
	}
	const canDismiss = top.canDismiss();
	const leaves = !canDismiss && top.consumeWhenBlocked === false;
	setBackLeaves(leaves);
	if (
		leaves &&
		!overlays
			.slice(0, -1)
			.some((overlay) => overlay.consumeWhenBlocked !== false && !overlay.canDismiss())
	) {
		return;
	}
	event.preventDefault();
	if (canDismiss) top.dismiss();
}

if (typeof window !== 'undefined') {
	syncBackLeaves();
	window.addEventListener(NATIVE_BACK_EVENT, onNativeBack);
}

/**
 * Lets Android Back close this overlay while it is open; returns the unregister function.
 * Outside the Android app nothing is registered (browser Back stays ordinary navigation).
 */
export function registerNativeBack(overlay: NativeBackOverlay): () => void {
	if (!isNativeAndroid()) return () => undefined;
	// Own entry, so registering the same callbacks twice keeps two independent stack slots.
	const entry: NativeBackOverlay = {
		canDismiss: overlay.canDismiss,
		dismiss: overlay.dismiss,
		get consumeWhenBlocked() {
			return overlay.consumeWhenBlocked;
		}
	};
	overlays.push(entry);
	syncBackLeaves();
	return () => {
		const index = overlays.indexOf(entry);
		if (index !== -1) overlays.splice(index, 1);
		syncBackLeaves();
	};
}

/** Attachment for native popovers: light dismiss, Escape and Back share the same open state. */
export function nativeBackPopover(node: HTMLElement): () => void {
	let releaseBack: (() => void) | undefined;
	const beforeToggle = (event: Event) => {
		if (!('newState' in event)) return;
		releaseBack?.();
		releaseBack =
			event.newState === 'open'
				? registerNativeBack({ canDismiss: () => true, dismiss: () => node.hidePopover() })
				: undefined;
	};
	node.addEventListener('beforetoggle', beforeToggle);
	return () => {
		node.removeEventListener('beforetoggle', beforeToggle);
		releaseBack?.();
	};
}
