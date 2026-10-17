// T5.T "modo somente leitura", end to end through the pipeline of hooks.server.ts (./pipeline.ts:
// canonical host → request log → read-only → security headers) in front of the REAL route
// modules: with the switch on, a real write is answered 503 READ_ONLY before the route runs and
// nothing reaches D1; reads, OPTIONS and the allowlist pass; Better Auth's state-changing GET link
// is blocked; with the switch off the same request reaches the route and writes.
//
// The KV switch itself is never flipped (shared namespace): the read-only step sees a CONFIG view
// (configView). The KV toggle, its cache and its audit are covered by admin/read-only.test.ts and
// phase3/cross-cutting.test.ts; every /api/v1 write × 503 by phase4/protections.test.ts. On
// staging the switch is tested by hand (README.md of this folder).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { READ_ONLY_CODE } from '#lib/server/admin/read-only.ts';
import { invoke, member } from '../phase4/helpers.ts';
import {
	captureConsole,
	eventFor,
	requestLines,
	settled,
	through,
	type PipelineEvent
} from './pipeline.ts';

const ON = { readOnly: true } as const;
const OFF = { readOnly: false } as const;

async function packsOf(ownerId: string): Promise<number> {
	const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM packs WHERE owner_user_id = ?')
		.bind(ownerId)
		.first<{ n: number }>();
	return row?.n ?? -1;
}

describe('read-only mode through the hooks pipeline', () => {
	it('a real write (POST /api/v1/packs) is refused before the route; off, the same write lands', async () => {
		const owner = await member({ prefix: 'p5ro' });
		const packs = await import('../../../src/routes/api/v1/packs/+server.ts');
		const reached: string[] = [];
		const route = (event: PipelineEvent) => {
			reached.push(event.request.method);
			return invoke(packs, 'POST', event);
		};
		const post = () =>
			eventFor('/api/v1/packs', {
				method: 'POST',
				routeId: '/api/v1/packs',
				locals: owner.locals,
				body: { name: 'Read-only probe' }
			});

		const captured = await captureConsole(() => through(ON, post(), route));
		const blocked = captured.result;
		expect(blocked?.status).toBe(503);
		expect(blocked?.headers.get('x-error-code')).toBe(READ_ONLY_CODE);
		expect(blocked?.headers.get('retry-after')).toBe('300');
		expect(((await blocked?.json()) as { code: string }).code).toBe(READ_ONLY_CODE);
		expect(reached).toEqual([]);
		expect(await packsOf(owner.user.id)).toBe(0);
		// The request log still sees the 503, with its code and no request data.
		expect(requestLines(captured.lines)).toEqual([
			expect.objectContaining({
				route: '/api/v1/packs',
				method: 'POST',
				status: 503,
				code: READ_ONLY_CODE
			})
		]);

		const open = await through(OFF, post(), route);
		expect(open.status).toBe(201);
		expect(reached).toEqual(['POST']);
		expect(await packsOf(owner.user.id)).toBe(1);
		await settled();
	});

	it('reads, OPTIONS and the allowlist pass; the e-mailed verify link (GET) is blocked', async () => {
		const reached: string[] = [];
		const stub = (event: PipelineEvent) => {
			reached.push(`${event.request.method} ${event.url.pathname}`);
			return Response.json({ ok: true });
		};
		const feed = await import('../../../src/routes/api/v1/feed/+server.ts');
		const read = await through(ON, eventFor('/api/v1/feed', { routeId: '/api/v1/feed' }), (event) =>
			invoke(feed, 'GET', event)
		);
		expect(read.status).toBe(200);

		const options = await through(
			ON,
			eventFor('/api/v1/packs', { method: 'OPTIONS', routeId: '/api/v1/packs' }),
			stub
		);
		expect(options.status).toBe(200);

		const signIn = await through(
			ON,
			eventFor('/api/auth/sign-in/email', {
				method: 'POST',
				routeId: '/api/auth/[...all]',
				body: {}
			}),
			stub
		);
		expect(signIn.status).toBe(200);

		const admin = await through(
			ON,
			eventFor('/admin/usuarios', { method: 'POST', routeId: '/admin/usuarios' }),
			stub
		);
		expect(admin.status).toBe(200);

		for (const method of ['GET', 'HEAD'] as const) {
			const link = await through(
				ON,
				eventFor('/api/auth/verify-email?token=t', { method, routeId: '/api/auth/[...all]' }),
				stub
			);
			expect(link.status, method).toBe(503);
			expect(link.headers.get('x-error-code'), method).toBe(READ_ONLY_CODE);
			if (method === 'HEAD') expect(await link.text()).toBe('');
		}
		const webhook = await through(
			ON,
			eventFor('/api/webhooks/resend', {
				method: 'POST',
				routeId: '/api/webhooks/resend',
				body: {}
			}),
			stub
		);
		expect(webhook.status).toBe(200);
		for (const path of ['/conta/politica', '/api/v1/s6/batches']) {
			const write = await through(
				ON,
				eventFor(path, { method: 'POST', routeId: path, body: {} }),
				stub
			);
			expect(write.status, path).toBe(503);
		}
		expect(reached).toEqual([
			'OPTIONS /api/v1/packs',
			'POST /api/auth/sign-in/email',
			'POST /admin/usuarios',
			'POST /api/webhooks/resend'
		]);
	});
});
