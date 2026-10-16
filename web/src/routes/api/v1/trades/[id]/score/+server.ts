// POST /api/v1/trades/[id]/score (T4.10, S7): the participant scores the partner's curve once,
// `{ score: 1..5 }`. The second score of the pair reveals both trades atomically. 404 for a trade
// that is not the caller's, 409 DUPLICATE when already scored, 409 CONFLICT when the trade is not
// matched (waiting, expired, cancelled, revealed).
import { z } from 'zod';
import { ApiError, defineApi, json, readJson, type ApiEvent } from '#lib/server/api/index.ts';
import { scoreMyTrade, TRADE_API_ERRORS } from '#lib/server/social/trades.ts';

export const prerender = false;

interface TradeEvent extends ApiEvent {
	params: { id: string };
}

const Body = z.object({ score: z.number().int().min(1).max(5) });

export const POST = defineApi<TradeEvent>(
	{ auth: 'verified', rateLimit: { group: 'api.trades.score' } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, Body, { maxBytes: 256 });
		const result = await scoreMyTrade(env.db, user.id, event.params.id, body.score);
		if (!result.ok) {
			const { status, code } = TRADE_API_ERRORS[result.code];
			throw new ApiError(status, code);
		}
		return json(result.value);
	}
);
