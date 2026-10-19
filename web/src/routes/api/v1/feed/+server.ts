// GET /api/v1/feed?sort=new|favorites|installs&window=7d|30d|all&cursor=&limit=&yolo=only (T4.6).
// Public: `new` lists the newest publicly listable lineages, the ranked sorts read the materialized
// rankings of `window`. Private and unlisted lineages never appear, nor YOLO heads; `yolo=only`
// (with `sort=new` only, 400 otherwise) lists the public YOLO lineages instead, and only while
// YOLO_PUBLICATION is on: while off it is a 200 with an empty page. 60 s public cache, ETag/304.
import { CACHE_PUBLIC_60, cached, defineApi, type ApiEvent } from '#lib/server/api/index.ts';
import { parseFeedQuery, rankingsApiError, readFeed } from '#lib/server/social/rankings.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const GET = defineApi<ApiEvent>(
	{ auth: 'public', rateLimit: { group: 'api.feed.read' } },
	async ({ event, env }) => {
		const request = parseFeedQuery(new URL(event.request.url));
		try {
			const page = await readFeed(env.db, request, env.yoloPublication);
			return await cached(event.request, JSON.stringify(page), { cacheControl: CACHE_PUBLIC_60 });
		} catch (error) {
			throw rankingsApiError(error);
		}
	}
) satisfies RequestHandler;
