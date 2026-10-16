// GET /api/v1/curves/[id]?v=<versionId> (T4.2): a lineage (by id) with its head or requested
// version, as the viewer may read it. 410 GONE for tombstones read by non-owners.
import { defineApi } from '#lib/server/api/index.ts';
import { loadPublishedCurve, readResponse } from '#lib/server/social/curves.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const GET: RequestHandler = defineApi(
	{ auth: 'public', rateLimit: { group: 'api.curves.read' } },
	async ({ event, env, user }) => {
		const versionId = new URL(event.request.url).searchParams.get('v');
		const result = await loadPublishedCurve(
			env.db,
			event.params.id ?? '',
			{ userId: user?.id ?? null },
			versionId
		);
		return readResponse(event.request, result, user === null);
	}
);
