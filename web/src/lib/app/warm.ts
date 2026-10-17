// Warm-up helpers for page tasks (FUX.2, spec §5.4 W4). They only fetch code into the HTTP cache
// (the service worker precaches the same immutable files for offline use); they never create a
// worker, start a calculation or touch the cable. Call them from idle callbacks or intent events
// (hover, focus), e.g. `whenIdle(() => void warmGateWorker())` after the first paint.

const prefetched = new Set<string>();

/**
 * Adds `<link rel="prefetch">` for `url` once per page. Low priority by design: the browser
 * fetches it when the network is free, so it never competes with the route's own requests.
 * Returns false where there is no document (SSR) or when the URL was already requested.
 */
export function prefetchUrl(url: string): boolean {
	if (typeof document === 'undefined' || prefetched.has(url)) return false;
	prefetched.add(url);
	const link = document.createElement('link');
	link.rel = 'prefetch';
	link.href = url;
	link.dataset.warm = '';
	document.head.append(link);
	return true;
}

async function warm(load: () => Promise<{ default: string }>): Promise<string | null> {
	if (typeof document === 'undefined') return null;
	const { default: url } = await load();
	prefetchUrl(url);
	return url;
}

/**
 * W4: prefetches the gate worker bundle (Curva, Soe como X, Comparar: on idle after the first
 * paint). Resolves with the worker URL (null in SSR); rejects only if its URL chunk cannot load.
 */
export function warmGateWorker(): Promise<string | null> {
	return warm(() => import('#lib/workers/gate.worker.ts?worker&url'));
}

/** W4: prefetches the solver worker bundle (Soe como X: when the search field gets focus). */
export function warmSolverWorker(): Promise<string | null> {
	return warm(() => import('#lib/workers/solver.worker.ts?worker&url'));
}
