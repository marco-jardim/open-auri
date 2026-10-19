import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import routeMetadata from '../../../.svelte-kit/types/route_meta_data.json';
import { listAccountSessions } from '#lib/server/account/sessions.ts';
import { reduceUserAgent } from '#lib/server/auth/user-agent.ts';
import { HEAD, GET, prerender } from '../../../src/routes/.well-known/assetlinks.json/+server.ts';
import { seedSession, seedUser } from '../account/helpers.ts';
import { eventFor, through } from '../phase5/pipeline.ts';

const PATH = '/.well-known/assetlinks.json';
const FIRST = Array<string>(32).fill('AB').join(':');
const SECOND = Array<string>(32).fill('CD').join(':');

function request(overrides: Record<string, unknown>, method: 'GET' | 'HEAD' = 'GET') {
	const event = eventFor(PATH, {
		routeId: PATH,
		method,
		platformEnv: {
			...env,
			PUBLIC_ANDROID_APP_ID: undefined,
			PUBLIC_ANDROID_CERT_SHA256: undefined,
			...overrides
		}
	});
	return through({ readOnly: false }, event, (current) =>
		(method === 'HEAD' ? HEAD : GET)(current as unknown as Parameters<typeof GET>[0])
	);
}

function expectSecurityHeaders(response: Response) {
	expect(response.headers.get('x-content-type-options')).toBe('nosniff');
	expect(response.headers.get('x-frame-options')).toBe('DENY');
	expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
	expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
}

describe('GET/HEAD /.well-known/assetlinks.json (workerd)', () => {
	it('is discovered by SvelteKit in the dot-directory, without prerendering', () => {
		// This is Kit's generated route discovery metadata, not a hand-written route matcher.
		expect(Reflect.get(routeMetadata, PATH)).toContain(
			'src/routes/.well-known/assetlinks.json/+server.ts'
		);
		expect(prerender).toBe(false);
	});

	it('publishes exactly the verified App Links statement with caching and hook security headers', async () => {
		const response = await request({
			PUBLIC_ANDROID_APP_ID: 'com.openauri.app',
			PUBLIC_ANDROID_CERT_SHA256: `${FIRST}, ${SECOND} , ${FIRST}`
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([
			{
				relation: ['delegate_permission/common.handle_all_urls'],
				target: {
					namespace: 'android_app',
					package_name: 'com.openauri.app',
					sha256_cert_fingerprints: [FIRST, SECOND]
				}
			}
		]);
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
		expectSecurityHeaders(response);
	});

	it('answers HEAD with identical headers and no body', async () => {
		const config = {
			PUBLIC_ANDROID_APP_ID: 'com.example.app',
			PUBLIC_ANDROID_CERT_SHA256: FIRST
		};
		const get = await request(config);
		const head = await request(config, 'HEAD');
		expect(head.status).toBe(200);
		expect([...head.headers]).toEqual([...get.headers]);
		expect(head.body).toBeNull();
		expect(await head.text()).toBe('');
		expectSecurityHeaders(head);
	});

	it.each([
		{},
		{ PUBLIC_ANDROID_APP_ID: 'com.openauri.app', PUBLIC_ANDROID_CERT_SHA256: '' },
		{ PUBLIC_ANDROID_APP_ID: '', PUBLIC_ANDROID_CERT_SHA256: FIRST }
	])('returns 404 when App Links are not configured: %j', async (config) => {
		for (const method of ['GET', 'HEAD'] as const) {
			const response = await request(config, method);
			expect(response.status).toBe(404);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(await response.text()).toBe('');
			expectSecurityHeaders(response);
		}
	});
});

describe('Android session label (workerd)', () => {
	it.each([
		[' OpenAuriAndroid/1.2.3', 'App Android 1.2.3'],
		[' OpenAuriAndroid', 'App Android'],
		[' OpenAuriAndroid/invalid', 'App Android'],
		['', 'Chrome']
	])(
		'preserves the app label through storage and the account session parser: %s',
		async (suffix, browser) => {
			const user = await seedUser();
			const userAgent = reduceUserAgent(
				`Mozilla/5.0 (Linux; Android 15; wv) Chrome/141.0.0.0 Mobile Safari/537.36${suffix}`
			);
			const session = await seedSession(user.id, { userAgent });
			const sessions = await listAccountSessions(env.DB, user.id, session.id, Date.now());
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({ browser, os: 'Android', current: true });
		}
	);
});
