import type { Attachment } from 'svelte/attachments';

/**
 * Decorative art layers (FUX.ART) only animate while they can be seen: the attachment sets
 * `data-art="paused"` when the layer leaves the viewport or the tab is hidden, and
 * `data-art="running"` otherwise. CSS pauses every animation under `[data-art='paused']`.
 * It also sets `data-art-seen` the first time the layer enters the viewport, for one-shot
 * entrance reveals. Under `prefers-reduced-motion: reduce` the CSS turns animations off.
 */
export const artVisibility: Attachment<HTMLElement> = (node) => {
	let inView = false;
	const apply = () => {
		node.dataset.art = inView && document.visibilityState === 'visible' ? 'running' : 'paused';
	};
	node.dataset.art = 'paused';
	if (typeof IntersectionObserver !== 'function') {
		inView = true;
		node.dataset.artSeen = '';
		apply();
		return;
	}
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				inView = entry.isIntersecting;
				if (inView) node.dataset.artSeen = '';
			}
			apply();
		},
		{ rootMargin: '120px 0px' }
	);
	observer.observe(node);
	document.addEventListener('visibilitychange', apply);
	return () => {
		observer.disconnect();
		document.removeEventListener('visibilitychange', apply);
	};
};
