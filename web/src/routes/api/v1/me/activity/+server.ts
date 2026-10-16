// GET|DELETE /api/v1/me/activity (T4.4): the signed-in user's own activity history.
//   GET ?cursor=&limit=          → { items: ActivityRecord[], nextCursor }
//   DELETE ?lineageId=&kind=     → { deleted } (no filter: everything; matching attributed share
//                                  events go too, so public counts drop at once)
import { ApiError, defineApi, json, type ApiEvent } from '#lib/server/api/index.ts';
import { deleteMyActivity, listMyActivity } from '#lib/server/social/activity.ts';
import { isSocialId } from '#lib/server/social/repo.ts';
import {
	ACTIVITY_KINDS,
	isOneOf,
	SocialRepoError,
	type ActivityKind
} from '#lib/server/social/types.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

/** The part of the RequestEvent used here (tests pass synthetic events of this shape). */
interface MyActivityEvent extends ApiEvent {
	url: URL;
}

function invalidQuery(param: string): ApiError {
	return new ApiError(400, 'INVALID_BODY', { issues: [{ path: [param], code: 'invalid_value' }] });
}

export const GET = defineApi<MyActivityEvent>(
	{ auth: 'user', rateLimit: { group: 'api.me.activity.read' } },
	async ({ event, env, user }) => {
		const params = event.url.searchParams;
		const rawLimit = params.get('limit');
		let limit: number | undefined;
		if (rawLimit !== null) {
			if (!/^\d{1,3}$/.test(rawLimit)) throw invalidQuery('limit');
			limit = Number(rawLimit);
		}
		try {
			const page = await listMyActivity(env.db, user.id, {
				cursor: params.get('cursor'),
				...(limit === undefined ? {} : { limit })
			});
			return json(page);
		} catch (error) {
			if (error instanceof SocialRepoError && error.code === 'invalid-cursor') {
				throw new ApiError(400, 'INVALID_CURSOR', undefined, { cause: error });
			}
			throw error;
		}
	}
) satisfies RequestHandler;

export const DELETE = defineApi<MyActivityEvent>(
	{ auth: 'user', rateLimit: { group: 'api.me.activity.delete' } },
	async ({ event, env, user }) => {
		const params = event.url.searchParams;
		const lineageId = params.get('lineageId');
		const rawKind = params.get('kind');
		if (lineageId !== null && !isSocialId(lineageId)) throw invalidQuery('lineageId');
		let kind: ActivityKind | null = null;
		if (rawKind !== null) {
			if (!isOneOf(ACTIVITY_KINDS, rawKind)) throw invalidQuery('kind');
			kind = rawKind;
		}
		const deleted = await deleteMyActivity(env.db, user.id, { lineageId, kind });
		return json({ deleted });
	}
) satisfies RequestHandler;
