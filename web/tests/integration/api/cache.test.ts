// T4.1b: ETag / If-None-Match / Cache-Control helpers (cache.ts).
import { describe, expect, it } from 'vitest';
import {
	cached,
	CACHE_IMMUTABLE,
	CACHE_PRIVATE_NO_STORE,
	CACHE_PUBLIC_60,
	ifNoneMatch,
	strongEtag
} from '#lib/server/api/index.ts';

const URL_ = 'https://api.example/api/v1/x';

function get(ifNone?: string, method = 'GET'): Request {
	return new Request(URL_, {
		method,
		headers: ifNone === undefined ? {} : { 'if-none-match': ifNone }
	});
}

describe('presets', () => {
	it('has the documented values', () => {
		expect(CACHE_PUBLIC_60).toBe('public, max-age=60, s-maxage=60');
		expect(CACHE_IMMUTABLE).toBe('public, max-age=31536000, immutable');
		expect(CACHE_PRIVATE_NO_STORE).toBe('private, no-store');
	});
});

describe('strongEtag', () => {
	it('is a quoted base64url SHA-256, deterministic and byte-based', async () => {
		const a = await strongEtag('{"a":1}');
		expect(a).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
		expect(await strongEtag('{"a":1}')).toBe(a);
		expect(await strongEtag(await new Response('{"a":1}').arrayBuffer())).toBe(a);
		expect(await strongEtag('{"a":2}')).not.toBe(a);
		// SHA-256("") in base64url.
		expect(await strongEtag('')).toBe('"47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"');
	});
});

describe('ifNoneMatch', () => {
	const etag = '"abc"';

	it('does not match without the header or with other tags', () => {
		expect(ifNoneMatch(get(), etag)).toBe(false);
		expect(ifNoneMatch(get('"xyz"'), etag)).toBe(false);
		expect(ifNoneMatch(get('abc'), etag)).toBe(false);
		expect(ifNoneMatch(get(''), etag)).toBe(false);
	});

	it('matches exact tags, lists and *', () => {
		expect(ifNoneMatch(get('"abc"'), etag)).toBe(true);
		expect(ifNoneMatch(get('"x", "abc" ,"y"'), etag)).toBe(true);
		expect(ifNoneMatch(get('"x,y", "abc"'), etag)).toBe(true);
		expect(ifNoneMatch(get('*'), etag)).toBe(true);
	});

	it('uses the weak comparison on both sides', () => {
		expect(ifNoneMatch(get('W/"abc"'), etag)).toBe(true);
		expect(ifNoneMatch(get('"abc"'), 'W/"abc"')).toBe(true);
		expect(ifNoneMatch(get('W/"abc"'), 'W/"abc"')).toBe(true);
		expect(ifNoneMatch(get('W/"abd"'), 'W/"abc"')).toBe(false);
		expect(ifNoneMatch(get('"abc"'), 'not-quoted')).toBe(false);
	});
});

describe('cached', () => {
	const body = '{"items":[]}';

	it('answers 200 with body, ETag, Cache-Control and JSON content type', async () => {
		const response = await cached(get(), body, { cacheControl: CACHE_PUBLIC_60 });
		expect(response.status).toBe(200);
		expect(response.headers.get('etag')).toBe(await strongEtag(body));
		expect(response.headers.get('cache-control')).toBe(CACHE_PUBLIC_60);
		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(await response.text()).toBe(body);
	});

	it('answers 304 without a body when If-None-Match matches', async () => {
		const etag = await strongEtag(body);
		const response = await cached(get(`W/${etag}`), body, { cacheControl: CACHE_PUBLIC_60 });
		expect(response.status).toBe(304);
		expect(response.headers.get('etag')).toBe(etag);
		expect(response.headers.get('cache-control')).toBe(CACHE_PUBLIC_60);
		expect(response.headers.get('content-type')).toBeNull();
		expect(await response.text()).toBe('');
	});

	it('uses a given ETag, content type and headers; HEAD has no body', async () => {
		const bytes = await new Response('png').arrayBuffer();
		const response = await cached(get(undefined, 'HEAD'), bytes, {
			etag: '"v1"',
			cacheControl: CACHE_IMMUTABLE,
			contentType: 'image/png',
			headers: { vary: 'accept' }
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('etag')).toBe('"v1"');
		expect(response.headers.get('content-type')).toBe('image/png');
		expect(response.headers.get('vary')).toBe('accept');
		expect(await response.text()).toBe('');

		const notModified = await cached(get('"v1"', 'HEAD'), bytes, {
			etag: '"v1"',
			cacheControl: CACHE_IMMUTABLE
		});
		expect(notModified.status).toBe(304);
	});

	it('never answers 304 to unsafe methods', async () => {
		const response = await cached(get('*', 'POST'), body, { cacheControl: CACHE_PRIVATE_NO_STORE });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(body);
	});
});
