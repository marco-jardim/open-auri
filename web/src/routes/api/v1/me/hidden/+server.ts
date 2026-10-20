import { z } from 'zod';
import { defineApi, json, readJson, type ApiEvent } from '#lib/server/api/index.ts';
import { deleteHidden, putHidden, readHidden } from '#lib/server/social/hidden.ts';
import { HIDDEN_LIMIT, hiddenLabelText } from '#lib/social/hidden.ts';
import type { RequestHandler } from './$types';

export const prerender = false;
const Author = z.string().regex(/^[a-z0-9._-]{1,64}$/);
const Curve = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Label = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.refine((value) => hiddenLabelText(value) === value);
const Labels = z
	.object({
		authors: z.record(Author, Label).refine((value) => Object.keys(value).length <= HIDDEN_LIMIT),
		curves: z.record(Curve, Label).refine((value) => Object.keys(value).length <= HIDDEN_LIMIT)
	})
	.strict();
const List = z
	.object({
		authors: z.array(Author).max(HIDDEN_LIMIT),
		curves: z.array(Curve).max(HIDDEN_LIMIT),
		labels: Labels.optional()
	})
	.strict();
const Target = z.discriminatedUnion('targetType', [
	z.object({ targetType: z.literal('author'), targetId: Author }).strict(),
	z.object({ targetType: z.literal('curve'), targetId: Curve }).strict()
]);

export const GET = defineApi<ApiEvent>(
	{ auth: 'user', rateLimit: { group: 'api.me.hidden.read' } },
	async ({ env, user }) => json(await readHidden(env.db, user.id))
) satisfies RequestHandler;

// defineApi checks Origin/CSRF on both mutations; preferences do not require verification.
export const PUT = defineApi<ApiEvent>(
	{ auth: 'user', rateLimit: { group: 'api.me.hidden.write' } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, List, { maxBytes: 512 * 1024 });
		return json(await putHidden(env.db, user.id, body, Date.now()));
	}
) satisfies RequestHandler;

export const DELETE = defineApi<ApiEvent>(
	{ auth: 'user', rateLimit: { group: 'api.me.hidden.write' } },
	async ({ event, env, user }) => {
		const body = await readJson(event.request, Target, { maxBytes: 1024 });
		return json(await deleteHidden(env.db, user.id, body));
	}
) satisfies RequestHandler;
