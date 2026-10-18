/**
 * KindDial pauses its pending countdown while a mouse is over the dial or its legend
 * (`pointerenter`/`pointerleave` with a mouse pointer). The browser runner shares one real
 * Playwright mouse across test files: wherever an earlier file left it (a `.hover()` or a locator
 * `.click()`), Chromium sends a trusted `pointerenter` to a dial or a legend that is later laid out
 * under it, and nothing ever sends the matching leave. The countdown then stays paused, which is
 * the correct behaviour for a real pointer but makes timing tests depend on what ran before.
 *
 * Tests that drive hover themselves (dispatched, untrusted events) install this guard: trusted
 * pointer and mouse boundary events are stopped at the window in the capture phase, before they
 * reach any element. Dispatched events and focus are untouched. Returns the uninstaller.
 */
const BOUNDARY_EVENTS = [
	'pointerenter',
	'pointerleave',
	'pointerover',
	'pointerout',
	'mouseenter',
	'mouseleave',
	'mouseover',
	'mouseout'
] as const;

export function blockRealPointerHover(): () => void {
	const stop = (event: Event) => {
		if (event.isTrusted) event.stopImmediatePropagation();
	};
	for (const type of BOUNDARY_EVENTS) window.addEventListener(type, stop, true);
	return () => {
		for (const type of BOUNDARY_EVENTS) window.removeEventListener(type, stop, true);
	};
}
