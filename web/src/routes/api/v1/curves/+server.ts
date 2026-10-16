// POST /api/v1/curves (T4.2): publishes an S5 envelope as a new lineage (verified users).
import { defineApi, json, readJson } from '#lib/server/api/index.ts';
import {
	CURVE_BODY_MAX_BYTES,
	PublishBodySchema,
	publishCurve
} from '#lib/server/social/curves.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const POST: RequestHandler = defineApi(
	{ auth: 'verified', rateLimit: { group: 'api.curves.write' } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, PublishBodySchema, {
			maxBytes: CURVE_BODY_MAX_BYTES
		});
		const published = await publishCurve(env.db, user.id, body);
		return json(published, { status: 201 });
	}
);
