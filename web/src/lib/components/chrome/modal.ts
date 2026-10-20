import { nativeModalHistory } from './native-modal-history.ts';

interface ModalOptions {
	open: boolean;
	onDismiss: () => void;
	initialFocus?: string;
	/** Rechecked at the close request, not just when props last updated (e.g. USB writing). */
	canDismiss?: () => boolean;
}

/** Native modal semantics, with deterministic tab wrapping and focus restoration. */
export function modalDialog(node: HTMLDialogElement, options: ModalOptions) {
	let current = options;
	let previousFocus: HTMLElement | null = null;
	let releaseHistory: (() => void) | undefined;
	const canDismiss = () => current.canDismiss?.() ?? true;

	function focusInitial() {
		if (current.initialFocus) node.querySelector<HTMLElement>(current.initialFocus)?.focus();
	}

	function clearHistory() {
		releaseHistory?.();
		releaseHistory = undefined;
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
		if (current.open && !releaseHistory) {
			releaseHistory = nativeModalHistory({ canDismiss, dismiss: () => current.onDismiss() });
		} else if (!current.open) {
			clearHistory();
		}
	}

	function cancel(event: Event) {
		event.preventDefault();
		if (canDismiss()) current.onDismiss();
	}

	function close() {
		if (!node.open) {
			// Chromium can close after repeated Esc/Back without a cancelable cancel event.
			// Keep the page inert and the history fence until the close guard permits dismissal.
			if (current.open && !canDismiss()) {
				queueMicrotask(() => {
					if (current.open && node.isConnected && !node.open) {
						node.showModal();
						focusInitial();
					}
				});
				return;
			}
			clearHistory();
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
			clearHistory();
			if (node.open) node.close();
			restoreFocus();
		}
	};
}
