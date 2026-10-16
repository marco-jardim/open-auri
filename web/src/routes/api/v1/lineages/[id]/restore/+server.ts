// POST /api/v1/lineages/[id]/restore (T4.2): owner undoes the tombstone; moderation is untouched.
import { defineApi, json } from '#lib/server/api/index.ts';
import { restoreCurve } from '#lib/server/social/curves.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const POST: RequestHandler = defineApi(
	{ auth: 'verified', rateLimit: { group: 'api.lineages.write' } },
	async ({ event, env, user }) => json(await restoreCurve(env.db, user.id, event.params.id ?? ''))
);
