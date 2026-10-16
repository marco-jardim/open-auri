// T4.5: shares service, the /api/v1/shares routes and the load of /c/[id] (workerd, shared D1:
// every id is unique per test).
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import {
	createShareFor,
	loadSharedCurve,
	recordShareOpen,
	recordShareOpenLimited,
	shareStatsFor,
	shareUrl,
	utcDay
} from '#lib/server/social/shares.ts';
import { recordShareEvent } from '#lib/server/social/repo.ts';
import {
	expectApiError,
	expectErrorResponse,
	fakeBinding,
	localsOf,
	ORIGIN,
	randomIp,
	serverEnv,
	signedOut
} from '../../api/helpers.ts';
import { publish, seedUser } from '../repo/helpers.ts';

type Handler = (event: unknown) => Promise<Response>;
type Load = (event: unknown) => Promise<unknown>;

async function route<T>(path: string): Promise<T> {
	const specifier = `../../../../src/routes/${path}`;
	return (await import(/* @vite-ignore */ specifier)) as T;
}

function localsFor(userId: string): AuthLocals {
	return localsOf({ id: userId });
}

interface EventInit {
	method?: string;
	path: string;
	body?: unknown;
	locals?: AuthLocals;
	params?: Record<string, string>;
	platformEnv?: unknown;
	routeId: string;
	ip?: string;
}

function apiEvent(init: EventInit) {
	const method = init.method ?? 'GET';
	const unsafe = method !== 'GET' && method !== 'HEAD';
	const headers: Record<string, string> = {
		'cf-connecting-ip': init.ip ?? randomIp(),
		...(unsafe ? { origin: ORIGIN } : {}),
		...(init.body === undefined ? {} : { 'content-type': 'application/json' })
	};
	return {
		request: new Request(`${ORIGIN}${init.path}`, {
			method,
			headers,
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
		}),
		locals: init.locals ?? signedOut(),
		params: init.params ?? {},
		platform: { env: init.platformEnv ?? env },
		route: { id: init.routeId },
		url: new URL(`${ORIGIN}${init.path}`)
	};
}

async function anonOpens(shareId: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COALESCE(SUM(anon_count), 0) AS n FROM share_events WHERE share_id = ? AND kind = 'open'"
	)
		.bind(shareId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function retract(lineageId: string): Promise<void> {
	await env.DB.prepare("UPDATE lineages SET status = 'retracted' WHERE id = ?")
		.bind(lineageId)
		.run();
}

/** Runs a load and returns its data, or the status of the HttpError it threw. */
async function loadOutcome(
	load: Load,
	event: unknown
): Promise<{ status: number; data: Record<string, unknown> | null }> {
	try {
		return { status: 200, data: (await load(event)) as Record<string, unknown> };
	} catch (thrown) {
		if (typeof thrown === 'object' && thrown !== null && 'status' in thrown) {
			const status = (thrown as { status: unknown }).status;
			if (typeof status === 'number') return { status, data: null };
		}
		throw thrown;
	}
}

function pageEvent(lineageId: string, options: { s?: string; locals?: AuthLocals } = {}) {
	const pending: Promise<unknown>[] = [];
	const query = options.s === undefined ? '' : `?s=${options.s}`;
	const path = `/c/${lineageId}${query}`;
	return {
		pending,
		event: {
			request: new Request(`${ORIGIN}${path}`, { headers: { 'cf-connecting-ip': randomIp() } }),
			url: new URL(`${ORIGIN}${path}`),
			params: { id: lineageId },
			locals: options.locals ?? signedOut(),
			platform: {
				env,
				ctx: {
					waitUntil: (promise: Promise<unknown>) => {
						pending.push(promise);
					}
				}
			},
			route: { id: '/c/[id]' }
		}
	};
}

describe('shares service', () => {
	it('creates shares of public, unlisted and own lineages; others are 404', async () => {
		const owner = await seedUser({});
		const other = await seedUser({});
		const pub = await publish(owner.id, { visibility: 'public' });
		const unlisted = await publish(owner.id, { visibility: 'unlisted' });
		const priv = await publish(owner.id, { visibility: 'private' });

		const a = await createShareFor(env.DB, other.id, { lineageId: pub.lineageId, channel: 'qr' });
		expect(a.url).toBe(shareUrl(pub.lineageId, a.shareId));
		expect(a.url).toMatch(/^\/c\/[^?]+\?s=[A-Za-z0-9_-]{16}$/);
		await createShareFor(env.DB, other.id, { lineageId: unlisted.lineageId });
		await createShareFor(env.DB, owner.id, { lineageId: priv.lineageId });

		await expectApiError(
			() => createShareFor(env.DB, other.id, { lineageId: priv.lineageId }),
			404,
			'NOT_FOUND'
		);
		await expectApiError(
			() => createShareFor(env.DB, other.id, { lineageId: 'unknown-lineage-id' }),
			404,
			'NOT_FOUND'
		);
		await expectApiError(
			() =>
				createShareFor(env.DB, other.id, {
					lineageId: pub.lineageId,
					versionId: unlisted.versionId
				}),
			404,
			'NOT_FOUND'
		);
		await expectApiError(
			() => createShareFor(env.DB, other.id, { lineageId: 'a/b' }),
			404,
			'NOT_FOUND'
		);
	});

	it('stats are owner-only and split anonymous opens from attributed users', async () => {
		const owner = await seedUser({});
		const sharer = await seedUser({});
		const viewer = await seedUser({});
		const pub = await publish(owner.id);
		const { shareId } = await createShareFor(env.DB, sharer.id, { lineageId: pub.lineageId });
		const now = Date.UTC(2026, 9, 16, 12);

		expect(await recordShareOpen(env.DB, shareId, now)).toBe(true);
		expect(await recordShareOpen(env.DB, shareId, now + 1000)).toBe(true);
		expect(await recordShareOpen(env.DB, shareId, now + 86_400_000)).toBe(true);
		await recordShareEvent(env.DB, {
			shareId,
			kind: 'favorited',
			userId: viewer.id,
			day: utcDay(now),
			at: now
		});
		await recordShareEvent(env.DB, {
			shareId,
			kind: 'previewed',
			userId: viewer.id,
			day: utcDay(now),
			at: now
		});

		const stats = await shareStatsFor(env.DB, sharer.id, shareId);
		expect(stats.opens).toEqual({
			total: 3,
			days: [
				{ day: '2026-10-16', count: 2 },
				{ day: '2026-10-17', count: 1 }
			]
		});
		expect(stats.attributed).toEqual({ previewed: 1, installed: 0, favorited: 1 });
		expect(JSON.stringify(stats)).not.toContain(viewer.id);

		await expectApiError(() => shareStatsFor(env.DB, owner.id, shareId), 404, 'NOT_FOUND');
		await expectApiError(() => shareStatsFor(env.DB, sharer.id, 'nope'), 404, 'NOT_FOUND');
	});

	it('opens of unknown shares are not counted', async () => {
		expect(await recordShareOpen(env.DB, 'unknown-share-id')).toBe(false);
		expect(await recordShareOpen(env.DB, '../x')).toBe(false);
	});

	it('the limited open path skips the count when the limiter refuses', async () => {
		const owner = await seedUser({});
		const pub = await publish(owner.id);
		const { shareId } = await createShareFor(env.DB, owner.id, { lineageId: pub.lineageId });
		const request = new Request(`${ORIGIN}/c/x`, { headers: { 'cf-connecting-ip': randomIp() } });
		const allowed = serverEnv();
		expect(await recordShareOpenLimited(allowed, { request, locals: signedOut() }, shareId)).toBe(
			true
		);
		const denied = { ...allowed, rateLimit: { ...allowed.rateLimit, write: fakeBinding('deny') } };
		expect(await recordShareOpenLimited(denied, { request, locals: signedOut() }, shareId)).toBe(
			false
		);
		expect(await anonOpens(shareId)).toBe(1);
	});

	it('loadSharedCurve: visibility, retraction and the shared version', async () => {
		const owner = await seedUser({});
		const pub = await publish(owner.id);
		const priv = await publish(owner.id, { visibility: 'private' });
		const gone = await publish(owner.id);
		await retract(gone.lineageId);

		const anon = { userId: null };
		const ok = await loadSharedCurve(env.DB, anon, pub.lineageId, null);
		expect(ok.kind).toBe('ok');
		if (ok.kind === 'ok') {
			expect(ok.curve.versionId).toBe(pub.versionId);
			expect(ok.curve.s1).toBe(pub.curve.s1);
			expect(ok.curve.shareId).toBeNull();
		}
		expect((await loadSharedCurve(env.DB, anon, priv.lineageId, null)).kind).toBe('not-found');
		expect((await loadSharedCurve(env.DB, { userId: owner.id }, priv.lineageId, null)).kind).toBe(
			'ok'
		);
		expect((await loadSharedCurve(env.DB, anon, gone.lineageId, null)).kind).toBe('gone');
		expect((await loadSharedCurve(env.DB, anon, 'missing-lineage', null)).kind).toBe('not-found');

		// A share of another lineage is ignored (no attribution to the wrong share).
		const other = await publish(owner.id);
		const foreign = await createShareFor(env.DB, owner.id, { lineageId: other.lineageId });
		const ignored = await loadSharedCurve(env.DB, anon, pub.lineageId, foreign.shareId);
		expect(ignored.kind === 'ok' ? ignored.curve.shareId : 'x').toBeNull();
	});
});

describe('/api/v1/shares routes', () => {
	it('POST /api/v1/shares: 201 with the link; private of others → 404; signed out → 401', async () => {
		const { POST } = await route<{ POST: Handler }>('api/v1/shares/+server.ts');
		const owner = await seedUser({});
		const other = await seedUser({});
		const pub = await publish(owner.id);
		const priv = await publish(owner.id, { visibility: 'private' });
		const routeId = '/api/v1/shares';

		const created = await POST(
			apiEvent({
				method: 'POST',
				path: routeId,
				routeId,
				locals: localsFor(other.id),
				body: { lineageId: pub.lineageId, channel: 'whatsapp' }
			})
		);
		expect(created.status).toBe(201);
		const body = (await created.json()) as { shareId: string; url: string };
		expect(body.url).toBe(`/c/${pub.lineageId}?s=${body.shareId}`);

		await expectErrorResponse(
			await POST(
				apiEvent({
					method: 'POST',
					path: routeId,
					routeId,
					locals: localsFor(other.id),
					body: { lineageId: priv.lineageId }
				})
			),
			404,
			'NOT_FOUND'
		);
		await expectErrorResponse(
			await POST(
				apiEvent({
					method: 'POST',
					path: routeId,
					routeId,
					locals: localsFor(other.id),
					body: { lineageId: pub.lineageId, channel: 'telegram' }
				})
			),
			400,
			'INVALID_BODY'
		);
		await expectErrorResponse(
			await POST(
				apiEvent({ method: 'POST', path: routeId, routeId, body: { lineageId: pub.lineageId } })
			),
			401,
			'AUTH_REQUIRED'
		);
	});

	it('GET /api/v1/shares/[id]/stats: owner only', async () => {
		const { GET } = await route<{ GET: Handler }>('api/v1/shares/[id]/stats/+server.ts');
		const owner = await seedUser({});
		const stranger = await seedUser({});
		const pub = await publish(owner.id);
		const { shareId } = await createShareFor(env.DB, owner.id, { lineageId: pub.lineageId });
		await recordShareOpen(env.DB, shareId);
		const path = `/api/v1/shares/${shareId}/stats`;
		const routeId = '/api/v1/shares/[id]/stats';

		const ok = await GET(
			apiEvent({ path, routeId, params: { id: shareId }, locals: localsFor(owner.id) })
		);
		expect(ok.status).toBe(200);
		expect(ok.headers.get('cache-control')).toContain('no-store');
		const stats = (await ok.json()) as { opens: { total: number } };
		expect(stats.opens.total).toBe(1);

		await expectErrorResponse(
			await GET(
				apiEvent({ path, routeId, params: { id: shareId }, locals: localsFor(stranger.id) })
			),
			404,
			'NOT_FOUND'
		);
		await expectErrorResponse(
			await GET(apiEvent({ path, routeId, params: { id: shareId } })),
			401,
			'AUTH_REQUIRED'
		);
	});

	it('POST /api/v1/shares/[id]/open: anonymous daily aggregate, rate limited, no PII', async () => {
		const { POST } = await route<{ POST: Handler }>('api/v1/shares/[id]/open/+server.ts');
		const owner = await seedUser({});
		const pub = await publish(owner.id);
		const { shareId } = await createShareFor(env.DB, owner.id, { lineageId: pub.lineageId });
		const path = `/api/v1/shares/${shareId}/open`;
		const routeId = '/api/v1/shares/[id]/open';
		const open = (extra: Partial<EventInit> = {}) =>
			POST(apiEvent({ method: 'POST', path, routeId, params: { id: shareId }, ...extra }));

		expect((await open()).status).toBe(204);
		expect((await open({ locals: localsFor(owner.id) })).status).toBe(204);
		expect(await anonOpens(shareId)).toBe(2);
		const rows = await env.DB.prepare('SELECT * FROM share_events WHERE share_id = ?')
			.bind(shareId)
			.all<Record<string, unknown>>();
		expect(rows.results).toHaveLength(1);
		expect(Object.keys(rows.results[0] ?? {}).sort()).toEqual(
			['anon_count', 'day', 'kind', 'share_id'].sort()
		);
		expect(
			await env.DB.prepare('SELECT count(*) AS n FROM share_event_users WHERE share_id = ?')
				.bind(shareId)
				.first<{ n: number }>()
		).toEqual({ n: 0 });

		const denied = await open({ platformEnv: { ...env, RL_WRITE: fakeBinding('deny') } });
		await expectErrorResponse(denied, 429, 'RATE_LIMITED');
		expect(await anonOpens(shareId)).toBe(2);

		await expectErrorResponse(
			await POST(
				apiEvent({
					method: 'POST',
					path: '/api/v1/shares/unknown-share/open',
					routeId,
					params: { id: 'unknown-share' }
				})
			),
			404,
			'NOT_FOUND'
		);
		const foreign = await POST({
			...apiEvent({ method: 'POST', path, routeId, params: { id: shareId } }),
			request: new Request(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: { origin: 'https://evil.example', 'cf-connecting-ip': randomIp() }
			})
		});
		await expectErrorResponse(foreign, 403, 'BAD_ORIGIN');
	});
});

describe('/c/[id] load', () => {
	it('declares prerender = false', async () => {
		const page = await route<{ prerender?: boolean }>('c/[id]/+page.server.ts');
		expect(page.prerender).toBe(false);
	});

	it('404 for private of others and unknown ids, 410 for retracted', async () => {
		const { load } = await route<{ load: Load }>('c/[id]/+page.server.ts');
		const owner = await seedUser({});
		const priv = await publish(owner.id, { visibility: 'private' });
		const gone = await publish(owner.id, { visibility: 'unlisted' });
		await retract(gone.lineageId);

		expect((await loadOutcome(load, pageEvent(priv.lineageId).event)).status).toBe(404);
		expect((await loadOutcome(load, pageEvent('no-such-lineage').event)).status).toBe(404);
		expect((await loadOutcome(load, pageEvent(gone.lineageId).event)).status).toBe(410);
		const own = await loadOutcome(
			load,
			pageEvent(priv.lineageId, { locals: localsFor(owner.id) }).event
		);
		expect(own.status).toBe(200);
		expect(own.data?.signedIn).toBe(true);
	});

	it('returns the card data and absolute OG URLs from PUBLIC_ORIGIN', async () => {
		const { load } = await route<{ load: Load }>('c/[id]/+page.server.ts');
		const owner = await seedUser({});
		const pub = await publish(owner.id);
		const result = await loadOutcome(load, pageEvent(pub.lineageId).event);
		expect(result.status).toBe(200);
		const data = result.data as {
			curve: { name: string; license: string; s1: string; versionId: string };
			meta: { canonical: string; image: string; indexable: boolean };
			signedIn: boolean;
		};
		const origin = serverEnv().publicOrigin.replace(/\/+$/, '');
		expect(data.meta).toEqual({
			canonical: `${origin}/c/${pub.lineageId}`,
			image: `${origin}/og/${pub.versionId}.png`,
			indexable: true
		});
		expect(data.curve.s1).toBe(pub.curve.s1);
		expect(data.curve.license).toBe('CC-BY-4.0');
		expect(data.signedIn).toBe(false);

		const unlisted = await publish(owner.id, { visibility: 'unlisted' });
		const hidden = await loadOutcome(load, pageEvent(unlisted.lineageId).event);
		expect((hidden.data as { meta: { indexable: boolean } }).meta.indexable).toBe(false);
	});

	it('records the open through waitUntil when ?s= belongs to the lineage', async () => {
		const { load } = await route<{ load: Load }>('c/[id]/+page.server.ts');
		const owner = await seedUser({});
		const pub = await publish(owner.id);
		const { shareId } = await createShareFor(env.DB, owner.id, { lineageId: pub.lineageId });

		const visit = pageEvent(pub.lineageId, { s: shareId });
		const result = await loadOutcome(load, visit.event);
		expect((result.data as { curve: { shareId: string } }).curve.shareId).toBe(shareId);
		expect(visit.pending).toHaveLength(1);
		await Promise.all(visit.pending);
		expect(await anonOpens(shareId)).toBe(1);

		const bogus = pageEvent(pub.lineageId, { s: 'not-a-real-share' });
		await loadOutcome(load, bogus.event);
		expect(bogus.pending).toHaveLength(0);
	});

	it('a failing counter never breaks the page', async () => {
		const { load } = await route<{ load: Load }>('c/[id]/+page.server.ts');
		const owner = await seedUser({});
		const pub = await publish(owner.id);
		const { shareId } = await createShareFor(env.DB, owner.id, { lineageId: pub.lineageId });
		const visit = pageEvent(pub.lineageId, { s: shareId });
		const event = {
			...visit.event,
			platform: { ...visit.event.platform, env: { ...env, RL_WRITE: fakeBinding('throw') } }
		};
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const result = await loadOutcome(load, event);
		expect(result.status).toBe(200);
		await Promise.all(visit.pending);
		expect(await anonOpens(shareId)).toBe(0);
		log.mockRestore();
	});
});
