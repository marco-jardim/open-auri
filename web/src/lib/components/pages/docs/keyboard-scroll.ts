/**
 * A named scroll region needs a keyboard stop only while content overflows.
 * Keep the native region semantics; it is not a button or an application widget.
 */
export function keyboardScroll(node: HTMLElement) {
	const update = () => {
		node.tabIndex =
			node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight ? 0 : -1;
	};
	const observer = new ResizeObserver(update);
	observer.observe(node);
	for (const child of node.children) observer.observe(child);
	update();
	return { destroy: () => observer.disconnect() };
}
