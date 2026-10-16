// /api/v1/packs/[id] (T4.11, S9).
//   GET (public): the pack when readable (public or unlisted, not moderated, owner not banned; or
//     the viewer's own). Someone else's pack only lists publicly listable lineages; the owner sees
//     every item they can read. Owner reads are `private, no-store`.
//   PUT (owner): `{ name?, description?, visibility?, items? }`; `items` replaces the list in
//     the given order, the per-item license is copied from the head version (a sent license
//     must match it, otherwise 409 CONFLICT `license-mismatch`).
//   DELETE (owner): 204.
// Someone else's pack answers 404 to PUT and DELETE, like a missing one.
import {
	ApiError,
	CACHE_PUBLIC_60,
	cached,
	defineApi,
	json,
	readJson,
	type ApiEvent
} from '#lib/server/api/index.ts';
import { editOwnPack, removeOwnPack, viewPack } from '#lib/server/social/packs.ts';
import { PackBody } from '../schema.ts';

export const prerender = false;

type PackEvent = ApiEvent & { params: { id: string } };

export const GET = defineApi<PackEvent>(
	{ auth: 'public', rateLimit: { group: 'api.packs.read' } },
	async ({ event, env, user }) => {
		const pack = await viewPack(env.db, event.params.id, { userId: user?.id ?? null });
		if (!pack) throw new ApiError(404, 'NOT_FOUND');
		if (pack.owned) return json(pack);
		return cached(event.request, JSON.stringify(pack), { cacheControl: CACHE_PUBLIC_60 });
	}
);

export const PUT = defineApi<PackEvent>(
	{ auth: 'verified', rateLimit: { group: 'api.packs.write' } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, PackBody, { maxBytes: 32_768 });
		const pack = await editOwnPack(env.db, event.params.id, user.id, body, Date.now());
		return json(pack);
	}
);

export const DELETE = defineApi<PackEvent>(
	{ auth: 'user', rateLimit: { group: 'api.packs.write' } },
	async ({ event, env, user }) => {
		if (!(await removeOwnPack(env.db, event.params.id, user.id))) {
			throw new ApiError(404, 'NOT_FOUND');
		}
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	}
);
