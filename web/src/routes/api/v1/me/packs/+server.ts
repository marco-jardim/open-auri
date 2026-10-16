// GET /api/v1/me/packs?cursor=&limit= (T4.14b): the signed-in user's own packs in any visibility,
// newest first → { items: MyPack[], nextCursor }. Bad query parameters answer 400 INVALID_BODY with
// `details.issues`; a cursor that does not decode answers 400 INVALID_CURSOR.
import { z } from 'zod';
import { ApiError, defineApi, json, type ApiEvent } from '#lib/server/api/index.ts';
import { listOwnPacks } from '#lib/server/social/repo.ts';
import { PAGE_SIZE_MAX, SocialRepoError, type PackRecord } from '#lib/server/social/types.ts';

export const prerender = false;

/** One pack of the caller (the owner id is the caller's own, so it is left out). */
export type MyPack = Omit<PackRecord, 'ownerUserId'>;

const Query = z.object({
	cursor: z.string().min(1).max(512).optional(),
	limit: z
		.string()
		.regex(/^\d{1,3}$/)
		.transform(Number)
		.pipe(z.number().int().min(1).max(PAGE_SIZE_MAX))
		.optional()
});

function readQuery(request: Request): z.output<typeof Query> {
	const params = new URL(request.url).searchParams;
	const raw: Record<string, string> = {};
	for (const key of ['cursor', 'limit']) {
		const value = params.get(key);
		if (value !== null && value !== '') raw[key] = value;
	}
	const parsed = Query.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({
			path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
			code: issue.code
		}));
		throw new ApiError(400, 'INVALID_BODY', { issues });
	}
	return parsed.data;
}

function toMyPack(pack: PackRecord): MyPack {
	return {
		id: pack.id,
		name: pack.name,
		description: pack.description,
		visibility: pack.visibility,
		moderation: pack.moderation,
		createdAt: pack.createdAt,
		updatedAt: pack.updatedAt
	};
}

export const GET = defineApi<ApiEvent>(
	{ auth: 'user', rateLimit: { group: 'api.me.packs.read' } },
	async ({ event, env, user }) => {
		const query = readQuery(event.request);
		try {
			const page = await listOwnPacks(env.db, user.id, query);
			return json({ items: page.items.map(toMyPack), nextCursor: page.nextCursor });
		} catch (error) {
			if (error instanceof SocialRepoError && error.code === 'invalid-cursor') {
				throw new ApiError(400, 'INVALID_CURSOR', undefined, { cause: error });
			}
			throw error;
		}
	}
);
