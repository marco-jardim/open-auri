// Handler of the public route /og/[id].png (T4.7), kept here so tests can call it with a narrow
// event and an injected renderer. 404 for anything not linkable (private included); 200 with
// `public, max-age=86400` and a strong ETag (304 on If-None-Match). Not `immutable` (FX4.3):
// visibility is re-checked on every request, and a one-day lifetime bounds how long browsers and
// CDNs keep serving a copy after the curve turns private. Only cache
// misses render (~30 ms of CPU): they are rate limited per IP hash (or user) per minute through the
// API kit (group `og`, RL_API binding), and only ids of linkable versions ever reach the renderer.
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
	let result: Awaited<ReturnType<typeof getOrCreateOg>>;
	try {
		result = await getOrCreateOg(
			{
				db: env.db,
				media: env.media,
				publicOrigin: env.publicOrigin,
				assets: assetsOf(event.platform?.env)
			},
			ctx,
			event.params.id ?? '',
			{
				...deps,
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
	if (!result.ok) return notFound();

	const headers = new Headers({ etag: result.etag, 'cache-control': OG_CACHE_CONTROL });
	if (ifNoneMatch(event.request, result.etag)) return new Response(null, { status: 304, headers });
	headers.set('content-type', OG_CONTENT_TYPE);
	return new Response(event.request.method === 'HEAD' ? null : result.body, {
		status: 200,
		headers
	});
}
