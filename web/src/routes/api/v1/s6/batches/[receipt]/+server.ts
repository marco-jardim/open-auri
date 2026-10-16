// DELETE /api/v1/s6/batches/[receipt]: withdraws the batch of this receipt (T4.9, LGPD art. 18).
// Public: the receipt (32 random bytes, kept only by the browser) is the bearer secret. Always 204,
// whether a batch existed, was already withdrawn or the receipt is malformed: no existence oracle.
// Rate limited on the daily-salted IP hash (burst binding only, never the user id, nothing stored).
import { apiRateLimit, defineApi } from '#lib/server/api/index.ts';
import { deleteBatch } from '#lib/server/social/s6.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

export const DELETE: RequestHandler = defineApi(
	{ auth: 'public', rateLimit: false },
	async ({ event, env }) => {
		await apiRateLimit(
			env,
			{ request: event.request, locals: { user: null, session: null } },
			{ group: 'api.s6.delete', kind: 'write' }
		);
		await deleteBatch(env.db, event.params.receipt);
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	}
);
