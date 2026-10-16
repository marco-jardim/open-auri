// POST /api/v1/curves/[id]/activity (T4.4): one "previewed" (>= 10 s) or "installed" event of
// the signed-in, verified user on lineage `[id]`. Rules in #lib/server/social/activity.ts.
//   201 { status: 'recorded', activity }   200 { status: 'duplicate' } (eventId already seen)
//   400 INVALID_BODY (schema; details.issues `preview_too_short` / `at_out_of_window`)
//   404 NOT_FOUND (missing, or not readable by the caller)
import { ApiError, defineApi, json, readJson, type ApiEvent } from '#lib/server/api/index.ts';
import { ActivityEventBody, recordActivityEvent } from '#lib/server/social/activity.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

/** The part of the RequestEvent used here (tests pass synthetic events of this shape). */
interface CurveActivityEvent extends ApiEvent {
	params: { id?: string };
}

export const POST = defineApi<CurveActivityEvent>(
	{
		auth: 'verified',
		rateLimit: {
			group: 'api.activity.write',
			quotas: [{ limit: 120, windowSeconds: 3600 }, { limit: 1000 }]
		}
	},
	async ({ event, env, user }) => {
		const body = await readJson(event.request, ActivityEventBody, { maxBytes: 2048 });
		const outcome = await recordActivityEvent(env.db, user.id, event.params.id ?? '', body);
		switch (outcome.status) {
			case 'recorded':
				return json({ status: 'recorded', activity: outcome.activity }, { status: 201 });
			case 'duplicate':
				return json({ status: 'duplicate' });
			case 'rejected':
				if (outcome.reason === 'not-found') throw new ApiError(404, 'NOT_FOUND');
				if (outcome.reason === 'too-short') {
					throw new ApiError(400, 'INVALID_BODY', {
						issues: [{ path: ['durationMs'], code: 'preview_too_short' }]
					});
				}
				if (outcome.reason === 'out-of-window') {
					throw new ApiError(400, 'INVALID_BODY', {
						issues: [{ path: ['at'], code: 'at_out_of_window' }]
					});
				}
				throw new ApiError(400, 'INVALID_BODY');
		}
	}
) satisfies RequestHandler;
