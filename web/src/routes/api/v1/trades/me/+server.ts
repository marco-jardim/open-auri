// GET /api/v1/trades/me (T4.10, S7): the caller's trades, newest first (`?cursor=&limit=`).
// While blind the partner is only playable data (curve id + S1); after the reveal it adds the
// partner's nickname (if any), the lineage when it can be linked, and both scores. Never the
// partner's user id or trade id. Private, no-store.
import { ApiError, defineApi, json, type ApiEvent } from '#lib/server/api/index.ts';
import { listMyTrades, TRADE_API_ERRORS } from '#lib/server/social/trades.ts';

export const prerender = false;

export const GET = defineApi<ApiEvent>(
	{ auth: 'verified', rateLimit: { group: 'api.trades.read' } },
	async ({ event, env, user }) => {
		const params = new URL(event.request.url).searchParams;
		const cursor = params.get('cursor');
		const rawLimit = params.get('limit');
		const limit = rawLimit === null ? Number.NaN : Number(rawLimit);
		const result = await listMyTrades(env.db, user.id, {
			...(cursor ? { cursor } : {}),
			...(Number.isInteger(limit) ? { limit } : {})
		});
		if (!result.ok) {
			const { status, code } = TRADE_API_ERRORS[result.code];
			throw new ApiError(status, code);
		}
		return json(result.value);
	}
);
