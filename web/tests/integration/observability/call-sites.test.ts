// T5.2: each metrics call site writes its documented data point through an injected fake binding.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError, defineApi, json, type ApiEvent } from '#lib/server/api/index.ts';
import { createAuth } from '#lib/server/auth.ts';
import { EmailError, withFailureMetrics, type EmailProvider } from '#lib/server/email/index.ts';
import { metricPoint } from '#lib/server/observability/index.ts';
import { AUTH_POLICIES } from '#lib/server/security/ratelimit.ts';
import { publishCurve } from '#lib/server/social/curves.ts';
import { fileReport } from '#lib/server/social/moderation.ts';
import { mockNetwork, PASSWORD, testEnv, uniqueEmail } from '../auth/harness.ts';
import {
	acceptAll,
	actor,
	envelopeOf,
	published,
	uniqueRejectedCurve
} from '../social/curves/helpers.ts';
import { fakeMetrics } from './helpers.ts';

const network = setupNetwork();
beforeAll(async () => {
	await network.enable();
	mockNetwork(network);
});
afterAll(() => network.disable());

vi.setConfig({ testTimeout: 60_000 });

function apiEvent(platformEnv: unknown, routeId = '/api/v1/obs'): ApiEvent {
	return {
		request: new Request(`${env.PUBLIC_ORIGIN}/api/v1/obs?token=secret-value`),
		locals: { user: null, session: null },
		platform: { env: platformEnv },
		route: { id: routeId }
	};
}

describe('api handler: http_5xx', () => {
	it('records thrown errors and 5xx ApiErrors by route id; 4xx and successes record nothing', async () => {
		const { points, dataset } = fakeMetrics();
		const platformEnv = { ...env, METRICS: dataset };
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const crash = defineApi<ApiEvent>({ auth: 'public', rateLimit: false }, () => {
			throw new TypeError('secret-value');
		});
		const unavailable = defineApi<ApiEvent>({ auth: 'public', rateLimit: false }, () => {
			throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE');
		});
		const missing = defineApi<ApiEvent>({ auth: 'public', rateLimit: false }, () => {
			throw new ApiError(404, 'NOT_FOUND');
		});
		const fine = defineApi<ApiEvent>({ auth: 'public', rateLimit: false }, () => json({}));
		expect((await crash(apiEvent(platformEnv, '/api/v1/curves/[id]'))).status).toBe(500);
		expect((await unavailable(apiEvent(platformEnv))).status).toBe(503);
		expect((await missing(apiEvent(platformEnv))).status).toBe(404);
		expect((await fine(apiEvent(platformEnv))).status).toBe(200);
		error.mockRestore();
		expect(points).toEqual([
			metricPoint('http_5xx', '/api/v1/curves/[id]', 'TypeError', 500),
			metricPoint('http_5xx', '/api/v1/obs', 'RATE_LIMIT_UNAVAILABLE', 503)
		]);
		expect(JSON.stringify(points)).not.toContain('secret-value');
	});

	it('is a no-op without the binding', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const crash = defineApi<ApiEvent>({ auth: 'public', rateLimit: false }, () => {
			throw new Error('x');
		});
		expect((await crash(apiEvent({ ...env, METRICS: undefined }))).status).toBe(500);
		error.mockRestore();
	});
});

describe('curves publication path: gate_rejected', () => {
	it('records one point per gate reason with the publication path; accepted curves record none', async () => {
		const { points, dataset } = fakeMetrics();
		const owner = await actor();
		const rejected = await publishCurve(
			env.DB,
			owner.user.id,
			{ envelope: envelopeOf(uniqueRejectedCurve()), visibility: 'public' },
			{ metrics: dataset }
		).then(
			() => null,
			(error: unknown) => error
		);
		expect(rejected).toBeInstanceOf(ApiError);
		expect(rejected instanceof ApiError ? rejected.code : null).toBe('GATE_REJECTED');
		expect(points.length).toBeGreaterThan(0);
		for (const point of points) {
			expect(point.indexes).toEqual(['gate_rejected']);
			expect(point.blobs[0]).toBe('gate_rejected');
			expect(point.blobs[2]).toBe('publish');
			expect(point.blobs[1]).not.toBe('other');
		}
		expect(points.map((point) => point.blobs[1])).toContain('e:output-audible');

		const before = points.length;
		await publishCurve(
			env.DB,
			owner.user.id,
			{ envelope: envelopeOf(uniqueRejectedCurve()), visibility: 'public' },
			{ metrics: dataset, gate: acceptAll }
		);
		expect(points.length).toBe(before);
	});
});

describe('moderation: report', () => {
	it('records the target kind and reason of a new report, nothing for a duplicate', async () => {
		const { points, dataset } = fakeMetrics();
		const owner = await actor();
		const info = await published(owner, {
			gate: acceptAll,
			envelope: envelopeOf(uniqueRejectedCurve())
		});
		const reporter = await actor();
		const input = {
			reporterUserId: reporter.user.id,
			targetKind: 'lineage' as const,
			targetId: info.lineageId,
			reason: 'spam' as const,
			note: 'nota livre que nunca vira metrica',
			now: Date.now(),
			metrics: dataset
		};
		expect((await fileReport(env.DB, input)).ok).toBe(true);
		expect(await fileReport(env.DB, input)).toEqual({ ok: false, code: 'DUPLICATE' });
		expect(points).toEqual([metricPoint('report', 'lineage', 'spam')]);
		expect(JSON.stringify(points)).not.toContain(reporter.user.id);
		expect(JSON.stringify(points)).not.toContain(info.lineageId);
	});
});

describe('e-mail: email_failed', () => {
	const message = {
		to: 'pessoa@example.com',
		subject: 'Assunto',
		html: '<p>x</p>',
		text: 'x',
		idempotencyKey: 'verify-email/fixture',
		tags: [{ name: 'template', value: 'verify-email' }]
	};

	it('records template and kind of a failed send and passes the rejection on', async () => {
		const { points, dataset } = fakeMetrics();
		const failure = new EmailError('suppressed', 'fixture');
		const provider: EmailProvider = { send: () => Promise.reject(failure) };
		await expect(withFailureMetrics(provider, dataset).send(message)).rejects.toBe(failure);
		const plain: EmailProvider = { send: () => Promise.reject(new Error('x')) };
		await expect(withFailureMetrics(plain, dataset).send({ ...message, tags: [] })).rejects.toThrow(
			'x'
		);
		const ok: EmailProvider = { send: () => Promise.resolve({ id: 'email_1' }) };
		await withFailureMetrics(ok, dataset).send(message);
		expect(points).toEqual([
			metricPoint('email_failed', 'verify-email', 'suppressed'),
			metricPoint('email_failed', 'unknown', 'unexpected')
		]);
		expect(JSON.stringify(points)).not.toContain('pessoa@example.com');
	});

	it('returns the provider unchanged without the binding', () => {
		const provider: EmailProvider = { send: () => Promise.resolve({ id: 'email_1' }) };
		expect(withFailureMetrics(provider, null)).toBe(provider);
	});
});

describe('auth hooks: signup', () => {
	async function signUp(
		signupEnabled: boolean,
		dataset: ReturnType<typeof fakeMetrics>['dataset']
	): Promise<Response> {
		const serverEnv = { ...testEnv({ signupEnabled }), metrics: dataset };
		const pending: Promise<unknown>[] = [];
		const auth = createAuth(serverEnv, {
			waitUntil: (promise) => {
				pending.push(promise);
			}
		});
		const origin = serverEnv.publicOrigin;
		const action = AUTH_POLICIES['/sign-up/email'].turnstileAction ?? '';
		const bytes = crypto.getRandomValues(new Uint8Array(3));
		const response = await auth.handler(
			new Request(`${origin}/api/auth/sign-up/email`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin,
					'cf-connecting-ip': `10.${bytes[0] ?? 0}.${bytes[1] ?? 0}.${bytes[2] ?? 1}`,
					'x-turnstile-token': `ok:${action}:${new URL(origin).hostname}`
				},
				body: JSON.stringify({ name: 'Test Person', email: uniqueEmail('obs'), password: PASSWORD })
			})
		);
		await Promise.allSettled(pending);
		return response;
	}

	it('records one signup point after a successful sign-up and none when sign-up is refused', async () => {
		const metrics = fakeMetrics();
		expect((await signUp(true, metrics.dataset)).status).toBe(200);
		expect(metrics.points).toEqual([metricPoint('signup', 'email', '')]);
		expect((await signUp(false, metrics.dataset)).status).toBe(403);
		expect(metrics.points).toHaveLength(1);
	});
});
