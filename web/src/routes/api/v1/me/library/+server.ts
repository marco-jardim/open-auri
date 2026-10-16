// GET /api/v1/me/library?shelf=created|favorites|installed&visibility=&cursor=&limit=
// The caller's own shelves (T4.3). `visibility` filters the `created` shelf only. Bad query
// parameters answer 400 INVALID_BODY with `details.issues` (the kit has no query-specific code).
import { z } from 'zod';
import { ApiError, defineApi, json, type ApiEvent } from '#lib/server/api/index.ts';
import { LIBRARY_SHELVES, listLibrary } from '#lib/server/social/library.ts';
import { LINEAGE_VISIBILITIES, PAGE_SIZE_MAX, SocialRepoError } from '#lib/server/social/types.ts';

export const prerender = false;

const Query = z
	.object({
		shelf: z.enum(LIBRARY_SHELVES),
		visibility: z.enum(LINEAGE_VISIBILITIES).optional(),
		cursor: z.string().min(1).max(512).optional(),
		limit: z
			.string()
			.regex(/^\d{1,3}$/)
			.transform(Number)
			.pipe(z.number().int().min(1).max(PAGE_SIZE_MAX))
			.optional()
	})
	.refine((query) => query.visibility === undefined || query.shelf === 'created', {
		path: ['visibility']
	});

function readQuery(request: Request): z.output<typeof Query> {
	const params = new URL(request.url).searchParams;
	const raw: Record<string, string> = {};
	for (const key of ['shelf', 'visibility', 'cursor', 'limit']) {
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
	{ auth: 'user', rateLimit: { group: 'api.me.library.read' } },
	async ({ event, env, user }) => {
		const query = readQuery(event.request);
		try {
			const page = await listLibrary(env.db, user.id, query);
			return json({ shelf: query.shelf, items: page.items, nextCursor: page.nextCursor });
		} catch (error) {
			if (error instanceof SocialRepoError && error.code === 'invalid-cursor') {
				throw new ApiError(400, 'INVALID_CURSOR', undefined, { cause: error });
			}
			throw error;
		}
	}
);
