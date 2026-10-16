// POST /api/v1/lineages/[id]/fork (T4.2): verified users fork a version they can read into a new
// lineage (private by default). Body: `{ versionId?, visibility?, envelope? }` (`{}` copies the
// head).
import { defineApi, json, readJson } from '#lib/server/api/index.ts';
import { CURVE_BODY_MAX_BYTES, ForkBodySchema, forkCurve } from '#lib/server/social/curves.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const POST: RequestHandler = defineApi(
	{ auth: 'verified', rateLimit: { group: 'api.lineages.write' } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, ForkBodySchema, {
			maxBytes: CURVE_BODY_MAX_BYTES
		});
		const forked = await forkCurve(env.db, user.id, event.params.id ?? '', body);
		return json(forked, { status: 201 });
	}
);
