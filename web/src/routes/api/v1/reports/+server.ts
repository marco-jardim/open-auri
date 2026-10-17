// POST /api/v1/reports (T4.8): a verified user reports a lineage, pack or user, with a reason and
// an optional private note (only admins read it). User targetId is a public nickname, never an
// internal account id. Turnstile action `report`. Answers 404 for
// targets the reporter cannot read (same as missing), 403 FORBIDDEN for one's own content or
// profile, 409 DUPLICATE for a second report of the same target. The automatic hiding runs after
// the insert (social/moderation.ts) and is not revealed to the reporter.
import { z } from 'zod';
import { ApiError, defineApi, json, readJson } from '#lib/server/api/index.ts';
import { TURNSTILE_ACTIONS } from '#lib/server/security/turnstile.ts';
import { fileReport } from '#lib/server/social/moderation.ts';
import { NOTE_MAX, REPORT_REASONS, REPORT_TARGET_KINDS } from '#lib/server/social/types.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

/** Reports a user may file per day (burst control is RL_WRITE). */
const REPORTS_PER_DAY = 30;

function noControl(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if ((code < 0x20 && char !== '\n' && char !== '\t') || code === 0x7f) return false;
	}
	return true;
}

const Body = z
	.object({
		targetKind: z.enum(REPORT_TARGET_KINDS),
		targetId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
		reason: z.enum(REPORT_REASONS),
		note: z.string().max(NOTE_MAX).refine(noControl).nullish()
	})
	.strict()
	.refine((body) => body.targetKind === 'user' || /^[A-Za-z0-9_-]+$/.test(body.targetId));

export const POST: RequestHandler = defineApi(
	{
		auth: 'verified',
		rateLimit: { group: 'api.reports', quotas: [{ limit: REPORTS_PER_DAY }] },
		turnstile: TURNSTILE_ACTIONS.report
	},
	async ({ event, env, user }) => {
		const body = await readJson(event.request, Body, { maxBytes: 4096 });
		const result = await fileReport(env.db, {
			metrics: env.metrics,
			reporterUserId: user.id,
			targetKind: body.targetKind,
			targetId: body.targetId,
			reason: body.reason,
			note: body.note ?? null,
			now: Date.now()
		});
		if (!result.ok) {
			if (result.code === 'NOT_FOUND') throw new ApiError(404, 'NOT_FOUND');
			if (result.code === 'SELF') throw new ApiError(403, 'FORBIDDEN');
			if (result.code === 'DUPLICATE') throw new ApiError(409, 'DUPLICATE');
			throw new ApiError(400, 'INVALID_BODY');
		}
		return json({ reported: true }, { status: 201 });
	}
);
