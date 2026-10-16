import { modalDialog } from '#lib/components/chrome/modal.ts';

type SearchModalOptions = Parameters<typeof modalDialog>[1] & {
	returnFocus: () => HTMLElement | null;
};

/** Keep shared trapping/dismissal, but restore the explicitly captured search origin. */
export function searchModal(node: HTMLDialogElement, options: SearchModalOptions) {
	let current = options;
	const modal = modalDialog(node, options);
	function restoreFocus() {
		if (node.open) return;
		const target = current.returnFocus();
		if (target?.isConnected) target.focus({ preventScroll: true });
	}
	// Native close processing may change focus after the action's synchronous update.
	// Run after the shared close handler, independently of document.hasFocus().
	node.addEventListener('close', restoreFocus);
	return {
		update(next: SearchModalOptions) {
			const closing = current.open && !next.open;
			current = next;
			modal.update(next);
			if (closing) restoreFocus();
		},
		destroy() {
			const wasOpen = node.open;
			node.removeEventListener('close', restoreFocus);
			modal.destroy();
			if (wasOpen) restoreFocus();
		}
	};
}
