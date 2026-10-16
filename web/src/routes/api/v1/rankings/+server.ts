// GET /api/v1/rankings?metric=favorites|installs&window=7d|30d|all&cursor=&limit= (T4.6).
// Public, materialized by the jobs Worker every 15 minutes; 60 s public cache with ETag/304.
import { CACHE_PUBLIC_60, cached, defineApi, type ApiEvent } from '#lib/server/api/index.ts';
import { parseRankingsQuery, rankingsApiError, readRankings } from '#lib/server/social/rankings.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const GET = defineApi<ApiEvent>(
	{ auth: 'public', rateLimit: { group: 'api.rankings.read' } },
	async ({ event, env }) => {
		const query = parseRankingsQuery(new URL(event.request.url));
		try {
			const page = await readRankings(env.db, query.metric, query.window, query.page);
			return await cached(event.request, JSON.stringify(page), { cacheControl: CACHE_PUBLIC_60 });
		} catch (error) {
			throw rankingsApiError(error);
		}
	}
) satisfies RequestHandler;
