// POST /api/v1/lineages/[id]/fork (T4.2): verified users fork a version they can read into a new
// lineage (private by default). Body: `{ versionId?, visibility?, envelope? }` (`{}` copies the
// head). A public or unlisted fork warms its OG image in the background (T4.12, `waitUntil`).
import { defineApi, json, readJson } from '#lib/server/api/index.ts';
import { scheduleOgWarm } from '#lib/server/og/warm.ts';
import {
	CURVE_BODY_MAX_BYTES,
	ForkBodySchema,
	forkCurve,
	type CurveDeps
} from '#lib/server/social/curves.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const POST: RequestHandler = defineApi(
	{ auth: 'verified', rateLimit: { group: 'api.lineages.write' } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, ForkBodySchema, {
			maxBytes: CURVE_BODY_MAX_BYTES
		});
		const deps: CurveDeps =
			(body.visibility ?? 'private') === 'private'
				? {}
				: { onPublished: (info) => void scheduleOgWarm(event, info) };
		const forked = await forkCurve(env.db, user.id, event.params.id ?? '', body, {
			...deps,
			metrics: env.metrics
		});
		return json(forked, { status: 201 });
	}
);
