// POST /api/v1/shares/[id]/open (T4.5): public, no auth. Increments only the anonymous daily
// aggregate of the share; nothing identifying is stored. Rate limited by the kit (daily-salted IP
// hash when signed out), with the same rule as the page load of `/c/[id]`.
import { ApiError, defineApi, type ApiEvent } from '#lib/server/api/index.ts';
import { OPEN_DAILY_QUOTA, OPEN_RATE_GROUP, recordShareOpen } from '#lib/server/social/shares.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

type ShareEvent = ApiEvent & { params: { id: string } };

export const POST: RequestHandler = defineApi<ShareEvent>(
	{
		auth: 'public',
		rateLimit: { group: OPEN_RATE_GROUP, kind: 'write', quotas: [{ limit: OPEN_DAILY_QUOTA }] }
	},
	async ({ event, env }) => {
		const counted = await recordShareOpen(env.db, event.params.id);
		if (!counted) throw new ApiError(404, 'NOT_FOUND');
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	}
);
