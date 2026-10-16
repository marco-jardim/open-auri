// POST /api/v1/trades (T4.10, S7): joins the blind-trade queue with `{ lineageId, versionId? }`
// (default: the head version). The lineage must be the caller's own or publicly listable, and the
// version's curve must have passed the gate. 409 ALREADY_ACTIVE when the caller already has a
// waiting or matched trade. Pairs at once with the oldest eligible waiting trade, else waits.
import { z } from 'zod';
import { ApiError, defineApi, json, readJson, type ApiEvent } from '#lib/server/api/index.ts';
import { joinTrade, TRADE_API_ERRORS } from '#lib/server/social/trades.ts';

export const prerender = false;

const Body = z.object({
	lineageId: z.string().min(1).max(64),
	versionId: z.string().min(1).max(64).optional()
});

export const POST = defineApi<ApiEvent>(
	{ auth: 'verified', rateLimit: { group: 'api.trades.join' } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, Body, { maxBytes: 1024 });
		const result = await joinTrade(env.db, user.id, {
			lineageId: body.lineageId,
			versionId: body.versionId
		});
		if (!result.ok) {
			const { status, code } = TRADE_API_ERRORS[result.code];
			throw new ApiError(status, code);
		}
		return json({ trade: result.value }, { status: 201 });
	}
);
