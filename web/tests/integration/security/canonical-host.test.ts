// T5.4b: production `*.workers.dev` traffic goes to the custom domain; staging and local dev
// are untouched. Driven through the module hooks.server.ts composes (that file imports `$app/*`).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	canonicalHostResponse,
	createCanonicalHostHandle,
	isCustomDomainOrigin
} from '#lib/server/security/canonical-host.ts';

const PRODUCTION = 'https://open-auri.com';
const PROD_WORKERS_DEV = 'https://open-auri.example-sub.workers.dev';
const STAGING = 'https://open-auri-staging.example-sub.workers.dev';
const LOCAL = 'http://localhost:5173';

function platformWith(publicOrigin: string) {
	// EMAIL_TRANSPORT pinned: `capture` (if the test config used it) is refused off localhost.
	return {
		env: { ...env, PUBLIC_ORIGIN: publicOrigin, EMAIL_TRANSPORT: 'resend' },
		ctx: { waitUntil: () => undefined }
	};
}

/** Runs the handle with the real getServerEnv; `resolved` records whether the app was reached. */
async function through(
	request: Request,
	platform: ReturnType<typeof platformWith> | undefined,
	building = false
) {
	const handle = createCanonicalHostHandle({ building });
	let resolved = false;
	const response = await handle({
		event: { request, platform, url: new URL(request.url) } as never,
		resolve: (async () => {
			resolved = true;
			return new Response('app', { status: 200 });
		}) as never
	});
	return { response, resolved };
}

describe('isCustomDomainOrigin', () => {
	it('is true only for a non-workers.dev, non-loopback origin', () => {
		expect(isCustomDomainOrigin(PRODUCTION)).toBe(true);
		expect(isCustomDomainOrigin(STAGING)).toBe(false);
		expect(isCustomDomainOrigin('https://WORKERS.DEV')).toBe(false);
		expect(isCustomDomainOrigin(LOCAL)).toBe(false);
		expect(isCustomDomainOrigin('http://127.0.0.1:4174')).toBe(false);
		expect(isCustomDomainOrigin('not a url')).toBe(false);
	});
});

describe('canonical host on a production (custom domain) PUBLIC_ORIGIN', () => {
	it('answers 301 to the same path and query on PUBLIC_ORIGIN for GET', async () => {
		const request = new Request(`${PROD_WORKERS_DEV}/curva/abc?lang=en&x=1`);
		const { response, resolved } = await through(request, platformWith(PRODUCTION));
		expect(resolved).toBe(false);
		expect(response.status).toBe(301);
		expect(response.headers.get('location')).toBe(`${PRODUCTION}/curva/abc?lang=en&x=1`);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.body).toBeNull();
	});

	it('redirects HEAD and the bare root', async () => {
		const head = await through(
			new Request(`${PROD_WORKERS_DEV}/`, { method: 'HEAD' }),
			platformWith(PRODUCTION)
		);
		expect(head.response.status).toBe(301);
		expect(head.response.headers.get('location')).toBe(`${PRODUCTION}/`);
		expect(head.resolved).toBe(false);
	});

	it('answers 421 with no body to writes (no redirect of a request body)', async () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
			const request = new Request(`${PROD_WORKERS_DEV}/api/auth/sign-in/email`, {
				method,
				body: method === 'OPTIONS' ? null : '{}'
			});
			const { response, resolved } = await through(request, platformWith(PRODUCTION));
			expect(response.status, method).toBe(421);
			expect(response.headers.has('location'), method).toBe(false);
			expect(response.headers.get('cache-control'), method).toBe('no-store');
			expect(await response.text(), method).toBe('');
			expect(resolved, method).toBe(false);
		}
	});

	it('serves the custom domain itself and non-workers.dev hosts unchanged', async () => {
		const urls = [`${PRODUCTION}/curva/abc`, 'https://OPEN-AURI.com/', 'https://other.example/'];
		for (const url of urls) {
			const { response, resolved } = await through(new Request(url), platformWith(PRODUCTION));
			expect(resolved, url).toBe(true);
			expect(response.status, url).toBe(200);
		}
		const post = await through(
			new Request(`${PRODUCTION}/api/auth/sign-in/email`, { method: 'POST', body: '{}' }),
			platformWith(PRODUCTION)
		);
		expect(post.resolved).toBe(true);
	});
});

describe('canonical host stays out of staging, local dev and prerendering', () => {
	it('leaves staging alone (PUBLIC_ORIGIN on workers.dev), even from another workers.dev host', async () => {
		for (const url of [`${STAGING}/curva/abc`, `${PROD_WORKERS_DEV}/curva/abc`]) {
			const { response, resolved } = await through(new Request(url), platformWith(STAGING));
			expect(resolved, url).toBe(true);
			expect(response.status, url).toBe(200);
		}
	});

	it('leaves local dev alone (loopback PUBLIC_ORIGIN)', async () => {
		const { resolved } = await through(
			new Request(`${PROD_WORKERS_DEV}/`),
			platformWith('http://localhost:4174')
		);
		expect(resolved).toBe(true);
	});

	it('steps aside while building or without a platform', async () => {
		const request = new Request(`${PROD_WORKERS_DEV}/`);
		expect((await through(request, platformWith(PRODUCTION), true)).resolved).toBe(true);
		expect((await through(request, undefined)).resolved).toBe(true);
	});

	it('canonicalHostResponse is null whenever the request passes through', () => {
		expect(canonicalHostResponse(new Request(`${PRODUCTION}/`), PRODUCTION)).toBeNull();
		expect(canonicalHostResponse(new Request(`${STAGING}/`), STAGING)).toBeNull();
		expect(canonicalHostResponse(new Request(`${PROD_WORKERS_DEV}/`), LOCAL)).toBeNull();
	});
});
