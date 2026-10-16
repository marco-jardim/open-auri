// PUT /api/v1/lineages/[id]/visibility (T4.2): owner sets private, unlisted or public.
import { defineApi, json, readJson } from '#lib/server/api/index.ts';
import { changeVisibility, VisibilityBodySchema } from '#lib/server/social/curves.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const PUT: RequestHandler = defineApi(
	{ auth: 'verified', rateLimit: { group: 'api.lineages.write' } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, VisibilityBodySchema);
		return json(await changeVisibility(env.db, user.id, event.params.id ?? '', body.visibility));
	}
);
