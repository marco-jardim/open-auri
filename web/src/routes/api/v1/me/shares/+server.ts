// GET /api/v1/me/shares?cursor=&limit= (T4.14b): the signed-in user's own share links, newest
// first → { items: MyShare[], nextCursor }. Each item names its lineage (null when the caller can
// no longer read it); no viewer or funnel data here (that is `GET /shares/:id/stats`). Bad query
// parameters answer 400 INVALID_BODY with `details.issues`; a bad cursor, 400 INVALID_CURSOR.
import { z } from 'zod';
import { ApiError, defineApi, json, type ApiEvent } from '#lib/server/api/index.ts';
import { getLineageForViewer, listOwnShares } from '#lib/server/social/repo.ts';
import { PAGE_SIZE_MAX, SocialRepoError, type ShareRecord } from '#lib/server/social/types.ts';

export const prerender = false;

/** One share link of the caller. */
export interface MyShare {
	id: string;
	lineage: { id: string; name: string | null };
	versionId: string | null;
	channel: string | null;
	createdAt: number;
}

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

export const GET = defineApi<ApiEvent>(
	{ auth: 'user', rateLimit: { group: 'api.me.shares.read' } },
	async ({ event, env, user }) => {
		const query = readQuery(event.request);
		let items: ShareRecord[];
		let nextCursor: string | null;
		try {
			({ items, nextCursor } = await listOwnShares(env.db, user.id, query));
		} catch (error) {
			if (error instanceof SocialRepoError && error.code === 'invalid-cursor') {
				throw new ApiError(400, 'INVALID_CURSOR', undefined, { cause: error });
			}
			throw error;
		}
		// Lineage names through the repo's visibility rule, as the caller sees them.
		const viewer = { userId: user.id };
		const names = new Map<string, string | null>();
		for (const lineageId of new Set(items.map((share) => share.lineageId))) {
			const lineage = await getLineageForViewer(env.db, lineageId, viewer);
			// The lineage's name is its head version's name.
			names.set(lineageId, lineage ? lineage.head.name : null);
		}
		const shares: MyShare[] = items.map((share) => ({
			id: share.id,
			lineage: { id: share.lineageId, name: names.get(share.lineageId) ?? null },
			versionId: share.versionId,
			channel: share.channel,
			createdAt: share.createdAt
		}));
		return json({ items: shares, nextCursor });
	}
);
