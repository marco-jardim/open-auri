// T4.6 routes: GET /api/v1/rankings and GET /api/v1/feed (public, 60 s public cache, ETag/304,
// `computedAt`, stable pagination, private and unlisted never listed, 400 on bad query).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { CACHE_PUBLIC_60 } from '#lib/server/api/index.ts';
import { runRankingsJob, type FeedPage, type RankingsPage } from '#lib/server/social/rankings.ts';
import { addFavorite, encodeCursor, recordActivity } from '#lib/server/social/repo.ts';
import { GET as feedGet } from '../../../../src/routes/api/v1/feed/+server.ts';
import { GET as rankingsGet } from '../../../../src/routes/api/v1/rankings/+server.ts';
import { expectErrorResponse } from '../../api/helpers.ts';
import { getEvent, publish, seedUser } from './helpers.ts';

const RANKINGS = '/api/v1/rankings';
const FEED = '/api/v1/feed';

function rankings(query: string, headers: Record<string, string> = {}): Promise<Response> {
	return rankingsGet(getEvent(RANKINGS, `${RANKINGS}${query}`, headers));
}

function feed(query: string, headers: Record<string, string> = {}): Promise<Response> {
	return feedGet(getEvent(FEED, `${FEED}${query}`, headers));
}

describe('GET /api/v1/rankings', () => {
	it('serves the materialized ranking with computedAt, public cache and ETag/304', async () => {
		const owner = await seedUser();
		const fan = await seedUser();
		const item = await publish(owner.id);
		const now = Date.now();
		await recordActivity(env.DB, fan.id, item.lineageId, 'installed', now - 1000);
		await runRankingsJob(env.DB, now);

		const response = await rankings('?metric=installs&window=30d&limit=100');
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe(CACHE_PUBLIC_60);
		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
		const etag = response.headers.get('etag');
		expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
		const body = (await response.json()) as RankingsPage;
		expect(body).toMatchObject({ metric: 'installs', window: '30d' });
		expect(body.computedAt).toBeGreaterThanOrEqual(now);
		expect(body.items.every((entry) => entry.lineage.visibility === 'public')).toBe(true);
		const ranks = body.items.map((entry) => entry.rank);
		expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);

		const again = await rankings('?metric=installs&window=30d&limit=100', {
			'if-none-match': etag ?? ''
		});
		// Another file may recompute in between; then the body (and ETag) legitimately changes.
		if (again.status === 304) {
			expect(again.headers.get('etag')).toBe(etag);
			expect(again.headers.get('cache-control')).toBe(CACHE_PUBLIC_60);
			expect(await again.text()).toBe('');
		} else {
			expect(again.status).toBe(200);
			expect(again.headers.get('etag')).not.toBe(etag);
		}
	});

	it('defaults to favorites over 7 days and pages by rank without repeats', async () => {
		await runRankingsJob(env.DB, Date.now());
		const first = await rankings('?limit=1');
		expect(first.status).toBe(200);
		const page1 = (await first.json()) as RankingsPage;
		expect(page1).toMatchObject({ metric: 'favorites', window: '7d' });
		if (page1.nextCursor === null) {
			expect(page1.items.length).toBeLessThanOrEqual(1);
			return;
		}
		const page2 = (await (
			await rankings(`?limit=1&cursor=${page1.nextCursor}`)
		).json()) as RankingsPage;
		const before = page1.items[0]?.rank ?? 0;
		expect(page2.items.every((entry) => entry.rank > before)).toBe(true);
	});

	it('answers 400 to a bad metric, window, limit or cursor (no-store)', async () => {
		await expectErrorResponse(await rankings('?metric=likes'), 400, 'INVALID_BODY');
		await expectErrorResponse(await rankings('?window=1y'), 400, 'INVALID_BODY');
		await expectErrorResponse(await rankings('?limit=0'), 400, 'INVALID_BODY');
		await expectErrorResponse(await rankings('?limit=abc'), 400, 'INVALID_BODY');
		await expectErrorResponse(await rankings('?cursor=%21%21'), 400, 'INVALID_CURSOR');
		const wrongShape = encodeCursor([1, 'x']);
		await expectErrorResponse(await rankings(`?cursor=${wrongShape}`), 400, 'INVALID_CURSOR');
	});
});

describe('GET /api/v1/feed', () => {
	it('sort=new: newest public lineages, stable keyset pages, never private or unlisted', async () => {
		const owner = await seedUser();
		// Old, random creation times: nobody else's lineages sit in this slice of the feed.
		const base = 946_684_800_000 + Math.floor(Math.random() * 1e10);
		const a = await publish(owner.id, { now: base + 1 });
		const tie1 = await publish(owner.id, { now: base + 2 });
		const tie2 = await publish(owner.id, { now: base + 2 });
		const hidden = [
			await publish(owner.id, { now: base + 2, visibility: 'private' }),
			await publish(owner.id, { now: base + 3, visibility: 'unlisted' }),
			await publish(owner.id, { now: base + 3, visibility: 'private' })
		].map((item) => item.lineageId);
		const c = await publish(owner.id, { now: base + 3 });
		const ties = [tie1.lineageId, tie2.lineageId].sort().reverse();
		const expected = [c.lineageId, ...ties, a.lineageId];

		const start = encodeCursor([base + 4, '']);
		const seen: string[] = [];
		let cursor: string | null = start;
		for (let guard = 0; guard < 2 && cursor !== null; guard += 1) {
			const response = await feed(`?sort=new&limit=2&cursor=${cursor}`);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe(CACHE_PUBLIC_60);
			const body = (await response.json()) as FeedPage;
			expect(body).toMatchObject({ sort: 'new', window: null, computedAt: null });
			seen.push(...body.items.map((item) => item.lineage.id));
			cursor = body.nextCursor;
		}
		expect(seen).toEqual(expected);
		for (const id of hidden) expect(seen).not.toContain(id);
	});

	it('defaults to sort=new and supports ETag/304', async () => {
		const response = await feed('?limit=5');
		expect(response.status).toBe(200);
		const body = (await response.json()) as FeedPage;
		expect(body.sort).toBe('new');
		expect(body.items.every((item) => item.lineage.visibility === 'public')).toBe(true);
		const etag = response.headers.get('etag') ?? '';
		const again = await feed('?limit=5', { 'if-none-match': etag });
		// A lineage published by another file in between changes the body (and the ETag).
		expect([200, 304]).toContain(again.status);
		if (again.status === 304) expect(again.headers.get('etag')).toBe(etag);
	});

	it('sort=favorites|installs read the materialized ranking of the window', async () => {
		const owner = await seedUser();
		const fan = await seedUser();
		const item = await publish(owner.id);
		const privateItem = await publish(owner.id);
		const now = Date.now();
		await addFavorite(env.DB, fan.id, item.lineageId, now - 1000);
		await addFavorite(env.DB, fan.id, privateItem.lineageId, now - 1000);
		await env.DB.prepare("UPDATE lineages SET visibility = 'private' WHERE id = ?")
			.bind(privateItem.lineageId)
			.run();
		await runRankingsJob(env.DB, now);

		const seen: string[] = [];
		let cursor: string | null = null;
		let computedAt: number | null = null;
		for (let guard = 0; guard < 20; guard += 1) {
			const next: string = cursor ? `&cursor=${cursor}` : '';
			const response = await feed(`?sort=favorites&window=30d&limit=100${next}`);
			expect(response.status).toBe(200);
			const body = (await response.json()) as FeedPage;
			expect(body).toMatchObject({ sort: 'favorites', window: '30d' });
			computedAt = body.computedAt;
			for (const entry of body.items) {
				expect(entry.rank).toEqual(expect.any(Number));
				expect(entry.score).toEqual(expect.any(Number));
				seen.push(entry.lineage.id);
			}
			cursor = body.nextCursor;
			if (cursor === null) break;
		}
		expect(computedAt).toBeGreaterThanOrEqual(now);
		expect(seen).toContain(item.lineageId);
		expect(seen).not.toContain(privateItem.lineageId);
		expect(new Set(seen).size).toBe(seen.length);

		const installs = (await (await feed('?sort=installs&window=all')).json()) as FeedPage;
		expect(installs).toMatchObject({ sort: 'installs', window: 'all' });
	});

	it('answers 400 to a bad sort, window or a cursor of another sort', async () => {
		await expectErrorResponse(await feed('?sort=hot'), 400, 'INVALID_BODY');
		await expectErrorResponse(await feed('?sort=favorites&window=90d'), 400, 'INVALID_BODY');
		const rankCursor = encodeCursor([3]);
		await expectErrorResponse(await feed(`?sort=new&cursor=${rankCursor}`), 400, 'INVALID_CURSOR');
		const newCursor = encodeCursor([1, 'x']);
		await expectErrorResponse(
			await feed(`?sort=installs&cursor=${newCursor}`),
			400,
			'INVALID_CURSOR'
		);
	});
});
