import { describe, expect, test } from 'vitest';
import {
	API_MAX_ENTRIES,
	AUTOEQ_MAX_ENTRIES,
	cacheNames,
	canStorePublicResponse,
	evictionCount,
	isAnonymous,
	manifestUrl,
	mayApplyUpdate,
	obsoleteCaches,
	precacheUrls,
	requestStrategy,
	scopedPath
} from '#lib/pwa/strategy.ts';

const scope = 'https://open-auri.test/app/';
const asset = `${scope}_app/immutable/start.123.js`;
const shell = new Set([asset]);
const request = (path: string, init: RequestInit = {}) => new Request(new URL(path, scope), init);
const privateHeaders: Record<string, string>[] = [
	{ 'cache-control': 'private, max-age=60' },
	{ 'cache-control': 'public, no-store' },
	{ 'cache-control': 'PUBLIC, PRIVATE="set-cookie"' },
	{ 'set-cookie': 'session=x' },
	{ vary: 'Accept-Encoding, Cookie' },
	{ vary: 'Authorization, Accept' },
	{ vary: '*' }
];

describe('build-versioned precache', () => {
	test('isolates all caches by build and deletes only obsolete app-owned caches', () => {
		const old = Object.values(cacheNames('one'));
		const current = Object.values(cacheNames('two'));
		expect(new Set([...old, ...current]).size).toBe(6);
		expect(obsoleteCaches([...old, ...current, 'other-app', 'open-auri'], 'two')).toEqual(old);
	});

	test('resolves Kit 3 manifest paths against the deployment base and deduplicates them', () => {
		expect(manifestUrl('/offline', scope)).toBe(`${scope}offline`);
		expect(manifestUrl('', scope)).toBe(scope);
		expect(
			precacheUrls(
				[
					{ path: '/' },
					{ path: 'offline' },
					{ path: '/offline' },
					{ path: '_app/immutable/start.123.js' },
					{ path: '_app/immutable/style.123.css' },
					{ path: 'fonts/geist.woff2' },
					{ path: '/biblioteca' },
					{ path: '/data/autoeq/pack.bin' },
					{ path: '/api/me' },
					{ path: '/auth/callback' },
					{ path: '/account' },
					{ path: 'https://external.test/file' }
				],
				scope
			)
		).toEqual([
			scope,
			`${scope}offline`,
			asset,
			`${scope}_app/immutable/style.123.css`,
			`${scope}fonts/geist.woff2`,
			`${scope}biblioteca`
		]);
	});

	test('rejects other origins and adjacent base paths', () => {
		expect(scopedPath(new URL(`${scope}api/me`), scope)).toBe('/api/me');
		expect(scopedPath(new URL('https://open-auri.test/application/a'), scope)).toBeNull();
		expect(scopedPath(new URL('https://elsewhere.test/app/a'), scope)).toBeNull();
	});
});

describe('request routing', () => {
	test('uses network-first API, cache-first AutoEq, and only manifest-listed assets', () => {
		expect(requestStrategy(request('api/catalog'), scope, shell)).toBe('api-network-first');
		expect(requestStrategy(request('api'), scope, shell)).toBe('api-network-first');
		expect(requestStrategy(request('data/autoeq/pack.bin'), scope, shell)).toBe(
			'autoeq-cache-first'
		);
		expect(requestStrategy(new Request(asset), scope, shell)).toBe('precache');
		expect(requestStrategy(request('unlisted.js'), scope, shell)).toBe('network-only');
		expect(requestStrategy(request('apiary'), scope, shell)).toBe('network-only');
		expect(requestStrategy(request('data/autoeq-other/pack.bin'), scope, shell)).toBe(
			'network-only'
		);
	});

	test('routes navigation to a shell fallback without caching its network response', () => {
		const navigation = {
			method: 'GET',
			url: scope,
			headers: new Headers(),
			mode: 'navigate' as const
		};
		expect(requestStrategy(navigation, scope, shell)).toBe('navigation');
	});

	test.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])('never caches %s', (method) => {
		for (const path of ['api/catalog', 'data/autoeq/pack.bin', '_app/immutable/start.123.js']) {
			expect(requestStrategy(request(path, { method }), scope, shell)).toBe('network-only');
		}
	});

	test.each(['authorization', 'cookie', 'range'])('bypasses caches for %s', (header) => {
		expect(
			requestStrategy(request('api/catalog', { headers: { [header]: 'present' } }), scope, shell)
		).toBe('network-only');
	});

	test('does not intercept cross-origin or private routes', () => {
		for (const path of ['auth/callback', 'account', 'profile/me', 'admin', 'login', 'logout']) {
			expect(requestStrategy(request(path), scope, shell)).toBe('network-only');
		}
		expect(requestStrategy(new Request('https://other.test/api/x'), scope, shell)).toBe(
			'network-only'
		);
	});

	test('never intercepts, caches or precaches the Simple Analytics script and beacons', () => {
		const script = 'https://scripts.simpleanalyticscdn.com/latest.js';
		const beacons = [
			'https://queue.simpleanalyticscdn.com/simple.gif?type=pageview',
			'https://queue.simpleanalyticscdn.com/events'
		];
		// Even if the URL somehow reached the precache list, cross-origin stays network-only.
		const listed = new Set([...shell, script]);
		for (const url of [script, ...beacons]) {
			expect(requestStrategy(new Request(url), scope, listed), url).toBe('network-only');
			expect(requestStrategy(new Request(url, { method: 'POST' }), scope, listed), url).toBe(
				'network-only'
			);
		}
		const entries = [script, ...beacons].map((path) => ({ path }));
		expect(precacheUrls(entries, scope)).toEqual([]);
	});
});

describe('public-only cache admission', () => {
	test('requires explicit omission of credentials, even without visible cookies', () => {
		expect(isAnonymous(request('api/public'))).toBe(false);
		expect(isAnonymous(request('api/public', { credentials: 'include' }))).toBe(false);
		expect(isAnonymous(request('api/public', { credentials: 'omit' }))).toBe(true);
		expect(
			isAnonymous(
				request('api/public', { credentials: 'omit', headers: { authorization: 'Bearer x' } })
			)
		).toBe(false);
		expect(
			isAnonymous(request('api/public', { credentials: 'omit', headers: { cookie: 'session=x' } }))
		).toBe(false);
		expect(isAnonymous(request('api/public', { credentials: 'omit', method: 'POST' }))).toBe(false);
	});

	test('requires an explicit public cache directive for anonymous API responses', () => {
		expect(canStorePublicResponse(new Response('asset'))).toBe(true);
		expect(canStorePublicResponse(new Response('api'), true)).toBe(false);
		expect(
			canStorePublicResponse(
				new Response('api', { headers: { 'cache-control': 'public, max-age=60' } }),
				true
			)
		).toBe(true);
		// Revalidated build files can be precached by build version, but not used as API fallbacks.
		const revalidated = new Response('shell', { headers: { 'cache-control': 'public, no-cache' } });
		expect(canStorePublicResponse(revalidated)).toBe(true);
		expect(canStorePublicResponse(revalidated, true)).toBe(false);
	});

	test.each(privateHeaders)('rejects private response headers %j', (headers) => {
		expect(canStorePublicResponse(new Response('body', { headers }))).toBe(false);
	});

	test('rejects failed, opaque and redirected responses', () => {
		for (const status of [201, 206, 301, 401, 403, 404, 500, 503]) {
			expect(canStorePublicResponse(new Response('body', { status }))).toBe(false);
		}
		const opaque = new Response('body');
		Object.defineProperty(opaque, 'type', { value: 'opaque' });
		expect(canStorePublicResponse(opaque)).toBe(false);
		const redirected = new Response('body');
		Object.defineProperty(redirected, 'redirected', { value: true });
		expect(canStorePublicResponse(redirected)).toBe(false);
	});
});

describe('bounds and safe update policy', () => {
	test('evicts oldest entries only above the runtime bound', () => {
		expect(AUTOEQ_MAX_ENTRIES).toBe(32);
		expect(API_MAX_ENTRIES).toBe(32);
		expect(evictionCount(31, AUTOEQ_MAX_ENTRIES)).toBe(0);
		expect(evictionCount(32, AUTOEQ_MAX_ENTRIES)).toBe(0);
		expect(evictionCount(35, AUTOEQ_MAX_ENTRIES)).toBe(3);
		expect(evictionCount(3, 0)).toBe(3);
		expect(evictionCount(3, Number.POSITIVE_INFINITY)).toBe(0);
	});

	test('refuses both activation and reload while the cable write flag is set', () => {
		expect(mayApplyUpdate(true)).toBe(false);
		expect(mayApplyUpdate(false)).toBe(true);
		expect(mayApplyUpdate(undefined)).toBe(true);
	});
});
