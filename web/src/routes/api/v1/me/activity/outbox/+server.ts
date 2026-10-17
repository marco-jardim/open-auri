// POST /api/v1/me/activity/outbox (T4.4): events queued offline, sent in one batch.
// Body `{ events: [...] }`, 1 to 50 items of the shape of POST /curves/[id]/activity plus
// `lineageId`. Each item is accepted or rejected on its own (an `at` older than 7 days rejects that
// item only); a replayed `eventId` answers `duplicate`, so the client can drop it either way.
// Every item that passes the cheap checks costs one unit of the per-user daily activity quota
// shared with POST /curves/[id]/activity (1 000/day); items past it answer `limited` (kept by the
// client and retried later), so a batch never multiplies the daily budget.
//   200 { results: [{ index, eventId, status: 'recorded' | 'duplicate' | 'rejected' | 'limited',
//         reason? }] }
//   reasons: invalid, too-short, out-of-window, not-found
import { defineApi, json, readJson, type ApiEvent } from '#lib/server/api/index.ts';
import { OutboxBody, recordOutbox } from '#lib/server/social/activity.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const POST = defineApi<ApiEvent>(
	{
		auth: 'verified',
		rateLimit: {
			group: 'api.activity.outbox',
			quotas: [{ limit: 30, windowSeconds: 3600 }, { limit: 100 }]
		}
	},
	async ({ event, env, user }) => {
		const body = await readJson(event.request, OutboxBody, { maxBytes: 32_768 });
		const results = await recordOutbox(env.db, user.id, body.events, {
			claimSecret: env.secrets.betterAuthSecret
		});
		return json({ results });
	}
) satisfies RequestHandler;
