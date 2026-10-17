// The Worker entry wrapper (#33): the canonical-host decision of the hook, applied before the
// adapter's worker serves a prerendered page from Static Assets.
import { describe, expect, it } from 'vitest';
import { canonicalHostResponse } from '#lib/server/security/canonical-host.ts';
import {
	isBareOrigin,
	publicOriginOf,
	withCanonicalHost,
	type WorkerHandler
} from '../../../src/worker-entry/canonical-host.ts';

const CANONICAL = 'https://open-auri.example.org';
const WORKERS_DEV = 'https://open-auri.someone.workers.dev';
const PRODUCTION = { PUBLIC_ORIGIN: CANONICAL };
const CTX = { waitUntil: () => undefined };
/** Values getServerEnv refuses for PUBLIC_ORIGIN (src/lib/server/env.ts `isOrigin`). */
const INVALID_ORIGINS = [
	`${CANONICAL}/`,
	`${CANONICAL}/app`,
	`${CANONICAL}?x=1`,
	`${CANONICAL}#top`,
	` ${CANONICAL}`,
	'https://OPEN-AURI.example.org',
	'http://open-auri.example.org',
	'ftp://open-auri.example.org',
	'open-auri.example.org',
	'not a url'
];

function app() {
	const calls: { request: Request; env: unknown; ctx: unknown }[] = [];
	const scheduled = () => undefined;
	const handler = {
		fetch(request: Request, env: unknown, ctx: unknown): Response {
			calls.push({ request, env, ctx });
			return new Response('app', { status: 200 });
		},
		scheduled
	};
	return { handler, calls, scheduled };
}

async function call(handler: WorkerHandler, request: Request, env: unknown): Promise<Response> {
	if (!handler.fetch) throw new Error('handler without fetch');
	return handler.fetch(request, env, CTX);
}

describe('withCanonicalHost', () => {
	it('redirects a workers.dev page to the canonical origin, keeping path and query', async () => {
		const { handler, calls } = app();
		const wrapped = withCanonicalHost(handler);
		for (const path of ['/', '/docs', '/docs/?tab=eq&x=1', '/termos?a=%20b']) {
			const response = await call(wrapped, new Request(`${WORKERS_DEV}${path}`), PRODUCTION);
			expect(response.status, path).toBe(301);
			expect(response.headers.get('location'), path).toBe(`${CANONICAL}${path}`);
			expect(response.headers.get('cache-control'), path).toBe('no-store');
		}
		const head = await call(
			wrapped,
			new Request(`${WORKERS_DEV}/docs`, { method: 'HEAD' }),
			PRODUCTION
		);
		expect(head.status).toBe(301);
		expect(calls).toHaveLength(0);
	});

	it('answers 421 to a write on workers.dev, like the hook', async () => {
		const { handler, calls } = app();
		const response = await call(
			withCanonicalHost(handler),
			new Request(`${WORKERS_DEV}/api/auth/sign-in/email`, { method: 'POST', body: '{}' }),
			PRODUCTION
		);
		expect(response.status).toBe(421);
		expect(response.headers.get('location')).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it('passes the canonical host through with the same request, env and context', async () => {
		const { handler, calls } = app();
		const request = new Request(`${CANONICAL}/docs?x=1`);
		const response = await call(withCanonicalHost(handler), request, PRODUCTION);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('app');
		expect(calls).toEqual([{ request, env: PRODUCTION, ctx: CTX }]);
		expect(calls[0]?.request).toBe(request);
	});

	it('passes through when PUBLIC_ORIGIN is not configured', async () => {
		const { handler, calls } = app();
		const wrapped = withCanonicalHost(handler);
		const envs: unknown[] = [undefined, null, {}, { PUBLIC_ORIGIN: '' }, { PUBLIC_ORIGIN: 1 }];
		for (const env of envs) {
			const response = await call(wrapped, new Request(`${WORKERS_DEV}/docs`), env);
			expect(response.status, JSON.stringify(env)).toBe(200);
		}
		expect(calls).toHaveLength(envs.length);
	});

	it('passes through on a PUBLIC_ORIGIN the env schema refuses (the hook fails as before)', async () => {
		const { handler, calls } = app();
		const wrapped = withCanonicalHost(handler);
		for (const origin of INVALID_ORIGINS) {
			const env = { PUBLIC_ORIGIN: origin };
			const request = new Request(`${WORKERS_DEV}/docs`);
			// Without the guard the wrapper would 301 some of these, where the hook answers 500.
			const response = await call(wrapped, request, env);
			expect(response.status, origin).toBe(200);
			expect(response.headers.get('location'), origin).toBeNull();
			expect(calls.at(-1), origin).toEqual({ request, env, ctx: CTX });
		}
		expect(calls).toHaveLength(INVALID_ORIGINS.length);
		const write = await call(
			wrapped,
			new Request(`${WORKERS_DEV}/api/auth/sign-in/email`, { method: 'POST', body: '{}' }),
			{ PUBLIC_ORIGIN: `${CANONICAL}/` }
		);
		expect(write.status).toBe(200);
	});

	it('passes through for loopback and workers.dev origins (dev, preview, e2e, staging)', async () => {
		const { handler, calls } = app();
		const wrapped = withCanonicalHost(handler);
		const cases = [
			['http://localhost:4173', 'http://localhost:4173/docs'],
			['http://127.0.0.1:8787', `${WORKERS_DEV}/docs`],
			[WORKERS_DEV, `${WORKERS_DEV}/docs`],
			['https://open-auri-staging.someone.workers.dev', `${WORKERS_DEV}/docs`]
		] as const;
		for (const [origin, url] of cases) {
			const response = await call(wrapped, new Request(url), { PUBLIC_ORIGIN: origin });
			expect(response.status, `${origin} ${url}`).toBe(200);
		}
		expect(calls).toHaveLength(cases.length);
	});

	it('makes the same decision as canonicalHostResponse', async () => {
		const { handler } = app();
		const wrapped = withCanonicalHost(handler);
		for (const url of [
			`${WORKERS_DEV}/biblioteca`,
			`${CANONICAL}/biblioteca`,
			'https://preview.example.net/biblioteca'
		]) {
			const expected = canonicalHostResponse(new Request(url), CANONICAL);
			const response = await call(wrapped, new Request(url), PRODUCTION);
			expect(response.status, url).toBe(expected?.status ?? 200);
			expect(response.headers.get('location'), url).toBe(expected?.headers.get('location') ?? null);
		}
	});

	it('keeps the other handlers and leaves a handler without fetch unchanged', () => {
		const { handler, scheduled } = app();
		const wrapped = withCanonicalHost(handler);
		expect(wrapped.scheduled).toBe(scheduled);
		expect(wrapped.fetch).not.toBe(handler.fetch);
		const queueOnly = { fetch: undefined, queue: () => undefined };
		expect(withCanonicalHost(queueOnly)).toBe(queueOnly);
	});
});

describe('isBareOrigin', () => {
	it('accepts what the env schema accepts and refuses the rest', () => {
		const valid = [
			CANONICAL,
			WORKERS_DEV,
			'https://example.org:8443',
			'http://localhost:4173',
			'http://127.0.0.1:8787'
		];
		for (const origin of valid) expect(isBareOrigin(origin), origin).toBe(true);
		for (const origin of [...INVALID_ORIGINS, '']) {
			expect(isBareOrigin(origin), origin).toBe(false);
		}
	});
});

describe('publicOriginOf', () => {
	it('answers empty for a PUBLIC_ORIGIN that is not a bare origin', () => {
		for (const origin of INVALID_ORIGINS) {
			expect(publicOriginOf({ PUBLIC_ORIGIN: origin }), origin).toBe('');
		}
	});

	it('reads PUBLIC_ORIGIN when it is a string and answers empty otherwise', () => {
		expect(publicOriginOf({ PUBLIC_ORIGIN: CANONICAL })).toBe(CANONICAL);
		const unset: unknown[] = [
			undefined,
			null,
			'x',
			{},
			{ PUBLIC_ORIGIN: undefined },
			{ PUBLIC_ORIGIN: 1 }
		];
		for (const env of unset) expect(publicOriginOf(env)).toBe('');
	});
});
