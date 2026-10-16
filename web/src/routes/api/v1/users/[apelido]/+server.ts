// GET /api/v1/users/[apelido] (T4.11): public profile.
//   - no `list`: nickname, bio, visibility flags and aggregate counts, plus the first page of each
//     public list (`null` for lists that are not public);
//   - `?list=lineages|packs|favorites&cursor=&limit=`: one page of that list
//     (`{ list, items, nextCursor }`; empty when the list is not public);
//   - previous nickname still on hold (90 days), or another spelling of the nickname: HTTP 308
//     with `location: /api/v1/users/<current>` and body `{ "redirect": "<current>" }`;
//   - unknown, released or banned: 404 NOT_FOUND.
import {
	ApiError,
	CACHE_PUBLIC_60,
	cached,
	defineApi,
	json,
	type ApiEvent
} from '#lib/server/api/index.ts';
import {
	findProfile,
	loadProfileList,
	loadProfileOverview,
	PROFILE_LISTS,
	type ProfileList
} from '#lib/server/social/profiles.ts';
import { SocialRepoError, isOneOf } from '#lib/server/social/types.ts';

export const prerender = false;

type UserEvent = ApiEvent & { params: { apelido: string }; url: URL };

function pageLimit(raw: string | null): number | undefined {
	if (raw === null || raw === '') return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value)) {
		throw new ApiError(400, 'INVALID_BODY', { issues: [{ path: 'limit', code: 'invalid' }] });
	}
	return value;
}

export const GET = defineApi<UserEvent>(
	{ auth: 'public', rateLimit: { group: 'api.users.read' } },
	async ({ event, env }) => {
		const found = await findProfile(env.db, event.params.apelido, Date.now());
		if (found.kind === 'missing') throw new ApiError(404, 'NOT_FOUND');
		if (found.kind === 'redirect') {
			const location = `/api/v1/users/${encodeURIComponent(found.to)}${event.url.search}`;
			return json({ redirect: found.to }, { status: 308, headers: { location } });
		}
		const listParam = event.url.searchParams.get('list');
		try {
			if (listParam === null) {
				const overview = await loadProfileOverview(env.db, found.profile);
				return cached(event.request, JSON.stringify(overview), { cacheControl: CACHE_PUBLIC_60 });
			}
			if (!isOneOf(PROFILE_LISTS, listParam)) {
				throw new ApiError(400, 'INVALID_BODY', { issues: [{ path: 'list', code: 'invalid' }] });
			}
			const list: ProfileList = listParam;
			const limit = pageLimit(event.url.searchParams.get('limit'));
			const page = await loadProfileList(env.db, found.profile, list, {
				cursor: event.url.searchParams.get('cursor'),
				...(limit === undefined ? {} : { limit })
			});
			const body = { list, items: page?.items ?? [], nextCursor: page?.nextCursor ?? null };
			return cached(event.request, JSON.stringify(body), { cacheControl: CACHE_PUBLIC_60 });
		} catch (error) {
			if (error instanceof SocialRepoError) throw new ApiError(400, 'INVALID_CURSOR');
			throw error;
		}
	}
);
