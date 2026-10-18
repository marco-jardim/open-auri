// T5.T "cabeçalhos": the security headers on every dynamic route class, through the pipeline of
// hooks.server.ts rebuilt from its real modules (./pipeline.ts) in front of real route modules:
//   HTML page (SvelteKit SSR shape), API JSON (feed and rankings, 200 and 304), errors (API JSON
//   404, OG 404 text, thrown 500), 503 READ_ONLY (JSON and HTML) and the canonical-host 301/421.
// The static files of Workers Static Assets get the same set from web/_headers (unit test
// tests/unit/server/security/headers.test.ts compares that file with renderStaticHeadersFile; the
// staging e2e reads them from the real edge).
import hooksSource from '../../../src/hooks.server.ts?raw';
import { describe, expect, it } from 'vitest';
import { READ_ONLY_CODE, READ_ONLY_HTML_CSP } from '#lib/server/admin/read-only.ts';
import { HOOK_ORDER } from '#lib/server/auth/compose.ts';
import {
	FRAME_ANCESTORS_POLICY,
	HSTS,
	NON_HTML_CSP,
	PERMISSIONS_POLICY
} from '#lib/server/security/headers.ts';
import { errorCode, invoke, missingId } from '../phase4/helpers.ts';
import {
	eventAt,
	eventFor,
	KIT_POLICY,
	kitPage,
	ORIGIN,
	settled,
	through,
	type PipelineEvent
} from './pipeline.ts';

const OFF = { readOnly: false } as const;
const ON = { readOnly: true } as const;

function expectBaseline(response: Response, label: string): void {
	const headers = response.headers;
	expect(headers.get('x-content-type-options'), label).toBe('nosniff');
	expect(headers.get('x-frame-options'), label).toBe('DENY');
	expect(headers.get('referrer-policy'), label).toBe('strict-origin-when-cross-origin');
	expect(headers.get('permissions-policy'), label).toBe(PERMISSIONS_POLICY);
	expect(headers.get('permissions-policy'), label).toContain('hid=(self)');
	expect(headers.get('cross-origin-opener-policy'), label).toBe('same-origin');
	expect(headers.get('cross-origin-resource-policy'), label).toBe('same-origin');
	if (new URL(ORIGIN).protocol === 'https:') {
		expect(headers.get('strict-transport-security'), label).toBe(HSTS);
	} else {
		// Plain-http PUBLIC_ORIGIN (local): HSTS is omitted on purpose (headers.ts).
		expect(headers.get('strict-transport-security'), label).toBeNull();
	}
	expect(headers.get('content-security-policy') ?? '', label).toContain(FRAME_ANCESTORS_POLICY);
}

function expectLockedDown(response: Response, label: string): void {
	expectBaseline(response, label);
	expect(response.headers.get('content-security-policy'), label).toBe(NON_HTML_CSP);
}

async function route(path: string): Promise<unknown> {
	return import(/* @vite-ignore */ `../../../src/routes/${path}/+server.ts`);
}

function endpoint(module: unknown) {
	return (event: PipelineEvent) => invoke(module, 'GET', event);
}

describe('the pipeline mirrors hooks.server.ts', () => {
	it('same steps in the same order as the real handle', () => {
		expect(hooksSource).toMatch(
			/export const handle: Handle = sequence\(\s*platformShim,\s*canonicalHost,\s*requestLog,\s*analytics,\s*\.\.\.orderedHandles\(\{ readOnly, paraglide, auth, securityHeaders, accessLog \}\)\s*\);/
		);
		expect(HOOK_ORDER).toEqual(['readOnly', 'paraglide', 'auth', 'securityHeaders', 'accessLog']);
		// The 503 gets the same header function as every other response.
		expect(hooksSource).toMatch(
			/finish: \(event, response\) => withSecurityHeaders\(event, recordAccess\(event, response\)\)/
		);
		expect(hooksSource).toMatch(
			/applySecurityHeaders\(response, \{ origin: getServerEnv\(event\.platform\)\.publicOrigin \}\)/
		);
	});
});

describe('security headers on every dynamic route class', () => {
	it('HTML page: Kit keeps its nonce policy, frame-ancestors is added, the baseline is set', async () => {
		const response = await through(OFF, eventFor('/entrar', { routeId: '/entrar' }), () =>
			kitPage()
		);
		expect(response.status).toBe(200);
		expectBaseline(response, 'html');
		const csp = response.headers.get('content-security-policy') ?? '';
		expect(csp).toContain(KIT_POLICY);
		expect(csp).not.toMatch(/script-src[^;,]*'unsafe-inline'/);
		// An HTML error page (Kit renders /c/<unknown> 404 with the same layout and policy).
		const missing = await through(OFF, eventFor('/c/x', { routeId: '/c/[id]' }), () =>
			kitPage('<!doctype html><title>404</title>', 404)
		);
		expect(missing.status).toBe(404);
		expectBaseline(missing, 'html 404');
	});

	it('API JSON: GET /api/v1/feed and /api/v1/rankings, 200 with ETag and 304, all locked down', async () => {
		for (const id of ['feed', 'rankings']) {
			const module = await route(`api/v1/${id}`);
			const first = await through(
				OFF,
				eventFor(`/api/v1/${id}`, { routeId: `/api/v1/${id}` }),
				endpoint(module)
			);
			expect(first.status, id).toBe(200);
			expect(first.headers.get('content-type'), id).toContain('application/json');
			expectLockedDown(first, id);
			const etag = first.headers.get('etag') ?? '';
			expect(etag, id).toMatch(/^"[A-Za-z0-9_-]+"$/);

			const again = await through(
				OFF,
				eventFor(`/api/v1/${id}`, {
					routeId: `/api/v1/${id}`,
					headers: { 'if-none-match': etag }
				}),
				endpoint(module)
			);
			// The D1 database is shared with other files: a write in between changes the body.
			if (again.status === 200) expect(again.headers.get('etag')).not.toBe(etag);
			else expect(again.status, id).toBe(304);
			expectLockedDown(again, `${id} revalidation`);
		}
	});

	it('errors: API JSON 404, OG 404 and an endpoint 500 are locked down too', async () => {
		const id = missingId();
		const curve = await through(
			OFF,
			eventFor(`/api/v1/curves/${id}`, { routeId: '/api/v1/curves/[id]', params: { id } }),
			endpoint(await route('api/v1/curves/[id]'))
		);
		expect(curve.status).toBe(404);
		expect(await errorCode(curve)).toBe('NOT_FOUND');
		expectLockedDown(curve, 'api 404');

		const og = await import('../../../src/routes/og/[id].png/+server.ts');
		const image = await through(
			OFF,
			eventFor(`/og/${id}.png`, { routeId: '/og/[id].png', params: { id } }),
			endpoint(og)
		);
		expect(image.status).toBe(404);
		expectLockedDown(image, 'og 404');

		const crash = await through(OFF, eventFor('/api/v1/feed', { routeId: '/api/v1/feed' }), () =>
			Response.json({ error: { code: 'INTERNAL' } }, { status: 500 })
		);
		expect(crash.status).toBe(500);
		expectLockedDown(crash, '500');
		await settled();
	});

	it('503 READ_ONLY: JSON for API writes, static HTML for navigations, both with the headers', async () => {
		const reached: string[] = [];
		const never = (event: PipelineEvent) => {
			reached.push(event.url.pathname);
			return new Response('reached');
		};
		const json = await through(
			ON,
			eventFor('/api/v1/curves', { method: 'POST', routeId: '/api/v1/curves', body: {} }),
			never
		);
		expect(json.status).toBe(503);
		expect(json.headers.get('x-error-code')).toBe(READ_ONLY_CODE);
		expect(json.headers.get('retry-after')).not.toBeNull();
		expect(json.headers.get('cache-control')).toBe('no-store');
		expectLockedDown(json, '503 json');

		const page = await through(
			ON,
			eventFor('/conta', {
				method: 'POST',
				routeId: '/conta',
				headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' }
			}),
			never
		);
		expect(page.status).toBe(503);
		expect(page.headers.get('content-type')).toContain('text/html');
		expectBaseline(page, '503 html');
		// Its own policy (it loads nothing) already has frame-ancestors: kept, not duplicated.
		expect(page.headers.get('content-security-policy')).toBe(READ_ONLY_HTML_CSP);
		expect(await page.text()).toContain(`data-code="${READ_ONLY_CODE}"`);
		expect(reached).toEqual([]);
	});

	it('canonical host: 301 (GET) and 421 (POST) from *.workers.dev, before every other step', async () => {
		const canonical = { readOnly: true, canonicalOrigin: 'https://open-auri.example' } as const;
		const reached: string[] = [];
		const never = (event: PipelineEvent) => {
			reached.push(event.url.pathname);
			return new Response('reached');
		};
		const workersDev = 'https://open-auri.example-sub.workers.dev';
		const moved = await through(
			canonical,
			eventAt(`${workersDev}/c/abcdefgh12?s=share1`, { routeId: '/c/[id]' }),
			never
		);
		expect(moved.status).toBe(301);
		expect(moved.headers.get('location')).toBe('https://open-auri.example/c/abcdefgh12?s=share1');
		expect(moved.headers.get('cache-control')).toBe('no-store');
		// By design (canonical-host.ts header: it runs before the request log and the header
		// step) the bodiless 301/421 carry no security headers; the whole .dev TLD is on the
		// browsers' HSTS preload list, so the redirect is always reached over HTTPS anyway.
		expect(moved.headers.get('content-security-policy')).toBeNull();
		expect(await moved.text()).toBe('');

		const write = await through(
			canonical,
			eventAt(`${workersDev}/api/v1/curves`, { method: 'POST', routeId: '/api/v1/curves' }),
			never
		);
		// 421 even with the read-only switch on: the canonical host runs first.
		expect(write.status).toBe(421);
		expect(reached).toEqual([]);

		// The canonical host itself and staging-like origins pass through to the next steps.
		const served = await through(
			{ readOnly: false, canonicalOrigin: 'https://open-auri.example' },
			eventAt('https://open-auri.example/entrar', { routeId: '/entrar' }),
			() => kitPage()
		);
		expect(served.status).toBe(200);
		expectBaseline(served, 'canonical host');
	});
});
