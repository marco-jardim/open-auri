// POST /api/v1/shares (T4.5): creates a share of a lineage the caller can link (public or
// unlisted, or the caller's own) and returns its link `/c/<lineageId>?s=<shareId>`.
import { defineApi, json, readJson, type ApiEvent } from '#lib/server/api/index.ts';
import { CreateShareBody, createShareFor } from '#lib/server/social/shares.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const POST: RequestHandler = defineApi<ApiEvent>(
	{ auth: 'verified', rateLimit: { group: 'api.shares.create', quotas: [{ limit: 200 }] } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, CreateShareBody);
		const created = await createShareFor(env.db, user.id, body);
		return json(created, { status: 201 });
	}
);
