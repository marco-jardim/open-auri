import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerEnv } from '#lib/server/env.ts';
import { GET, HEAD, prerender } from '../../../src/routes/dados/dump/[file]/+server.ts';
import { expectErrorResponse, fakeBinding, ORIGIN, randomIp, signedOut } from '../api/helpers.ts';

const media = getServerEnv({ env }).media;
const LATEST = 'latest.json.gz';
const DATED = '2026-10-17.json.gz';
const PREFIX = 'public/dump/';

afterEach(async () => {
	await Promise.all([LATEST, DATED].map((file) => media.delete(`${PREFIX}${file}`)));
});

function harness(mode: 'allow' | 'deny' | 'throw' = 'allow') {
	const api = fakeBinding(mode);
	const get = vi.fn((key: string) => media.get(key));
	const head = vi.fn((key: string) => media.head(key));
	const platformEnv = {
		...env,
		RL_API: api,
		MEDIA: { get, head, put: media.put.bind(media), delete: media.delete.bind(media) }
	};
	const ip = randomIp();
	return {
		api,
		get,
		head,
		ip,
		request(file: string, method: 'GET' | 'HEAD' = 'GET', headers: Record<string, string> = {}) {
			const event = {
				request: new Request(`${ORIGIN}/dados/dump/${encodeURIComponent(file)}`, {
					method,
					headers: { 'cf-connecting-ip': ip, ...headers }
				}),
				params: { file },
				locals: signedOut(),
				platform: { env: platformEnv }
			};
			return (method === 'HEAD' ? HEAD : GET)(event as unknown as Parameters<typeof GET>[0]);
		}
	};
}

async function store(file: string) {
	const body = await new Response(
		new Blob([JSON.stringify({ format: 'open-auri-public-dump', lineages: [] })])
			.stream()
			.pipeThrough(new CompressionStream('gzip'))
	).arrayBuffer();
	const object = await media.put(`${PREFIX}${file}`, body, {
		httpMetadata: { contentType: 'application/gzip' }
	});
	if (!object) throw new Error('dump fixture was not stored');
	return { body, etag: object.httpEtag };
}

describe('public GET/HEAD /dados/dump/[file]', () => {
	it.each([
		'backups/x',
		'..%2F',
		'../latest.json.gz',
		'..\\latest.json.gz',
		'%2e%2e%2flatest.json.gz',
		'public/dump/latest.json.gz',
		'og/x.png',
		'latest.json',
		'LATEST.json.gz',
		'2026-1-17.json.gz',
		'latest.json.gz/../backups/x',
		'latest.json.gz%00',
		'latest.json.gz\n',
		'latest.json.gz\r\n',
		''
	])('refuses %j before any R2 read', async (file) => {
		const route = harness();
		for (const method of ['GET', 'HEAD'] as const) {
			const response = await route.request(file, method);
			expect(response.status).toBe(404);
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
		expect(route.get).not.toHaveBeenCalled();
		expect(route.head).not.toHaveBeenCalled();
	});

	it.each([
		[LATEST, 'public, max-age=3600'],
		[DATED, 'public, max-age=31536000, immutable']
	])('streams %s with download/cache headers and bodyless HEAD', async (file, cache) => {
		const stored = await store(file);
		const route = harness();
		const response = await route.request(file, 'GET', { 'if-none-match': '"stale"' });
		expect(prerender).toBe(false);
		expect(response.status).toBe(200);
		expect(response.body).not.toBeNull();
		expect(response.headers.get('content-type')).toBe('application/gzip');
		expect(response.headers.get('content-encoding')).toBeNull();
		expect(response.headers.get('content-disposition')).toBe(
			`attachment; filename="open-auri-dump-${file}"`
		);
		expect(response.headers.get('etag')).toBe(stored.etag);
		expect(response.headers.get('cache-control')).toBe(cache);
		expect(await response.arrayBuffer()).toEqual(stored.body);
		expect(route.get).toHaveBeenCalledExactlyOnceWith(`${PREFIX}${file}`);

		const head = await route.request(file, 'HEAD');
		expect(head.status).toBe(200);
		expect([...head.headers]).toEqual([...response.headers]);
		expect(head.body).toBeNull();
		expect(await head.text()).toBe('');
		expect(route.head).toHaveBeenCalledExactlyOnceWith(`${PREFIX}${file}`);
		expect(route.get).toHaveBeenCalledTimes(1);
		expect(route.api.keys).toHaveLength(2);
		for (const key of route.api.keys) {
			expect(key).toMatch(/^ip:dump:[A-Za-z0-9_-]{43}$/);
			expect(key).not.toContain(route.ip);
		}
	});

	it.each(['GET', 'HEAD'] as const)('honors If-None-Match validators on %s', async (method) => {
		const stored = await store(LATEST);
		const route = harness();
		for (const validator of [stored.etag, `W/${stored.etag}`, `"other", ${stored.etag}`, '*']) {
			const response = await route.request(LATEST, method, { 'if-none-match': validator });
			expect(response.status).toBe(304);
			expect(response.body).toBeNull();
			expect(await response.text()).toBe('');
			expect(response.headers.get('etag')).toBe(stored.etag);
			expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
		}
		expect(route.api.keys).toHaveLength(4);
	});

	it.each(['GET', 'HEAD'] as const)('returns 404 for missing objects on %s', async (method) => {
		const file = '1901-02-03.json.gz';
		const route = harness();
		const response = await route.request(file, method, { 'if-none-match': '*' });
		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('etag')).toBeNull();
		expect(method === 'HEAD' ? route.head : route.get).toHaveBeenCalledExactlyOnceWith(
			`${PREFIX}${file}`
		);
	});

	it.each([
		['deny', 429, 'RATE_LIMITED'],
		['throw', 503, 'RATE_LIMIT_UNAVAILABLE']
	] as const)(
		'fails closed when the dump read limiter returns %s, before R2',
		async (mode, status, code) => {
			const route = harness(mode);
			const response = await route.request(LATEST);
			await expectErrorResponse(response, status, code);
			if (status === 429) expect(response.headers.get('retry-after')).toBe('60');
			const head = await route.request(LATEST, 'HEAD');
			expect(head.status).toBe(status);
			expect(head.body).toBeNull();
			expect(route.get).not.toHaveBeenCalled();
			expect(route.head).not.toHaveBeenCalled();
			expect(route.api.keys).toHaveLength(2);
		}
	);
});
