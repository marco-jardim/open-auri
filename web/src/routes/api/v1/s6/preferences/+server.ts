// GET /api/v1/s6/preferences: the "Comunidade prefere" JSON (T4.9), written daily to R2 MEDIA by
// the s6-aggregate job. Public, CACHE_PUBLIC_60 with a strong ETag; 404 before the first run.
import { ApiError, CACHE_PUBLIC_60, cached, defineApi } from '#lib/server/api/index.ts';
import { S6_PREFERENCES_KEY } from '#lib/server/social/s6.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const GET: RequestHandler = defineApi(
	{ auth: 'public', rateLimit: { group: 'api.s6.read' } },
	async ({ event, env }) => {
		const object = await env.media.get(S6_PREFERENCES_KEY);
		if (!object) throw new ApiError(404, 'NOT_FOUND');
		const body = await object.text();
		return cached(event.request, body, {
			cacheControl: CACHE_PUBLIC_60,
			contentType: 'application/json; charset=utf-8'
		});
	}
);
