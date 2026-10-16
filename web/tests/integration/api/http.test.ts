// T4.1b: JSON responses, bounded body parsing with zod, same-origin check (http.ts).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	assertSameOrigin,
	CACHE_PUBLIC_60,
	DEFAULT_MAX_BYTES,
	json,
	readJson,
	UNSAFE_METHODS
} from '#lib/server/api/index.ts';
import { expectApiError } from './helpers.ts';

const URL_ = 'https://auri.example/api/v1/x';
const Body = z.object({ name: z.string().min(2), tags: z.array(z.string()).max(2) });

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
	return new Request(URL_, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body
	});
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		}
	});
}

describe('json', () => {
	it('serialises with the JSON content type and private no-store by default', async () => {
		const response = json({ ok: true }, { status: 201 });
		expect(response.status).toBe(201);
		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(await response.json()).toEqual({ ok: true });
	});

	it('keeps a given cache-control and other headers', () => {
		const response = json([1], { headers: { 'cache-control': CACHE_PUBLIC_60, vary: 'cookie' } });
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe(CACHE_PUBLIC_60);
		expect(response.headers.get('vary')).toBe('cookie');
	});
});

describe('readJson', () => {
	it('returns the typed, parsed body (content type parameters allowed)', async () => {
		const data = await readJson(
			post('{"name":"abc","tags":["x"]}', { 'content-type': 'Application/JSON; charset=utf-8' }),
			Body
		);
		expect(data).toEqual({ name: 'abc', tags: ['x'] });
		expect(DEFAULT_MAX_BYTES).toBe(16_384);
	});

	it('415 UNSUPPORTED_MEDIA_TYPE without application/json', async () => {
		await expectApiError(
			() => readJson(new Request(URL_, { method: 'POST', body: '{}' }), Body),
			415,
			'UNSUPPORTED_MEDIA_TYPE'
		);
		await expectApiError(
			() => readJson(post('{}', { 'content-type': 'text/plain' }), Body),
			415,
			'UNSUPPORTED_MEDIA_TYPE'
		);
		await expectApiError(
			() => readJson(post('{}', { 'content-type': 'application/json-patch+json' }), Body),
			415,
			'UNSUPPORTED_MEDIA_TYPE'
		);
	});

	it('413 PAYLOAD_TOO_LARGE from Content-Length or while streaming', async () => {
		const big = JSON.stringify({ name: 'x'.repeat(DEFAULT_MAX_BYTES), tags: [] });
		await expectApiError(() => readJson(post(big), Body), 413, 'PAYLOAD_TOO_LARGE');
		await expectApiError(
			() => readJson(post('{"name":"abcdef","tags":[]}'), Body, { maxBytes: 10 }),
			413,
			'PAYLOAD_TOO_LARGE'
		);
		// No Content-Length: counted chunk by chunk.
		const streamed = post(streamOf(['{"name":"', 'a'.repeat(30), '","tags":[]}']));
		await expectApiError(
			() => readJson(streamed, Body, { maxBytes: 20 }),
			413,
			'PAYLOAD_TOO_LARGE'
		);
		const fits = post(streamOf(['{"name":"', 'ab', '","tags":[]}']));
		expect(await readJson(fits, Body, { maxBytes: 64 })).toEqual({ name: 'ab', tags: [] });
	});

	it('400 INVALID_BODY without details for empty, malformed or non-UTF-8 bodies', async () => {
		for (const body of [null, '', '{"name":', 'not json', new Uint8Array([0x7b, 0xff, 0x7d])]) {
			const error = await expectApiError(() => readJson(post(body), Body), 400, 'INVALID_BODY');
			expect(error.details).toBeUndefined();
		}
	});

	it('400 INVALID_BODY with { path, code } issues and no echo of the input', async () => {
		const secret = 'secret-user-input-1234';
		const error = await expectApiError(
			() => readJson(post(JSON.stringify({ name: 1, tags: [secret, 'b', 'c'], x: secret })), Body),
			400,
			'INVALID_BODY'
		);
		expect(error.details).toEqual({
			issues: [
				{ path: ['name'], code: 'invalid_type' },
				{ path: ['tags'], code: 'too_big' }
			]
		});
		expect(JSON.stringify(error.details)).not.toContain(secret);

		const nested = await expectApiError(
			() => readJson(post('{"name":"ok","tags":[5]}'), Body),
			400,
			'INVALID_BODY'
		);
		expect(nested.details).toEqual({ issues: [{ path: ['tags', 0], code: 'invalid_type' }] });
	});
});

describe('assertSameOrigin', () => {
	const canonical = 'https://auri.example';

	function req(method: string, origin?: string): Request {
		return new Request(URL_, { method, headers: origin === undefined ? {} : { origin } });
	}

	it('ignores safe methods', () => {
		expect(UNSAFE_METHODS).toEqual(new Set(['POST', 'PUT', 'PATCH', 'DELETE']));
		expect(() => assertSameOrigin(req('GET'), canonical)).not.toThrow();
		expect(() => assertSameOrigin(req('HEAD', 'https://evil.example'), canonical)).not.toThrow();
		expect(() => assertSameOrigin(req('OPTIONS'), canonical)).not.toThrow();
	});

	it('accepts the canonical origin on every unsafe method', () => {
		for (const method of UNSAFE_METHODS) {
			expect(() => assertSameOrigin(req(method, canonical), canonical)).not.toThrow();
		}
	});

	it('403 BAD_ORIGIN for missing, null or foreign origins', async () => {
		for (const method of UNSAFE_METHODS) {
			await expectApiError(() => assertSameOrigin(req(method), canonical), 403, 'BAD_ORIGIN');
		}
		for (const origin of [
			'null',
			'https://evil.example',
			'http://auri.example',
			'https://auri.example:8443',
			'https://sub.auri.example',
			'http://localhost:5173',
			'garbage'
		]) {
			await expectApiError(
				() => assertSameOrigin(req('POST', origin), canonical),
				403,
				'BAD_ORIGIN'
			);
		}
	});

	it('accepts any http loopback origin only when the canonical origin is loopback', async () => {
		const local = 'http://localhost:4173';
		for (const origin of [
			local,
			'http://localhost:5173',
			'http://127.0.0.1:4174',
			'http://localhost'
		]) {
			expect(() => assertSameOrigin(req('POST', origin), local)).not.toThrow();
		}
		for (const origin of [
			'https://localhost:5173',
			'http://evil.example',
			'http://localhost:5173/x'
		]) {
			await expectApiError(() => assertSameOrigin(req('DELETE', origin), local), 403, 'BAD_ORIGIN');
		}
	});
});
