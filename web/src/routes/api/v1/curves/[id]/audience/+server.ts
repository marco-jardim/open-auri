// GET /api/v1/curves/[id]/audience (T4.4): who previewed, installed and favorited the caller's
// own lineage. Per kind: `total` distinct verified, non-banned users (the owner excluded),
// `named` only for users with activity_visibility = 'public', and `privateCount` for the rest
// ("N pessoas com perfil privado"). Someone else's or a missing lineage: 404.
import { ApiError, defineApi, json, type ApiEvent } from '#lib/server/api/index.ts';
import { audienceFor } from '#lib/server/social/activity.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

/** The part of the RequestEvent used here (tests pass synthetic events of this shape). */
interface AudienceEvent extends ApiEvent {
	params: { id?: string };
}

export const GET = defineApi<AudienceEvent>(
	{ auth: 'user', rateLimit: { group: 'api.curves.audience' } },
	async ({ event, env, user }) => {
		const audience = await audienceFor(env.db, event.params.id ?? '', user.id);
		if (!audience) throw new ApiError(404, 'NOT_FOUND');
		return json({ audience });
	}
) satisfies RequestHandler;
