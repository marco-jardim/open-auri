// POST /api/v1/lineages/[id]/retract (T4.2): owner tombstone. Any signed-in owner may withdraw
// (no e-mail verification needed to take content down).
import { defineApi, json } from '#lib/server/api/index.ts';
import { retractCurve } from '#lib/server/social/curves.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const POST: RequestHandler = defineApi(
	{ auth: 'user', rateLimit: { group: 'api.lineages.write' } },
	async ({ event, env, user }) => json(await retractCurve(env.db, user.id, event.params.id ?? ''))
);
