// DELETE /api/v1/trades/[id] (T4.10, S7): cancels the caller's own trade while it is waiting.
// 404 when the trade is not the caller's; 409 CONFLICT once it is matched or closed.
import { ApiError, defineApi, json, type ApiEvent } from '#lib/server/api/index.ts';
import { cancelMyTrade, TRADE_API_ERRORS } from '#lib/server/social/trades.ts';

export const prerender = false;

interface TradeEvent extends ApiEvent {
	params: { id: string };
}

export const DELETE = defineApi<TradeEvent>(
	{ auth: 'verified', rateLimit: { group: 'api.trades.cancel' } },
	async ({ event, env, user }) => {
		const result = await cancelMyTrade(env.db, user.id, event.params.id);
		if (!result.ok) {
			const { status, code } = TRADE_API_ERRORS[result.code];
			throw new ApiError(status, code);
		}
		return json(result.value);
	}
);
