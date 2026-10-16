// T4.9: S6 routes. Consent refused, Turnstile and rate limit, receipt withdrawal without an
// existence oracle, nothing identifying persisted (row columns and values inspected), and the
// public preferences JSON from R2.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CACHE_PUBLIC_60, TURNSTILE_HEADER } from '#lib/server/api/index.ts';
import { getDailySalt, ipHash } from '#lib/server/security/iphash.ts';
import { SITEVERIFY_URL, TURNSTILE_ACTIONS } from '#lib/server/security/turnstile.ts';
import {
	aggregate,
	deleteBatch,
	S6_CONSENT_VERSION,
	S6_PREFERENCES_KEY,
	submitBatch
} from '#lib/server/social/s6.ts';
import { POST } from '../../../../src/routes/api/v1/s6/batches/+server.ts';
import { DELETE } from '../../../../src/routes/api/v1/s6/batches/[receipt]/+server.ts';
import { GET } from '../../../../src/routes/api/v1/s6/preferences/+server.ts';
import {
	expectErrorResponse,
	fakeBinding,
	HOSTNAME,
	localsOf,
	serverEnv
} from '../../api/helpers.ts';
import {
	batchBody,
	batchRow,
	columnsOf,
	itemIds,
	newReceipt,
	pairRows,
	routeEvent,
	sha256Hex,
	type PairBody,
	type RouteEventInit
} from './helpers.ts';

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => {
	network.resetHandlers();
	vi.restoreAllMocks();
});
afterAll(() => network.disable());

function turnstile(success: boolean, action: string = TURNSTILE_ACTIONS.s6) {
	network.use(
		http.post(SITEVERIFY_URL, () => HttpResponse.json({ success, action, hostname: HOSTNAME }))
	);
}

type PostEvent = Parameters<typeof POST>[0];
type DeleteEvent = Parameters<typeof DELETE>[0];
type GetEvent = Parameters<typeof GET>[0];

async function post(body: string, init: Partial<RouteEventInit> = {}): Promise<Response> {
	const event = routeEvent({
		method: 'POST',
		path: '/api/v1/s6/batches',
		routeId: '/api/v1/s6/batches',
		headers: { 'content-type': 'application/json', [TURNSTILE_HEADER]: 'tok', ...init.headers },
		body,
		...(init.locals ? { locals: init.locals } : {}),
		...(init.platformEnv ? { platformEnv: init.platformEnv } : {}),
		...(init.ip ? { ip: init.ip } : {})
	});
	return POST(event as unknown as PostEvent);
}

async function remove(receipt: string, init: Partial<RouteEventInit> = {}): Promise<Response> {
	const event = routeEvent({
		method: 'DELETE',
		path: `/api/v1/s6/batches/${encodeURIComponent(receipt)}`,
		routeId: '/api/v1/s6/batches/[receipt]',
		params: { receipt },
		...(init.platformEnv ? { platformEnv: init.platformEnv } : {})
	});
	return DELETE(event as unknown as DeleteEvent);
}

async function getPreferences(headers: Record<string, string> = {}): Promise<Response> {
	const event = routeEvent({
		method: 'GET',
		path: '/api/v1/s6/preferences',
		routeId: '/api/v1/s6/preferences',
		headers
	});
	return GET(event as unknown as GetEvent);
}

function pairsOf(ids: string[]): PairBody[] {
	return [
		{ a: ids[0] ?? '', b: ids[1] ?? '', choice: 'a', levelMatched: true },
		{ a: ids[1] ?? '', b: ids[2] ?? '', choice: 'tie', levelMatched: false },
		{ a: ids[2] ?? '', b: ids[0] ?? '', choice: 'b', levelMatched: true }
	];
}

describe('POST /api/v1/s6/batches', () => {
	it('stores day, consent version, receipt hash and pairs only: no user, IP or IP hash', async () => {
		turnstile(true);
		const ip = '10.77.1.9';
		const receipt = newReceipt();
		const locals = localsOf();
		const ids = itemIds(3);
		const response = await post(batchBody(receipt, pairsOf(ids)), { ip, locals });
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ ok: true });

		expect(await columnsOf('s6_batches')).toEqual(['consent_ver', 'day', 'id', 'receipt_hash']);
		expect(await columnsOf('s6_pairs')).toEqual([
			'a',
			'b',
			'batch_id',
			'choice',
			'id',
			'level_matched'
		]);

		const row = await batchRow(receipt);
		expect(row).not.toBeNull();
		expect(row?.receipt_hash).toBe(await sha256Hex(receipt));
		expect(row?.consent_ver).toBe(S6_CONSENT_VERSION);
		expect(row?.day).toBe(new Date().toISOString().slice(0, 10));
		expect(String(row?.id)).toMatch(/^[A-Za-z0-9_-]{22}$/);

		const pairs = await pairRows(String(row?.id));
		expect(pairs).toHaveLength(3);
		const stored = pairs
			.map((pair) => [pair.a, pair.b, pair.choice, pair.level_matched].map(String).join('|'))
			.sort();
		expect(stored).toEqual(
			pairsOf(ids)
				.map((pair) => `${pair.a}|${pair.b}|${pair.choice}|${pair.levelMatched ? 1 : 0}`)
				.sort()
		);

		const server = serverEnv();
		const salt = await getDailySalt(server.config, new Date());
		const hash = await ipHash(ip, { pepper: server.secrets.iphashPepper, salt });
		const everything = JSON.stringify([row, pairs]);
		for (const secret of [ip, hash, locals.user.id, locals.session.id, receipt]) {
			expect(everything).not.toContain(secret);
		}
	});

	it('refuses a batch without the current consent version (400 CONSENT_REQUIRED)', async () => {
		turnstile(true);
		const receipt = newReceipt();
		const response = await post(batchBody(receipt, pairsOf(itemIds(3)), 'old-version'));
		await expectErrorResponse(response, 400, 'CONSENT_REQUIRED');
		expect(await batchRow(receipt)).toBeNull();
	});

	it('refuses a failed or mismatched Turnstile token (403) and stores nothing', async () => {
		const receipt = newReceipt();
		const body = batchBody(receipt, pairsOf(itemIds(3)));
		turnstile(false);
		await expectErrorResponse(await post(body), 403, 'TURNSTILE_FAILED');
		turnstile(true, TURNSTILE_ACTIONS.report);
		await expectErrorResponse(await post(body), 403, 'TURNSTILE_FAILED');
		expect(await batchRow(receipt)).toBeNull();
	});

	it('rate limits on the IP hash even when signed in, before Turnstile (429)', async () => {
		turnstile(true);
		const receipt = newReceipt();
		const denied = fakeBinding('deny');
		const locals = localsOf();
		const response = await post(batchBody(receipt, pairsOf(itemIds(3))), {
			locals,
			platformEnv: { ...env, RL_WRITE: denied }
		});
		await expectErrorResponse(response, 429, 'RATE_LIMITED');
		expect(denied.keys).toHaveLength(1);
		expect(denied.keys[0]).not.toContain(locals.user.id);
		expect(await batchRow(receipt)).toBeNull();

		const allowed = fakeBinding('allow');
		const ok = await post(batchBody(receipt, pairsOf(itemIds(3))), {
			locals,
			platformEnv: { ...env, RL_WRITE: allowed }
		});
		expect(ok.status).toBe(201);
		expect(allowed.keys[0]).not.toContain(locals.user.id);
	});

	it('validates the body: receipt shape, same item, pair count, unknown keys', async () => {
		turnstile(true);
		const [a = '', b = ''] = itemIds(2);
		const pair = { a, b, choice: 'a', levelMatched: true };
		const bodies = [
			JSON.stringify({ consentVersion: S6_CONSENT_VERSION, receipt: 'short', pairs: [pair] }),
			JSON.stringify({ consentVersion: S6_CONSENT_VERSION, receipt: newReceipt(), pairs: [] }),
			JSON.stringify({
				consentVersion: S6_CONSENT_VERSION,
				receipt: newReceipt(),
				pairs: [{ ...pair, b: a }]
			}),
			JSON.stringify({
				consentVersion: S6_CONSENT_VERSION,
				receipt: newReceipt(),
				pairs: Array.from({ length: 101 }, () => pair)
			}),
			JSON.stringify({
				consentVersion: S6_CONSENT_VERSION,
				receipt: newReceipt(),
				pairs: [pair],
				userId: 'x'
			})
		];
		for (const body of bodies) await expectErrorResponse(await post(body), 400, 'INVALID_BODY');
	});

	it('answers 409 DUPLICATE for a reused receipt', async () => {
		turnstile(true);
		const receipt = newReceipt();
		expect((await post(batchBody(receipt, pairsOf(itemIds(3))))).status).toBe(201);
		const again = await post(batchBody(receipt, pairsOf(itemIds(3))));
		await expectErrorResponse(again, 409, 'DUPLICATE');
	});
});

describe('DELETE /api/v1/s6/batches/[receipt]', () => {
	it('deletes the batch and its pairs; 204 also when absent or malformed (no oracle)', async () => {
		turnstile(true);
		const receipt = newReceipt();
		expect((await post(batchBody(receipt, pairsOf(itemIds(3))))).status).toBe(201);
		const id = String((await batchRow(receipt))?.id);

		const first = await remove(receipt);
		expect(first.status).toBe(204);
		expect(await batchRow(receipt)).toBeNull();
		expect(await pairRows(id)).toEqual([]);

		const again = await remove(receipt);
		const never = await remove(newReceipt());
		const malformed = await remove('not-a-receipt');
		for (const response of [again, never, malformed]) {
			expect(response.status).toBe(204);
			expect(await response.text()).toBe('');
		}
	});

	it('is rate limited (429) and keeps the batch then', async () => {
		turnstile(true);
		const receipt = newReceipt();
		expect((await post(batchBody(receipt, pairsOf(itemIds(3))))).status).toBe(201);
		const response = await remove(receipt, {
			platformEnv: { ...env, RL_WRITE: fakeBinding('deny') }
		});
		await expectErrorResponse(response, 429, 'RATE_LIMITED');
		expect(await batchRow(receipt)).not.toBeNull();
	});
});

describe('service', () => {
	it('submitBatch keeps only the UTC day of `now`; deleteBatch reports whether it deleted', async () => {
		const receipt = newReceipt();
		const now = new Date('2026-03-04T23:59:59.999Z');
		expect(
			await submitBatch(
				env.DB,
				{ consentVersion: S6_CONSENT_VERSION, receipt, pairs: pairsOf(itemIds(3)) },
				now
			)
		).toEqual({ ok: true });
		expect((await batchRow(receipt))?.day).toBe('2026-03-04');
		expect(await deleteBatch(env.DB, receipt)).toBe(true);
		expect(await deleteBatch(env.DB, receipt)).toBe(false);
		expect(await deleteBatch(env.DB, 'bad')).toBe(false);
		expect(
			await submitBatch(env.DB, { consentVersion: 'v0', receipt, pairs: pairsOf(itemIds(3)) }, now)
		).toEqual({ ok: false, code: 'consent-required' });
	});

	it('aggregate publishes scores and counts only, sorted, with 6-decimal scores', async () => {
		const ids = itemIds(3);
		const receipt = newReceipt();
		await submitBatch(
			env.DB,
			{ consentVersion: S6_CONSENT_VERSION, receipt, pairs: pairsOf(ids) },
			new Date()
		);
		const now = new Date('2026-10-16T00:05:00.000Z');
		const result = await aggregate(env.DB, now);
		expect(Object.keys(result).sort()).toEqual(['consentVersion', 'generatedAt', 'items', 'pairs']);
		expect(result.generatedAt).toBe(now.toISOString());
		expect(result.consentVersion).toBe(S6_CONSENT_VERSION);
		expect(result.pairs).toBeGreaterThanOrEqual(3);
		for (const item of result.items) {
			expect(Object.keys(item).sort()).toEqual(['comparisons', 'curveId', 'score']);
			expect(Math.round(item.score * 1e6) / 1e6).toBe(item.score);
		}
		for (let i = 1; i < result.items.length; i++) {
			expect(result.items[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(result.items[i]?.score ?? 0);
		}
		await deleteBatch(env.DB, receipt);
	});
});

describe('GET /api/v1/s6/preferences', () => {
	it('404 before the first run; then the R2 JSON with CACHE_PUBLIC_60 and a strong ETag', async () => {
		await env.MEDIA.delete(S6_PREFERENCES_KEY);
		await expectErrorResponse(await getPreferences(), 404, 'NOT_FOUND');

		const body = JSON.stringify({
			generatedAt: '2026-10-16T00:05:00.000Z',
			consentVersion: S6_CONSENT_VERSION,
			items: [{ curveId: 'abcdefghijkl', score: 1, comparisons: 2 }],
			pairs: 2
		});
		await env.MEDIA.put(S6_PREFERENCES_KEY, body);
		const response = await getPreferences();
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe(CACHE_PUBLIC_60);
		expect(response.headers.get('content-type')).toContain('application/json');
		const etag = response.headers.get('etag');
		expect(etag).toMatch(/^"/);
		expect(await response.text()).toBe(body);

		const notModified = await getPreferences({ 'if-none-match': etag ?? '' });
		expect(notModified.status).toBe(304);
		await env.MEDIA.delete(S6_PREFERENCES_KEY);
	});
});
