// Page-side scheduling of the Soe como X warm-ups (spec docs/plans/fux-spec.md §5.4 W4 and W5).
// The bundles themselves are warmed by FUX.2's shared helpers in `#lib/app/warm.ts`
// (`warmGateWorker`, `warmSolverWorker`): they only prefetch code, never create a worker or
// start a calculation.
import { warmGateWorker, warmSolverWorker } from '#lib/app/warm.ts';

/**
 * W5: the AutoEq index measured 129 kB gzip (under the 150 kB limit), so it loads on page idle;
 * a search field getting focus loads it at once. Above 150 kB this would be false: focus only.
 */
export const AUTOEQ_INDEX_ON_IDLE = true;
/** requestIdleCallback timeout of the idle warm-ups (spec §5.4 W2). */
export const IDLE_TIMEOUT_MS = 1500;

/**
 * Runs `task` once the browser is idle (or after `timeout`); returns a cancel function.
 * Local on purpose: `whenIdle` lives in `#lib/app/runtime.ts`, and this page must not pull the
 * runtime module just to schedule a prefetch (it renders with `client === null`).
 */
export function onIdle(task: () => void, timeout = IDLE_TIMEOUT_MS): () => void {
	if (typeof window === 'undefined') return () => undefined;
	if (typeof window.requestIdleCallback === 'function') {
		const handle = window.requestIdleCallback(task, { timeout });
		return () => window.cancelIdleCallback(handle);
	}
	const handle = window.setTimeout(task, Math.min(timeout, 300));
	return () => window.clearTimeout(handle);
}

/** The warm-ups the page triggers; injectable so tests can observe them. */
export interface PageWarmers {
	/** W4: on idle after the first paint. */
	gate: () => Promise<unknown>;
	/** W4: when a search field gets focus. */
	solver: () => Promise<unknown>;
}
export const sharedWarmers: PageWarmers = { gate: warmGateWorker, solver: warmSolverWorker };

/** Fires a warm-up; a failed prefetch only costs the cache hit, so it is logged, not thrown. */
export function fire(warm: () => Promise<unknown>, what: string): void {
	warm().catch((cause: unknown) => {
		console.warn(`Soe como X ${what} warm-up unavailable`, cause);
	});
}
