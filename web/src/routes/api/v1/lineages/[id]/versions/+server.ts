// POST /api/v1/lineages/[id]/versions (T4.2): owner appends a version; `parentVersionId` must be
// the current head (409 HEAD_MOVED otherwise). The new version's OG image is warmed in the
// background (T4.12, `waitUntil`); the lineage's visibility is not known here without another
// query, and the warm-up itself refuses private versions (anonymous viewer) before rendering.
import { defineApi, json, readJson } from '#lib/server/api/index.ts';
import { scheduleOgWarm } from '#lib/server/og/warm.ts';
import {
	AppendBodySchema,
	appendCurveVersion,
	CURVE_BODY_MAX_BYTES
} from '#lib/server/social/curves.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const POST: RequestHandler = defineApi(
	{ auth: 'verified', rateLimit: { group: 'api.lineages.write' } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, AppendBodySchema, {
			maxBytes: CURVE_BODY_MAX_BYTES
		});
		const appended = await appendCurveVersion(env.db, user.id, event.params.id ?? '', body, {
			metrics: env.metrics,
			onPublished: (info) => void scheduleOgWarm(event, info)
		});
		return json(appended, { status: 201 });
	}
);
