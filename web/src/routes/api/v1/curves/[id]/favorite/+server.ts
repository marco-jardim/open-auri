// PUT|DELETE /api/v1/curves/[id]/favorite (T4.3). `[id]` is the lineage id. Both are idempotent.
// PUT answers 404 NOT_FOUND when the lineage is not readable by the caller; `?s=<shareId>`
// attributes a `favorited` funnel event to that share when it points to the same lineage. DELETE
// only removes the caller's own row and never reveals whether the lineage exists.
import { ApiError, defineApi, json, type ApiEvent } from '#lib/server/api/index.ts';
import { favoriteLineage, unfavoriteLineage } from '#lib/server/social/library.ts';

export const prerender = false;

interface FavoriteEvent extends ApiEvent {
	params: { id: string };
}

export const PUT = defineApi<FavoriteEvent>(
	{ auth: 'verified', rateLimit: { group: 'api.curves.favorite' } },
	async ({ event, env, user }) => {
		const shareId = new URL(event.request.url).searchParams.get('s');
		const result = await favoriteLineage(env.db, user.id, event.params.id, {
			shareId,
			yoloPublication: env.yoloPublication
		});
		if (!result.ok) throw new ApiError(404, 'NOT_FOUND');
		return json({ favorited: true, created: result.created });
	}
);

export const DELETE = defineApi<FavoriteEvent>(
	{ auth: 'verified', rateLimit: { group: 'api.curves.favorite' } },
	async ({ event, env, user }) => {
		const result = await unfavoriteLineage(env.db, user.id, event.params.id);
		return json({ favorited: false, removed: result.removed });
	}
);
