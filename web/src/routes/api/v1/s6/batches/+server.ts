// POST /api/v1/s6/batches: one anonymous S6 preference batch (T4.9).
// Public. The rate limit runs here (not through `rateLimit` of defineApi) so it always keys on the
// daily-salted IP hash, never on a signed-in user's id, and uses only the burst binding: nothing
// about the caller is persisted, in the batch or anywhere else. Then Turnstile, then the body.
import { z } from 'zod';
import {
	ApiError,
	apiRateLimit,
	apiTurnstile,
	defineApi,
	json,
	readJson
} from '#lib/server/api/index.ts';
import { TURNSTILE_ACTIONS } from '#lib/server/security/turnstile.ts';
import {
	S6_ITEM_PATTERN,
	S6_PAIRS_MAX,
	S6_RECEIPT_PATTERN,
	submitBatch
} from '#lib/server/social/s6.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

const S6_SUBMIT_GROUP = 'api.s6.submit';

const Pair = z
	.object({
		a: z.string().regex(S6_ITEM_PATTERN),
		b: z.string().regex(S6_ITEM_PATTERN),
		choice: z.enum(['a', 'b', 'tie']),
		levelMatched: z.boolean()
	})
	.strict()
	.refine((pair) => pair.a !== pair.b, { message: 'same-item' });

const Body = z
	.object({
		consentVersion: z.string().min(1).max(32),
		receipt: z.string().regex(S6_RECEIPT_PATTERN),
		pairs: z.array(Pair).min(1).max(S6_PAIRS_MAX)
	})
	.strict();

export const POST: RequestHandler = defineApi(
	{ auth: 'public', rateLimit: false },
	async ({ event, env }) => {
		const { request } = event;
		await apiRateLimit(
			env,
			{ request, locals: { user: null, session: null } },
			{ group: S6_SUBMIT_GROUP, kind: 'write' }
		);
		await apiTurnstile(env, request, TURNSTILE_ACTIONS.s6);
		const body = await readJson(request, Body);
		const result = await submitBatch(env.db, body, new Date());
		if (!result.ok) {
			if (result.code === 'consent-required') throw new ApiError(400, 'CONSENT_REQUIRED');
			if (result.code === 'duplicate') throw new ApiError(409, 'DUPLICATE');
			throw new ApiError(400, 'INVALID_BODY');
		}
		return json({ ok: true }, { status: 201 });
	}
);
