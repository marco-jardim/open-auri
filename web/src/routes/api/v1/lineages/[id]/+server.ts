// GET /api/v1/lineages/[id]?cursor=&limit= (T4.2): version history of a readable lineage, newest
// first. 410 GONE for tombstones read by non-owners.
import { defineApi } from '#lib/server/api/index.ts';
import { loadLineageVersions, readResponse } from '#lib/server/social/curves.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const GET: RequestHandler = defineApi(
	{ auth: 'public', rateLimit: { group: 'api.lineages.read' } },
	async ({ event, env, user }) => {
		const params = new URL(event.request.url).searchParams;
		const limit = params.get('limit');
		const result = await loadLineageVersions(
			env.db,
			event.params.id ?? '',
			{ userId: user?.id ?? null },
			{ cursor: params.get('cursor'), ...(limit === null ? {} : { limit: Number(limit) }) }
		);
		return readResponse(event.request, result, user === null);
	}
);
