// POST /api/v1/me/library/merge: merges a batch of the anonymous browser library into the
// account (T4.3). Body `{ items: [{ localId, s1, name, description?, lang?, license? }] }`, at most
// MERGE_BATCH_MAX items with distinct `localId`s. Answers 200 with the merge report
// `{ created, duplicates, rejected, conflicts }` (see mergeLocalLibrary).
import { z } from 'zod';
import { defineApi, json, readJson, type ApiEvent } from '#lib/server/api/index.ts';
import { MERGE_BATCH_MAX, mergeLocalLibrary } from '#lib/server/social/library.ts';
import { LANGS, LICENSES } from '#lib/server/social/types.ts';

export const prerender = false;

/** Raw text bounds before normalization (normalization then cuts to NAME_MAX/DESCRIPTION_MAX). */
const NAME_RAW_MAX = 400;
const DESCRIPTION_RAW_MAX = 4000;
/** 100 items with the longest description fit (4 bytes per code point at worst). */
const MERGE_MAX_BYTES = 1024 * 1024;

const Item = z.object({
	localId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
	s1: z.string().min(1).max(256),
	name: z.string().max(NAME_RAW_MAX),
	description: z.string().max(DESCRIPTION_RAW_MAX).optional(),
	lang: z.enum(LANGS).optional(),
	license: z.enum(LICENSES).optional()
});

const Body = z.object({
	items: z
		.array(Item)
		.min(1)
		.max(MERGE_BATCH_MAX)
		.refine((items) => new Set(items.map((item) => item.localId)).size === items.length, {
			message: 'duplicate localId'
		})
});

export const POST = defineApi<ApiEvent>(
	{ auth: 'verified', rateLimit: { group: 'api.me.library.merge', quotas: [{ limit: 50 }] } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, Body, { maxBytes: MERGE_MAX_BYTES });
		const report = await mergeLocalLibrary(env.db, user.id, body.items);
		return json(report);
	}
);
