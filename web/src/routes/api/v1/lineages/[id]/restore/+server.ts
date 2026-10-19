// POST /api/v1/lineages/[id]/restore (T4.2): owner undoes the tombstone; moderation is untouched.
// Optional JSON body `{ acknowledge?: 'yolo' }`: restoring a non-private lineage whose head is YOLO
// needs it (docs/api.md). Without a content-type the request has no body (the former contract).
import { defineApi, json, readJson } from '#lib/server/api/index.ts';
import { RestoreBodySchema, restoreCurve } from '#lib/server/social/curves.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const POST: RequestHandler = defineApi(
	{ auth: 'verified', rateLimit: { group: 'api.lineages.write' } },
	async ({ event, env, user }) => {
		const body: { acknowledge?: 'yolo' | undefined } = event.request.headers.has('content-type')
			? await readJson(event.request, RestoreBodySchema)
			: {};
		return json(
			await restoreCurve(
				env.db,
				user.id,
				event.params.id ?? '',
				{ yoloPublication: env.yoloPublication },
				body.acknowledge
			)
		);
	}
);
