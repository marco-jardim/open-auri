interface FloatingOptions {
	anchor?: () => HTMLElement | null;
	selector?: string;
	highlight?: boolean;
}

/** Fixed + top layer avoids overflow and transformed-ancestor clipping, without a backdrop. */
export function floating(node: HTMLElement, initial: FloatingOptions) {
	let options = initial;
	let highlighted: HTMLElement | null = null;
	let observedAnchor: HTMLElement | null = null;
	let frame = 0;
	const observer = new ResizeObserver(schedule);
	observer.observe(node);
	// No focus trap or inert backdrop: this is a non-modal manual popover.
	if (typeof node.showPopover === 'function') node.showPopover();

	function position() {
		const anchor = options.selector
			? document.querySelector<HTMLElement>(options.selector)
			: (options.anchor?.() ?? null);
		if (observedAnchor !== anchor) {
			if (observedAnchor) observer.unobserve(observedAnchor);
			observedAnchor = anchor;
			if (observedAnchor) observer.observe(observedAnchor);
		}
		const nextHighlight = options.highlight ? anchor : null;
		if (highlighted !== nextHighlight) {
			highlighted?.removeAttribute('data-tour-active');
			highlighted = nextHighlight;
			highlighted?.setAttribute('data-tour-active', '');
		}
		const rect = anchor?.getBoundingClientRect();
		const width = node.offsetWidth;
		const height = node.offsetHeight;
		const vw = document.documentElement.clientWidth;
		const vh = window.innerHeight;
		const visible = rect && rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
		let left = (vw - width) / 2;
		let top = (vh - height) / 2;
		if (visible) {
			left = rect.right + 12;
			top = rect.top;
			if (left + width > vw - 12) {
				left = rect.left;
				top = rect.bottom + 12;
				if (top + height > vh - 12) top = rect.top - height - 12;
			}
		}
		node.style.left = `${Math.max(12, Math.min(left, vw - width - 12))}px`;
		node.style.top = `${Math.max(12, Math.min(top, vh - height - 12))}px`;
	}

	function schedule() {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(position);
	}
	position();
	window.addEventListener('resize', schedule);
	window.addEventListener('scroll', schedule, true);
	window.visualViewport?.addEventListener('resize', schedule);
	return {
		update(next: FloatingOptions) {
			options = next;
			position();
		},
		destroy() {
			cancelAnimationFrame(frame);
			observer.disconnect();
			highlighted?.removeAttribute('data-tour-active');
			window.removeEventListener('resize', schedule);
			window.removeEventListener('scroll', schedule, true);
			window.visualViewport?.removeEventListener('resize', schedule);
		}
	};
}
