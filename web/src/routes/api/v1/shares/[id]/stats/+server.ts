// GET /api/v1/shares/[id]/stats (T4.5): funnel of a share for its owner only (anonymous daily
// opens and counts of attributed previews, installs and favorites). Anyone else gets 404.
import { defineApi, json, type ApiEvent } from '#lib/server/api/index.ts';
import { shareStatsFor } from '#lib/server/social/shares.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

type ShareEvent = ApiEvent & { params: { id: string } };

export const GET: RequestHandler = defineApi<ShareEvent>(
	{ auth: 'user', rateLimit: { group: 'api.shares.stats' } },
	async ({ event, env, user }) => json(await shareStatsFor(env.db, user.id, event.params.id))
);
