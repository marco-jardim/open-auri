import { isNativeAndroid } from '#lib/cable/native/gate.ts';

/**
 * Dispatched on `window` by the Android app's MainActivity on every system Back press, as
 * `!window.dispatchEvent(new CustomEvent('oa:native-back', { cancelable: true }))`. A canceled
 * event (`preventDefault()`) means the page consumed Back; otherwise the app goes back in the
 * WebView's history, or leaves when there is none.
 */
export const NATIVE_BACK_EVENT = 'oa:native-back';

export interface NativeBackOverlay {
	/** Rechecked on each Back press (e.g. a write in progress, an unacknowledged notice). */
	canDismiss: () => boolean;
	dismiss: () => void;
	/** Defaults to true. A mandatory notice may let Back leave without acknowledging it. */
	consumeWhenBlocked?: boolean;
}

/** Open overlays, in opening order: the last one is the topmost. */
const overlays: NativeBackOverlay[] = [];

function onNativeBack(event: Event): void {
	const top = overlays.at(-1);
	if (!top) return;
	// Only the topmost overlay answers. Busy writes keep Back; a mandatory notice may let
	// the app leave without dismissing or acknowledging it (nor reaching an overlay below).
	const canDismiss = top.canDismiss();
	if (!canDismiss && top.consumeWhenBlocked === false) return;
	event.preventDefault();
	if (canDismiss) top.dismiss();
}

if (typeof window !== 'undefined') window.addEventListener(NATIVE_BACK_EVENT, onNativeBack);

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
	return () => {
		const index = overlays.indexOf(entry);
		if (index !== -1) overlays.splice(index, 1);
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
