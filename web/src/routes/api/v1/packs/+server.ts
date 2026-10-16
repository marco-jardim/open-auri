// POST /api/v1/packs (T4.11, S9): create a pack (verified e-mail). Body:
// `{ name, description?, visibility?, items? }`, items as lineage ids or
// `{ lineageId, license? }` (license, when sent, must be the head version's). 201 with the pack.
import { z } from 'zod';
import { defineApi, json, readJson, type ApiEvent } from '#lib/server/api/index.ts';
import { createOwnPack } from '#lib/server/social/packs.ts';
import { PackBody } from './schema.ts';

export const prerender = false;

const CreateBody = PackBody.extend({ name: z.string().max(400) });

export const POST = defineApi<ApiEvent>(
	{ auth: 'verified', rateLimit: { group: 'api.packs.write', quotas: [{ limit: 50 }] } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, CreateBody, { maxBytes: 32_768 });
		const pack = await createOwnPack(env.db, user.id, body, Date.now());
		return json(pack, { status: 201 });
	}
);
