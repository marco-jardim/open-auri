// T5.T observability checks through the hooks pipeline (./pipeline.ts) and real route modules:
//   - every console line written while serving a varied set of requests (reads, 304, 404, 503
//     READ_ONLY, a 500 from the API kit, an endpoint that throws, the canonical 301) carries no
//     PII: no e-mail, IP, User-Agent, cookie or bearer token, user id, path parameter or query;
//   - one `http.request` line per request that passed the canonical-host step, with only the
//     documented keys;
//   - metrics are a no-op without the METRICS binding (no throw, same answers), and the API kit
//     writes its `http_5xx` point when a binding is there.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { defineApi, type ApiEvent } from '#lib/server/api/index.ts';
import { metricsFromEnv, recordJobRun, recordSignup } from '#lib/server/observability/index.ts';
import { fakeMetrics } from '../observability/helpers.ts';
import { invoke, member, missingId } from '../phase4/helpers.ts';
import {
	captureConsole,
	eventAt,
	eventFor,
	kitPage,
	requestLines,
	settled,
	through,
	type EventInit,
	type PipelineEvent
} from './pipeline.ts';

const EMAIL = `p5-log-${crypto.randomUUID().slice(0, 8)}@example.com`;
const TOKEN = `tok_${crypto.randomUUID().replace(/-/g, '')}`;
const IPV4 = '203.0.113.77';
const IPV6 = '2001:db8::7';
const UA = 'Mozilla/5.0 (phase5-log-agent)';
const ID_PARAM = missingId();
const LINE_KEYS = ['event', 'id', 'route', 'method', 'status', 'ms', 'code', 'error'];

/** Headers that carry personal data on every request of this file. */
function personal(index: number): Record<string, string> {
	return {
		'cf-connecting-ip': index % 2 === 0 ? IPV4 : IPV6,
		'user-agent': UA,
		cookie: `__Secure-better-auth.session_token=${TOKEN}`,
		authorization: `Bearer ${TOKEN}`,
		'x-forwarded-for': IPV4
	};
}

function withPii(init: EventInit, index: number): EventInit {
	return { ...init, headers: { ...personal(index), ...init.headers } };
}

const crashing = defineApi<ApiEvent>({ auth: 'public', rateLimit: false }, () => {
	throw new TypeError(`boom ${EMAIL} ${TOKEN}`);
});

describe('request log: no PII for a set of requests', () => {
	it('every line is free of e-mail, IP, UA, tokens, user id, path ids and queries', async () => {
		const user = await member({ prefix: 'p5log' });
		const signedIn = { ...user.locals };
		const feed = await import('../../../src/routes/api/v1/feed/+server.ts');
		const curveById = await import('../../../src/routes/api/v1/curves/[id]/+server.ts');
		const query = `?email=${encodeURIComponent(EMAIL)}&token=${TOKEN}`;

		const captured = await captureConsole(async () => {
			const statuses: number[] = [];
			const run = async (
				options: { readOnly: boolean; canonicalOrigin?: string },
				event: PipelineEvent,
				endpoint: (event: PipelineEvent) => Promise<Response> | Response
			) => {
				statuses.push((await through(options, event, endpoint)).status);
			};
			const off = { readOnly: false };
			await run(
				off,
				eventFor(`/api/v1/feed${query}`, withPii({ routeId: '/api/v1/feed', locals: signedIn }, 0)),
				(event) => invoke(feed, 'GET', event)
			);
			await run(
				off,
				eventFor(
					`/api/v1/curves/${ID_PARAM}${query}`,
					withPii({ routeId: '/api/v1/curves/[id]', params: { id: ID_PARAM } }, 1)
				),
				(event) => invoke(curveById, 'GET', event)
			);
			await run(
				{ readOnly: true },
				eventFor(
					`/api/v1/curves${query}`,
					withPii({ method: 'POST', routeId: '/api/v1/curves', locals: signedIn, body: {} }, 2)
				),
				() => new Response('never')
			);
			await run(
				off,
				eventFor(`/api/v1/obs/${ID_PARAM}${query}`, withPii({ routeId: '/api/v1/obs/[id]' }, 3)),
				(event) => crashing(event)
			);
			await run(
				off,
				eventFor(`/verificar-email${query}`, withPii({ routeId: '/verificar-email' }, 4)),
				() => kitPage()
			);
			await run(
				{ readOnly: false, canonicalOrigin: 'https://open-auri.example' },
				eventAt(
					`https://open-auri.example-sub.workers.dev/u/${ID_PARAM}${query}`,
					withPii({ routeId: '/u/[apelido]' }, 5)
				),
				() => new Response('never')
			);
			// An endpoint that throws: logged as 500 with the class name only, then rethrown.
			const thrown = await through(
				off,
				eventFor(`/conta${query}`, withPii({ routeId: '/conta', locals: signedIn }, 6)),
				() => {
					throw new RangeError(`${EMAIL} ${TOKEN}`);
				}
			).then(
				() => null,
				(error: unknown) => error
			);
			expect(thrown).toBeInstanceOf(RangeError);
			return statuses;
		});

		expect(captured.error).toBeNull();
		expect(captured.result).toEqual([200, 404, 503, 500, 200, 301]);
		const lines = requestLines(captured.lines);
		// The canonical 301 is answered before the request log (no line); the 6 others have one.
		expect(lines.map((line) => [line.route, line.status])).toEqual([
			['/api/v1/feed', 200],
			['/api/v1/curves/[id]', 404],
			['/api/v1/curves', 503],
			['/api/v1/obs/[id]', 500],
			['/verificar-email', 200],
			['/conta', 500]
		]);
		expect(lines.map((line) => line.code ?? null)).toEqual([
			null,
			'NOT_FOUND',
			'READ_ONLY',
			'INTERNAL',
			null,
			null
		]);
		expect(lines[5]?.error).toBe('RangeError');
		for (const line of lines) {
			for (const key of Object.keys(line)) expect(LINE_KEYS, key).toContain(key);
			expect(typeof line.ms).toBe('number');
		}

		// Every console line of the run, not only the request log (the API kit's api.error too).
		const text = captured.lines.join('\n');
		for (const leak of [
			EMAIL,
			TOKEN,
			IPV4,
			IPV6,
			UA,
			user.user.id,
			user.user.username,
			ID_PARAM,
			'?',
			'example-sub',
			'boom'
		]) {
			expect(text, leak).not.toContain(leak);
		}
		expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
		await settled();
	});
});

describe('metrics without the METRICS binding', () => {
	it('is a no-op: the same answers, no throw; with a binding the API kit writes http_5xx', async () => {
		expect(metricsFromEnv({ ...env, METRICS: undefined })).toBeNull();
		expect(() => {
			recordSignup(metricsFromEnv({}));
			recordJobRun(null, 'backup', true, 1);
		}).not.toThrow();

		const bare = await captureConsole(() =>
			through(
				{ readOnly: false },
				eventFor('/api/v1/obs', {
					routeId: '/api/v1/obs',
					platformEnv: { ...env, METRICS: undefined }
				}),
				(event) => crashing(event)
			)
		);
		expect(bare.error).toBeNull();
		expect(bare.result?.status).toBe(500);

		const { points, dataset } = fakeMetrics();
		const bound = await captureConsole(() =>
			through(
				{ readOnly: false },
				eventFor('/api/v1/obs', {
					routeId: '/api/v1/obs',
					platformEnv: { ...env, METRICS: dataset }
				}),
				(event) => crashing(event)
			)
		);
		expect(bound.result?.status).toBe(500);
		expect(points.map((point) => point.blobs)).toEqual([['http_5xx', '/api/v1/obs', 'TypeError']]);
		expect(JSON.stringify(points)).not.toContain(EMAIL);
	});
});
