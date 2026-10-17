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
	bradleyTerry,
	deleteBatch,
	eligibleItems,
	presetItemIds,
	S6_AGGREGATE_MAX_PAIRS,
	S6_CONSENT_VERSION,
	S6_ITEM_PATTERN,
	S6_PREFERENCES_KEY,
	S6_UNKNOWN_ITEM_ISSUE,
	S6_WINDOW_DAYS,
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
	dropBatch,
	itemIds,
	newReceipt,
	pairRows,
	routeEvent,
	sha256Hex,
	storeBatch,
	unknownItemIds,
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
		const ids = await itemIds(3);
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
		const response = await post(batchBody(receipt, pairsOf(await itemIds(3)), 'old-version'));
		await expectErrorResponse(response, 400, 'CONSENT_REQUIRED');
		expect(await batchRow(receipt)).toBeNull();
	});

	it('refuses a failed or mismatched Turnstile token (403) and stores nothing', async () => {
		const receipt = newReceipt();
		const body = batchBody(receipt, pairsOf(await itemIds(3)));
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
		const response = await post(batchBody(receipt, pairsOf(await itemIds(3))), {
			locals,
			platformEnv: { ...env, RL_WRITE: denied }
		});
		await expectErrorResponse(response, 429, 'RATE_LIMITED');
		expect(denied.keys).toHaveLength(1);
		expect(denied.keys[0]).not.toContain(locals.user.id);
		expect(await batchRow(receipt)).toBeNull();

		const allowed = fakeBinding('allow');
		const ok = await post(batchBody(receipt, pairsOf(await itemIds(3))), {
			locals,
			platformEnv: { ...env, RL_WRITE: allowed }
		});
		expect(ok.status).toBe(201);
		expect(allowed.keys[0]).not.toContain(locals.user.id);
	});

	it('validates the body: receipt shape, same item, pair count, unknown keys', async () => {
		turnstile(true);
		const [a = '', b = ''] = await itemIds(2);
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
		expect((await post(batchBody(receipt, pairsOf(await itemIds(3))))).status).toBe(201);
		const again = await post(batchBody(receipt, pairsOf(await itemIds(3))));
		await expectErrorResponse(again, 409, 'DUPLICATE');
	});
});

describe('DELETE /api/v1/s6/batches/[receipt]', () => {
	it('deletes the batch and its pairs; 204 also when absent or malformed (no oracle)', async () => {
		turnstile(true);
		const receipt = newReceipt();
		expect((await post(batchBody(receipt, pairsOf(await itemIds(3))))).status).toBe(201);
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
		expect((await post(batchBody(receipt, pairsOf(await itemIds(3))))).status).toBe(201);
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
				{ consentVersion: S6_CONSENT_VERSION, receipt, pairs: pairsOf(await itemIds(3)) },
				now
			)
		).toEqual({ ok: true });
		expect((await batchRow(receipt))?.day).toBe('2026-03-04');
		expect(await deleteBatch(env.DB, receipt)).toBe(true);
		expect(await deleteBatch(env.DB, receipt)).toBe(false);
		expect(await deleteBatch(env.DB, 'bad')).toBe(false);
		expect(
			await submitBatch(
				env.DB,
				{ consentVersion: 'v0', receipt, pairs: pairsOf(await itemIds(3)) },
				now
			)
		).toEqual({ ok: false, code: 'consent-required' });
	});

	it('aggregate publishes scores and counts only, sorted, with 6-decimal scores', async () => {
		const ids = await itemIds(3);
		const receipt = newReceipt();
		await submitBatch(
			env.DB,
			{ consentVersion: S6_CONSENT_VERSION, receipt, pairs: pairsOf(ids) },
			new Date()
		);
		const now = new Date('2026-10-16T00:05:00.000Z');
		const result = await aggregate(env.DB, now);
		expect(Object.keys(result).sort()).toEqual([
			'consentVersion',
			'converged',
			'generatedAt',
			'items',
			'pairs'
		]);
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

describe('item eligibility (FX4.7)', () => {
	it('accepts official preset curve ids and publicly listable curves', async () => {
		turnstile(true);
		const presets = [...(await presetItemIds())];
		expect(presets.length).toBeGreaterThanOrEqual(2);
		for (const id of presets) expect(id).toMatch(S6_ITEM_PATTERN);
		const [listable = ''] = await itemIds(1);
		const receipt = newReceipt();
		const pairs: PairBody[] = [
			{ a: presets[0] ?? '', b: presets[1] ?? '', choice: 'a', levelMatched: true },
			{ a: presets[1] ?? '', b: listable, choice: 'tie', levelMatched: true }
		];
		const response = await post(batchBody(receipt, pairs));
		expect(response.status).toBe(201);
		expect(await pairRows(String((await batchRow(receipt))?.id))).toHaveLength(2);
		await deleteBatch(env.DB, receipt);
	});

	it('refuses the whole batch when any item is unknown, unlisted or private (400, stable issue)', async () => {
		turnstile(true);
		const [listable = '', other = ''] = await itemIds(2);
		const [unlisted = ''] = await itemIds(1, 'unlisted');
		const [hidden = ''] = await itemIds(1, 'private');
		const [unknown = ''] = unknownItemIds(1);
		for (const bad of [unknown, unlisted, hidden]) {
			const receipt = newReceipt();
			const pairs: PairBody[] = [
				{ a: listable, b: other, choice: 'a', levelMatched: true },
				{ a: other, b: bad, choice: 'b', levelMatched: true }
			];
			const body = await expectErrorResponse(
				await post(batchBody(receipt, pairs)),
				400,
				'INVALID_BODY'
			);
			expect(body.error.details).toEqual({
				issues: [{ path: ['pairs'], code: S6_UNKNOWN_ITEM_ISSUE }]
			});
			expect(JSON.stringify(body)).not.toContain(bad);
			expect(await batchRow(receipt)).toBeNull();
		}
		expect(
			await submitBatch(
				env.DB,
				{
					consentVersion: S6_CONSENT_VERSION,
					receipt: newReceipt(),
					pairs: [{ a: listable, b: unknown, choice: 'a', levelMatched: true }]
				},
				new Date()
			)
		).toEqual({ ok: false, code: 'unknown-item' });
	});

	it('eligibleItems keeps presets and public curves only', async () => {
		const presets = [...(await presetItemIds())];
		const [listable = ''] = await itemIds(1);
		const [unlisted = ''] = await itemIds(1, 'unlisted');
		const [unknown = ''] = unknownItemIds(1);
		const eligible = await eligibleItems(env.DB, [presets[0] ?? '', listable, unlisted, unknown]);
		expect([...eligible].sort()).toEqual([presets[0] ?? '', listable].sort());
	});
});

describe('aggregation bounds (FX4.7)', () => {
	// A far-future day keeps the window free of other files' rows (the database is shared).
	const now = new Date('2099-06-30T00:05:00.000Z');
	const dayOffset = (days: number) =>
		new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
	const cycle = (ids: string[]): [string, string, 'a' | 'b' | 'tie'][] => [
		[ids[0] ?? '', ids[1] ?? '', 'a'],
		[ids[1] ?? '', ids[2] ?? '', 'a'],
		[ids[2] ?? '', ids[0] ?? '', 'a']
	];

	it('reads only the last S6_WINDOW_DAYS days', async () => {
		expect(S6_WINDOW_DAYS).toBe(90);
		const inside = await itemIds(3);
		const outside = await itemIds(3);
		const kept = await storeBatch(dayOffset(S6_WINDOW_DAYS), cycle(inside));
		const old = await storeBatch(dayOffset(S6_WINDOW_DAYS + 1), cycle(outside));
		const result = await aggregate(env.DB, now);
		const scored = result.items.map((item) => item.curveId);
		for (const id of inside) expect(scored).toContain(id);
		for (const id of outside) expect(scored).not.toContain(id);
		expect(result.pairs).toBe(3);
		await dropBatch(kept);
		await dropBatch(old);
	});

	it('reads at most maxPairs pairs, newest first', async () => {
		expect(S6_AGGREGATE_MAX_PAIRS).toBe(200_000);
		const older = await itemIds(3);
		const newer = await itemIds(3);
		const first = await storeBatch(dayOffset(1), cycle(older));
		const second = await storeBatch(dayOffset(1), cycle(newer));
		const result = await aggregate(env.DB, now, { maxPairs: 3 });
		expect(result.pairs).toBe(3);
		expect(result.items.map((item) => item.curveId).sort()).toEqual([...newer].sort());
		await dropBatch(first);
		await dropBatch(second);
	});

	it('drops stored items that are not (or no longer) eligible from the public JSON', async () => {
		const listable = await itemIds(3);
		const [unlisted = ''] = await itemIds(1, 'unlisted');
		const unknown = unknownItemIds(3);
		const batch = await storeBatch(dayOffset(2), [
			...cycle(listable),
			...cycle(unknown),
			[listable[0] ?? '', unlisted, 'a'],
			[unlisted, listable[1] ?? '', 'a']
		]);
		const result = await aggregate(env.DB, now);
		expect(result.items.map((item) => item.curveId).sort()).toEqual([...listable].sort());
		expect(result.pairs).toBe(3);
		const text = JSON.stringify(result);
		for (const id of [...unknown, unlisted]) expect(text).not.toContain(id);
		await dropBatch(batch);
	});

	it('publishes the best estimate with converged:false when the time or work budget runs out', async () => {
		const ids = await itemIds(3);
		const batch = await storeBatch(dayOffset(3), [
			[ids[0] ?? '', ids[1] ?? '', 'a'],
			[ids[0] ?? '', ids[1] ?? '', 'a'],
			[ids[1] ?? '', ids[0] ?? '', 'a'],
			[ids[1] ?? '', ids[2] ?? '', 'a'],
			[ids[2] ?? '', ids[1] ?? '', 'a'],
			[ids[2] ?? '', ids[0] ?? '', 'a']
		]);
		let tick = 0;
		const timed = await aggregate(env.DB, now, { budgetMs: 2, clock: () => tick++ });
		expect(timed.converged).toBe(false);
		expect(timed.items).toHaveLength(3);
		const capped = await aggregate(env.DB, now, { maxWork: 1 });
		expect(capped.converged).toBe(false);
		expect(capped.items).toHaveLength(3);
		const full = await aggregate(env.DB, now);
		expect(full.converged).toBe(true);
		expect(full.items).toHaveLength(3);
		await dropBatch(batch);
	});

	it('bradleyTerry stops between sweeps on the budgets (at least one sweep)', () => {
		// Wins (x 3, y 2, z 1) differ from the expected wins at equal strengths (x 2.5, y 2.5, z 1),
		// so the start p = 1 is not the MLE and the MM iteration needs many sweeps to reach 1e-9.
		// (A fixture whose wins equal those expected wins converges on the first sweep.)
		const pairs = [
			{ a: 'x', b: 'y', choice: 'a' as const, weight: 3 },
			{ a: 'y', b: 'x', choice: 'a' as const },
			{ a: 'y', b: 'z', choice: 'a' as const },
			{ a: 'z', b: 'x', choice: 'a' as const }
		];
		const full = bradleyTerry(pairs);
		expect(full.converged).toBe(true);
		expect(full.iterations).toBeGreaterThan(3);
		let tick = 0;
		const timed = bradleyTerry(pairs, { budgetMs: 3, clock: () => tick++ });
		expect(timed.converged).toBe(false);
		expect(timed.iterations).toBe(3);
		const capped = bradleyTerry(pairs, { maxWork: 1 });
		expect(capped).toMatchObject({ converged: false, iterations: 1 });
		expect(() => bradleyTerry(pairs, { budgetMs: 0 })).toThrow(RangeError);
		expect(() => bradleyTerry(pairs, { maxWork: 0 })).toThrow(RangeError);
	});
});

describe('GET /api/v1/s6/preferences', () => {
	it('an empty document before the first run; then the R2 JSON with CACHE_PUBLIC_60 and a strong ETag', async () => {
		await env.MEDIA.delete(S6_PREFERENCES_KEY);
		const empty = await getPreferences();
		expect(empty.status).toBe(200);
		expect(empty.headers.get('cache-control')).toBe(CACHE_PUBLIC_60);
		expect(empty.headers.get('content-type')).toContain('application/json');
		const emptyEtag = empty.headers.get('etag');
		expect(emptyEtag).toMatch(/^"/);
		expect(await empty.json()).toEqual({
			generatedAt: null,
			consentVersion: S6_CONSENT_VERSION,
			items: [],
			pairs: 0,
			converged: true
		});
		expect((await getPreferences({ 'if-none-match': emptyEtag ?? '' })).status).toBe(304);

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
