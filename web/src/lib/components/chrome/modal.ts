import { registerNativeBack } from './native-back.ts';

interface ModalOptions {
	open: boolean;
	onDismiss: () => void;
	initialFocus?: string;
	/** Rechecked at the close request, not just when props last updated (e.g. USB writing). */
	canDismiss?: () => boolean;
	/** Let Back leave an unacknowledged notice, but keep busy operations consuming it. */
	consumeWhenBlocked?: boolean;
}

/** Native modal semantics, with deterministic tab wrapping and focus restoration. */
export function modalDialog(node: HTMLDialogElement, options: ModalOptions) {
	let current = options;
	let previousFocus: HTMLElement | null = null;
	let releaseBack: (() => void) | undefined;
	const canDismiss = () => current.canDismiss?.() ?? true;

	function focusInitial() {
		if (current.initialFocus) node.querySelector<HTMLElement>(current.initialFocus)?.focus();
	}

	function clearBack() {
		releaseBack?.();
		releaseBack = undefined;
	}

	function restoreFocus() {
		if (previousFocus?.isConnected) previousFocus.focus();
		previousFocus = null;
	}

	function sync() {
		if (current.open && !node.open) {
			previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			node.showModal();
			focusInitial();
		} else if (!current.open && node.open) {
			node.close();
			restoreFocus();
		}
		// Android app: system Back closes the topmost open modal, like Escape (native-back.ts).
		if (current.open && !releaseBack) {
			releaseBack = registerNativeBack({
				canDismiss,
				dismiss: () => current.onDismiss(),
				get consumeWhenBlocked() {
					return current.consumeWhenBlocked;
				}
			});
		} else if (!current.open) {
			clearBack();
		}
	}

	function cancel(event: Event) {
		event.preventDefault();
		if (canDismiss()) current.onDismiss();
	}

	function close() {
		if (!node.open) {
			// Chromium can close after repeated Esc without a cancelable cancel event. Keep the
			// page inert and the Back registration until the close guard permits dismissal.
			if (current.open && !canDismiss()) {
				queueMicrotask(() => {
					if (current.open && node.isConnected && !node.open) {
						node.showModal();
						focusInitial();
					}
				});
				return;
			}
			clearBack();
			restoreFocus();
			if (current.open) current.onDismiss();
		}
	}

	function trapTab(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		const candidates = node.querySelectorAll<HTMLElement>(
			'a[href], button, input, select, textarea, [tabindex]'
		);
		const focusable = [...candidates].filter(
			(element) =>
				element.tabIndex >= 0 &&
				!element.matches(':disabled') &&
				!element.closest('[inert]') &&
				element.getClientRects().length > 0
		);
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) {
			event.preventDefault();
			return;
		}
		if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
			event.preventDefault();
			last.focus();
		} else if (
			!event.shiftKey &&
			(document.activeElement === last || document.activeElement === node)
		) {
			event.preventDefault();
			first.focus();
		}
	}

	node.addEventListener('cancel', cancel);
	node.addEventListener('close', close);
	node.addEventListener('keydown', trapTab);
	sync();

	return {
		update(next: ModalOptions) {
			current = next;
			sync();
		},
		destroy() {
			node.removeEventListener('cancel', cancel);
			node.removeEventListener('close', close);
			node.removeEventListener('keydown', trapTab);
			clearBack();
			if (node.open) node.close();
			restoreFocus();
		}
	};
}
