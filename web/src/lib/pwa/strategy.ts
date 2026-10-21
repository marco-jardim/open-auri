/** Pure policy shared by the worker and unit tests. All caches belong to this app only. */
export const CACHE_PREFIX = 'open-auri-pwa-';
export const AUTOEQ_MAX_ENTRIES = 32;
export const API_MAX_ENTRIES = 32;
export const SKIP_WAITING = 'OA_SKIP_WAITING';

export function cacheNames(version: string) {
	return {
		precache: `${CACHE_PREFIX}shell-${version}`,
		api: `${CACHE_PREFIX}api-${version}`,
		autoeq: `${CACHE_PREFIX}autoeq-${version}`
	};
}

export function obsoleteCaches(names: readonly string[], version: string): string[] {
	const current = new Set(Object.values(cacheNames(version)));
	return names.filter((name) => name.startsWith(CACHE_PREFIX) && !current.has(name));
}

/** Kit 3 manifest paths are relative to the configured base, not to the origin. */
export function manifestUrl(path: string, scope: string): string {
	return new URL(path.replace(/^\/+/, ''), scope).href;
}

export function scopedPath(url: URL, scope: string): string | null {
	const base = new URL(scope);
	if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
	return `/${url.pathname.slice(base.pathname.length)}`;
}

export function isApi(path: string): boolean {
	return path === '/api' || path.startsWith('/api/');
}

export function isAutoEq(path: string): boolean {
	return path.startsWith('/data/autoeq/');
}

/** Preview recordings are fetched only when selected, never as part of the app shell. */
export function isPreviewAudio(path: string): boolean {
	return path.startsWith('/audio/preview/') && /\.mp3$/i.test(path);
}

export function isPrivatePath(path: string): boolean {
	return /^\/(?:auth|account|profile|admin|login|logout)(?:\/|$)/.test(path);
}

export function precacheUrls(entries: ReadonlyArray<{ path: string }>, scope: string): string[] {
	return [...new Set(entries.map(({ path }) => manifestUrl(path, scope)))].filter((href) => {
		const path = scopedPath(new URL(href), scope);
		return (
			path !== null &&
			!isApi(path) &&
			!isAutoEq(path) &&
			!isPreviewAudio(path) &&
			!isPrivatePath(path) &&
			// The native write freshness check must always reach the live deploy (Q2 m3).
			path !== '/_app/version.json'
		);
	});
}

export type Strategy =
	'network-only' | 'api-network-first' | 'autoeq-cache-first' | 'navigation' | 'precache';

export function requestStrategy(
	request: Pick<Request, 'method' | 'url' | 'headers' | 'mode'>,
	scope: string,
	precache: ReadonlySet<string>
): Strategy {
	const url = new URL(request.url);
	const path = scopedPath(url, scope);
	if (
		request.method !== 'GET' ||
		path === null ||
		request.headers.has('authorization') ||
		request.headers.has('cookie') ||
		request.headers.has('range') ||
		isPrivatePath(path)
	) {
		return 'network-only';
	}
	if (isApi(path)) return 'api-network-first';
	if (isAutoEq(path)) return 'autoeq-cache-first';
	if (request.mode === 'navigate') return 'navigation';
	if (precache.has(url.href)) return 'precache';
	return 'network-only';
}

/** HttpOnly cookies are not visible here: only credentials: omit is provably anonymous. */
export function isAnonymous(request: Pick<Request, 'method' | 'credentials' | 'headers'>): boolean {
	return (
		request.method === 'GET' &&
		request.credentials === 'omit' &&
		!request.headers.has('authorization') &&
		!request.headers.has('cookie')
	);
}

export function canStorePublicResponse(response: Response, requirePublic = false): boolean {
	const control = response.headers.get('cache-control') ?? '';
	const vary = response.headers.get('vary') ?? '';
	return (
		response.status === 200 &&
		!response.redirected &&
		response.type !== 'opaque' &&
		!response.headers.has('set-cookie') &&
		!/(?:^|,)\s*(?:private|no-store)\b/i.test(control) &&
		!/(?:^|,)\s*(?:cookie|authorization|\*)\s*(?:,|$)/i.test(vary) &&
		(!requirePublic ||
			(/(?:^|,)\s*public\s*(?:,|$)/i.test(control) && !/(?:^|,)\s*no-cache\b/i.test(control)))
	);
}

/** CacheStorage iteration order is insertion order, so eviction is deterministic FIFO. */
export function evictionCount(size: number, limit: number): number {
	return Math.max(0, size - Math.max(0, limit));
}

export function mayApplyUpdate(writeInProgress: boolean | undefined): boolean {
	return writeInProgress !== true;
}
