// POST /api/v1/curves (T4.2): publishes an S5 envelope as a new lineage (verified users). A public
// or unlisted publication warms its OG image in the background (T4.12, `waitUntil`).
import { defineApi, json, readJson } from '#lib/server/api/index.ts';
import { scheduleOgWarm } from '#lib/server/og/warm.ts';
import {
	CURVE_BODY_MAX_BYTES,
	PublishBodySchema,
	publishCurve,
	type CurveDeps
} from '#lib/server/social/curves.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const POST: RequestHandler = defineApi(
	{ auth: 'verified', rateLimit: { group: 'api.curves.write' } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, PublishBodySchema, {
			maxBytes: CURVE_BODY_MAX_BYTES
		});
		const deps: CurveDeps =
			body.visibility === 'private'
				? {}
				: { onPublished: (info) => void scheduleOgWarm(event, info) };
		const published = await publishCurve(env.db, user.id, body, deps);
		return json(published, { status: 201 });
	}
);
