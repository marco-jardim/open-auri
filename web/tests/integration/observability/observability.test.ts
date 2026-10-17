// T5.2: PII-free request log line and the fixed Analytics Engine schema (no-op without METRICS).
import type { Handle } from '@sveltejs/kit/hooks';
import { describe, expect, it, vi } from 'vitest';
import {
	createRequestLogHandle,
	errorCodeOf,
	isMetricsDataset,
	LABEL_MAX,
	METRIC_EVENTS,
	metricLabel,
	metricPoint,
	metricsFromEnv,
	recordEmailFailure,
	recordGateRejection,
	recordJobRun,
	recordReport,
	recordServerError,
	recordSignup,
	requestId,
	type RequestLogLine
} from '#lib/server/observability/index.ts';
import { fakeMetrics } from './helpers.ts';

const SECRET_TOKEN = 'tok_9f8e7d6c5b4a3210';
const EMAIL = 'pessoa@example.com';
const IP = '203.0.113.77';
const UA = 'Mozilla/5.0 (fixture-agent)';

function hookEvent(init: { url: string; routeId: string | null; method?: string; ray?: string }) {
	const headers = new Headers({
		'cf-connecting-ip': IP,
		'user-agent': UA,
		cookie: `session=${SECRET_TOKEN}`,
		authorization: `Bearer ${SECRET_TOKEN}`
	});
	if (init.ray) headers.set('cf-ray', init.ray);
	return {
		request: new Request(init.url, { method: init.method ?? 'GET', headers }),
		route: { id: init.routeId },
		locals: { user: { id: 'user-id-123', email: EMAIL }, session: null }
	} as never;
}

async function run(
	handle: Handle,
	event: never,
	resolve: () => Response | Promise<Response>
): Promise<Response> {
	return handle({ event, resolve: async () => resolve() } as never);
}

describe('requestLog', () => {
	it('writes one line with id, route id, method, status, latency and error code only', async () => {
		const lines: RequestLogLine[] = [];
		let clock = 1_000;
		const handle = createRequestLogHandle({ write: (line) => lines.push(line), now: () => clock });
		const event = hookEvent({
			url: `https://example.org/api/v1/curves/abc123?token=${SECRET_TOKEN}&email=${EMAIL}`,
			routeId: '/api/v1/curves/[id]',
			ray: '8f1e2d3c4b5a6978-GRU'
		});
		const response = await run(handle, event, () => {
			clock += 42;
			return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
		});
		expect(response.status).toBe(404);
		expect(lines).toEqual([
			{
				event: 'http.request',
				id: '8f1e2d3c4b5a6978-GRU',
				route: '/api/v1/curves/[id]',
				method: 'GET',
				status: 404,
				ms: 42,
				code: 'NOT_FOUND'
			}
		]);
		// The body is still readable by the client.
		expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND' } });
		const text = JSON.stringify(lines);
		for (const leak of [SECRET_TOKEN, EMAIL, IP, UA, 'user-id-123', 'abc123', '?', 'example.org']) {
			expect(text).not.toContain(leak);
		}
	});

	it('uses a random id when cf-ray is absent or malformed, and marks unmatched routes', async () => {
		const lines: RequestLogLine[] = [];
		const handle = createRequestLogHandle({ write: (line) => lines.push(line) });
		await run(
			handle,
			hookEvent({ url: 'https://example.org/nada', routeId: null }),
			() => new Response('x', { status: 404 })
		);
		await run(
			handle,
			hookEvent({ url: 'https://example.org/', routeId: '/', ray: `${EMAIL}` }),
			() => new Response('ok')
		);
		expect(lines.map((line) => line.route)).toEqual(['(unmatched)', '/']);
		for (const line of lines) expect(line.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(JSON.stringify(lines)).not.toContain(EMAIL);
		expect(requestId(new Headers({ 'cf-ray': '0123456789abcdef' }))).toBe('0123456789abcdef');
	});

	it('logs a thrown error as 500 with the class name only and rethrows it', async () => {
		const lines: RequestLogLine[] = [];
		const handle = createRequestLogHandle({ write: (line) => lines.push(line) });
		const failure = new TypeError(`boom ${EMAIL}`);
		await expect(
			run(handle, hookEvent({ url: 'https://example.org/conta', routeId: '/conta' }), () => {
				throw failure;
			})
		).rejects.toBe(failure);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ route: '/conta', status: 500, error: 'TypeError' });
		expect(JSON.stringify(lines)).not.toContain(EMAIL);
	});

	it('defaults to console (error for 5xx), skips while building and normalizes odd methods', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const handle = createRequestLogHandle();
		await run(
			handle,
			hookEvent({ url: 'https://example.org/', routeId: '/' }),
			() => new Response()
		);
		await run(
			handle,
			hookEvent({ url: 'https://example.org/x', routeId: '/x', method: 'PROPFIND' }),
			() => new Response('', { status: 503 })
		);
		const building = createRequestLogHandle({ building: true, write: () => log('never') });
		await run(
			building,
			hookEvent({ url: 'https://example.org/', routeId: '/' }),
			() => new Response()
		);
		expect(log).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
			method: 'OTHER',
			status: 503
		});
		log.mockRestore();
		error.mockRestore();
	});

	it('reads the error code only from small JSON error bodies with an UPPER_SNAKE code', async () => {
		expect(await errorCodeOf(Response.json({ code: 'RATE_LIMITED' }, { status: 429 }))).toBe(
			'RATE_LIMITED'
		);
		expect(await errorCodeOf(Response.json({ code: EMAIL }, { status: 400 }))).toBeUndefined();
		expect(await errorCodeOf(Response.json({ code: 'OK_CODE' }))).toBeUndefined();
		expect(await errorCodeOf(new Response('{"code":"X"}', { status: 400 }))).toBeUndefined();
		const big = JSON.stringify({ code: 'BIG', pad: 'x'.repeat(5000) });
		expect(
			await errorCodeOf(
				new Response(big, { status: 400, headers: { 'content-type': 'application/json' } })
			)
		).toBeUndefined();
	});
});

describe('metrics', () => {
	it('has a fixed schema: index = event, blobs = [event, label, detail], doubles = [1, value]', () => {
		expect(METRIC_EVENTS).toEqual([
			'gate_rejected',
			'signup',
			'email_failed',
			'http_5xx',
			'report',
			'job_run'
		]);
		expect(metricPoint('job_run', 'regate', 'ok', 12.5)).toEqual({
			indexes: ['job_run'],
			blobs: ['job_run', 'regate', 'ok'],
			doubles: [1, 12.5]
		});
		expect(metricPoint('signup', 'email', '', Number.NaN).doubles).toEqual([1, 0]);
	});

	it('replaces anything that is not a short fixed code with `other`', () => {
		expect(metricLabel('/api/v1/curves/[id]')).toBe('/api/v1/curves/[id]');
		expect(metricLabel('k:kind-not-allowed')).toBe('k:kind-not-allowed');
		expect(metricLabel(null)).toBe('');
		for (const value of [EMAIL, IP.replace(/\./g, ''), 'two words', 'x'.repeat(LABEL_MAX + 1)]) {
			expect(metricLabel(value)).toBe('other');
		}
	});

	it('every helper writes the documented point and never PII', () => {
		const { points, dataset } = fakeMetrics();
		recordGateRejection(dataset, ['k:kind-not-allowed', 'k:kind-not-allowed', 'g:peak'], 'fork');
		recordGateRejection(dataset, [], 'publish');
		recordSignup(dataset);
		recordEmailFailure(dataset, 'verify-email', 'rate_limited');
		recordServerError(dataset, '/api/v1/curves', 'INTERNAL', 500);
		recordReport(dataset, 'lineage', 'spam');
		recordJobRun(dataset, 'rankings', false, 30.4);
		expect(points.map((point) => point.blobs)).toEqual([
			['gate_rejected', 'k:kind-not-allowed', 'fork'],
			['gate_rejected', 'g:peak', 'fork'],
			['gate_rejected', 'unspecified', 'publish'],
			['signup', 'email', ''],
			['email_failed', 'verify-email', 'rate_limited'],
			['http_5xx', '/api/v1/curves', 'INTERNAL'],
			['report', 'lineage', 'spam'],
			['job_run', 'rankings', 'failed']
		]);
		expect(points.map((point) => point.doubles)).toEqual([
			[1, 0],
			[1, 0],
			[1, 0],
			[1, 0],
			[1, 0],
			[1, 500],
			[1, 0],
			[1, 30]
		]);
		for (const point of points) expect(point.indexes).toEqual([point.blobs[0]]);
	});

	it('is a no-op without the binding and never throws into the caller', () => {
		expect(metricsFromEnv({})).toBeNull();
		expect(metricsFromEnv(undefined)).toBeNull();
		expect(metricsFromEnv({ METRICS: { writeDataPoint: 'no' } })).toBeNull();
		expect(isMetricsDataset({ writeDataPoint: () => undefined })).toBe(true);
		expect(() => {
			recordSignup(null);
			recordJobRun(undefined, 'x', true, 1);
			recordGateRejection(null, ['a'], 'publish');
		}).not.toThrow();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const broken = {
			writeDataPoint() {
				throw new RangeError(EMAIL);
			}
		};
		expect(() => recordReport(broken, 'pack', 'spam')).not.toThrow();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).not.toContain(EMAIL);
		warn.mockRestore();
	});
});
