import type { Action } from 'svelte/action';

export type TraceState = 'armed' | 'run' | 'done';

const reducedMotion = () =>
	typeof window.matchMedia === 'function' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Figures trace in once, the first time they enter the viewport (spec §3, Docs). The plot
 * itself is the real curve or payload; only its reveal is animated. A figure that is already
 * visible on mount stays drawn (no flash after hydration, the top of the page is unchanged),
 * and nothing is armed under reduced motion. State lives in `data-trace`; the CSS is in
 * DocsPage (`[data-trace]`).
 */
export const traceOnce: Action<HTMLElement> = (node) => {
	if (typeof IntersectionObserver === 'undefined' || reducedMotion()) return;
	const rect = node.getBoundingClientRect();
	if (rect.bottom > 0 && rect.top < window.innerHeight) return;
	node.dataset.trace = 'armed' satisfies TraceState;
	const finish = () => {
		node.dataset.trace = 'done' satisfies TraceState;
	};
	const observer = new IntersectionObserver(
		(entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			if (reducedMotion()) return finish();
			node.addEventListener('animationend', finish, { once: true });
			node.dataset.trace = 'run' satisfies TraceState;
		},
		{ root: document, threshold: 0.2 }
	);
	observer.observe(node);
	return {
		destroy() {
			observer.disconnect();
			node.removeEventListener('animationend', finish);
		}
	};
};
