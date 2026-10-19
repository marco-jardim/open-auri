// Handler of the public route /og/[id].png (T4.7), kept here so tests can call it with a narrow
// event and an injected renderer. 404 for anything not linkable (private included); 200 with
// `public, max-age=86400` and a strong ETag (304 on If-None-Match). Not `immutable` (FX4.3):
// visibility is re-checked on every request, and a one-day lifetime bounds how long browsers and
// CDNs keep serving a copy after the curve turns private. Only cache
// misses render (~30 ms of CPU): they are rate limited per IP hash (or user) per minute through the
// API kit (group `og`, RL_API binding), and only ids of linkable versions ever reach the renderer.
// While YOLO_PUBLICATION is off a YOLO version is not linkable: 404.
//
// Card class in the URL (`?y=1` = the YOLO card, `/c/:id` meta tags add it): when it does not
// name the version's current class (a standard version asked with `?y=1`, a YOLO one without it),
// the answer is a 302 to the URL of the right class with `cache-control: no-store`, before any R2
// read or render. So a URL-keyed cache (browser, CDN, a social crawler) only ever holds the card of
// the class its URL names: nobody can prime one URL with the other class's card.
import { ifNoneMatch } from '#lib/server/api/cache.ts';
import { ApiError, apiErrorFrom } from '#lib/server/api/errors.ts';
import { apiRateLimit } from '#lib/server/api/limits.ts';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { getServerEnv } from '#lib/server/env.ts';
import type { OgAssets } from './render.ts';
import {
	getOrCreateOg,
	OG_CACHE_CONTROL,
	OG_CONTENT_TYPE,
	type OgContext,
	type OgDeps
} from './store.ts';

export const OG_RATE_GROUP = 'og';

export interface OgEvent {
	request: Request;
	params: { id?: string };
	locals: AuthLocals;
	platform?: { env: unknown; ctx?: OgContext } | undefined;
}

function isAssets(value: unknown): value is OgAssets {
	return (
		typeof value === 'object' && value !== null && typeof Reflect.get(value, 'fetch') === 'function'
	);
}

function assetsOf(env: unknown): OgAssets | null {
	if (typeof env !== 'object' || env === null) return null;
	const assets: unknown = Reflect.get(env, 'ASSETS');
	return isAssets(assets) ? assets : null;
}

function notFound(): Response {
	return new Response('Not found', {
		status: 404,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});
}

/** Card class named by the request URL: `?y=1` is the YOLO card, anything else the standard one. */
export function requestedYolo(url: URL): boolean {
	return url.searchParams.get('y') === '1';
}

/**
 * 302 to the image URL of the class `yolo`, never cached: the same URL with `y` alone set to `1`
 * (YOLO) or removed (standard). Every other query parameter is kept as is, in order.
 */
function toClassUrl(url: URL, yolo: boolean): Response {
	const target = new URL(url);
	target.hash = '';
	if (yolo) target.searchParams.set('y', '1');
	else target.searchParams.delete('y');
	// No parameter left: no bare `?` either.
	if (target.search === '?') target.search = '';
	return new Response(null, {
		status: 302,
		headers: { location: target.toString(), 'cache-control': 'no-store' }
	});
}

export async function ogResponse(
	event: OgEvent,
	deps: Pick<OgDeps, 'render'> = {}
): Promise<Response> {
	const env = getServerEnv(event.platform);
	const ctx: OgContext = event.platform?.ctx ?? {
		// No execution context (never in production): keep the write running unobserved; its
		// failure is already logged by the store.
		waitUntil: (promise) => void promise
	};
	const url = new URL(event.request.url);
	let result: Awaited<ReturnType<typeof getOrCreateOg>>;
	try {
		result = await getOrCreateOg(
			{
				db: env.db,
				media: env.media,
				publicOrigin: env.publicOrigin,
				assets: assetsOf(event.platform?.env),
				yoloPublication: env.yoloPublication
			},
			ctx,
			event.params.id ?? '',
			{
				...deps,
				yolo: requestedYolo(url),
				beforeRender: () =>
					apiRateLimit(
						env,
						{ request: event.request, locals: event.locals },
						{ group: OG_RATE_GROUP, kind: 'read' }
					)
			}
		);
	} catch (error) {
		if (error instanceof ApiError) return apiErrorFrom(error);
		throw error;
	}
	if (!result.ok)
		return result.code === 'class-mismatch' ? toClassUrl(url, result.yolo) : notFound();

	const headers = new Headers({ etag: result.etag, 'cache-control': OG_CACHE_CONTROL });
	if (ifNoneMatch(event.request, result.etag)) return new Response(null, { status: 304, headers });
	headers.set('content-type', OG_CONTENT_TYPE);
	return new Response(event.request.method === 'HEAD' ? null : result.body, {
		status: 200,
		headers
	});
}
