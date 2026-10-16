// Rankings (T4.1 primitives for T4.6): distinct verified users, owner excluded, windows,
// deterministic tie-break (score, recent activity, id), atomic and idempotent recompute, stale
// runs ignored.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	addFavorite,
	getRankingState,
	listRankings,
	recomputeRankings,
	recordActivity
} from '#lib/server/social/repo.ts';
import { DAY_MS, type RankingMetric, type RankingWindow } from '#lib/server/social/types.ts';
import { publish, seedUser } from './helpers.ts';

async function ranked(metric: RankingMetric, window: RankingWindow): Promise<string[]> {
	const seen: string[] = [];
	let cursor: string | null = null;
	for (let guard = 0; guard < 100; guard += 1) {
		const page = await listRankings(env.DB, metric, window, { cursor, limit: 100 });
		seen.push(...page.items.map((entry) => entry.lineage.id));
		if (!page.nextCursor) break;
		cursor = page.nextCursor;
	}
	return seen;
}

async function stored(metric: RankingMetric, window: RankingWindow) {
	const rows = await env.DB.prepare(
		'SELECT lineage_id, score, rank, computed_at FROM rankings WHERE metric = ? AND "window" = ? ORDER BY rank'
	)
		.bind(metric, window)
		.all<{ lineage_id: string; score: number; rank: number; computed_at: number }>();
	return rows.results;
}

describe('favorites ranking', () => {
	it('scores distinct verified users, excludes the owner, breaks ties by recency then id', async () => {
		const owner = await seedUser();
		const fans = [await seedUser(), await seedUser(), await seedUser()];
		const unverified = await seedUser({ verified: false });
		const now = Date.now();
		const top = await publish(owner.id);
		const tieOld = await publish(owner.id);
		const tieNew = await publish(owner.id);
		const old = await publish(owner.id);
		for (const fan of fans) await addFavorite(env.DB, fan.id, top.lineageId, now - 1000);
		await addFavorite(env.DB, owner.id, top.lineageId, now);
		await addFavorite(env.DB, unverified.id, tieOld.lineageId, now);
		await addFavorite(env.DB, owner.id, tieOld.lineageId, now);
		await addFavorite(env.DB, fans[0]?.id ?? '', tieOld.lineageId, now - 3000);
		await addFavorite(env.DB, fans[1]?.id ?? '', tieNew.lineageId, now - 2000);
		await addFavorite(env.DB, fans[2]?.id ?? '', old.lineageId, now - 10 * DAY_MS);

		// favorites/all is also recomputed by visibility.test.ts: assert the data, not who ran last.
		await recomputeRankings(env.DB, 'favorites', 'all', Date.now());
		const ids = [top, tieNew, tieOld, old].map((item) => item.lineageId);
		const order = (await ranked('favorites', 'all')).filter((id) => ids.includes(id));
		expect(order).toEqual(ids);
		const rows = (await stored('favorites', 'all')).filter((row) => ids.includes(row.lineage_id));
		expect(rows.map((row) => row.score)).toEqual([3, 1, 1, 1]);
		expect(rows.every((row) => row.computed_at >= now)).toBe(true);

		await recomputeRankings(env.DB, 'favorites', '7d', now);
		const week = (await ranked('favorites', '7d')).filter((id) => ids.includes(id));
		expect(week).toEqual([top.lineageId, tieNew.lineageId, tieOld.lineageId]);
	});

	it('is idempotent and ignores a run older than the stored one', async () => {
		const owner = await seedUser();
		const fan = await seedUser();
		const { lineageId } = await publish(owner.id);
		const now = Date.now();
		await addFavorite(env.DB, fan.id, lineageId, now);
		await recomputeRankings(env.DB, 'favorites', '30d', now);
		const first = await stored('favorites', '30d');
		const mine = (rows: typeof first) => rows.filter((row) => row.lineage_id === lineageId);
		expect(mine(first)).toEqual([expect.objectContaining({ score: 1, computed_at: now })]);
		expect(first.map((row) => row.rank)).toEqual(first.map((_, index) => index + 1));
		const state = await getRankingState(env.DB, 'favorites', '30d');
		expect(state).toEqual({ computedAt: now, rowCount: first.length });

		const again = await recomputeRankings(env.DB, 'favorites', '30d', now);
		expect(again.applied).toBe(true);
		expect(mine(await stored('favorites', '30d'))).toEqual(mine(first));

		const stale = await recomputeRankings(env.DB, 'favorites', '30d', now - 60_000);
		expect(stale.applied).toBe(false);
		expect(stale.rows).toBe(0);
		expect(mine(await stored('favorites', '30d'))).toEqual(mine(first));
		expect((await getRankingState(env.DB, 'favorites', '30d'))?.computedAt).toBe(now);
		await expect(
			recomputeRankings(env.DB, 'favorites', 'forever' as RankingWindow, now)
		).rejects.toMatchObject({ code: 'invalid-input' });
	});
});

describe('installs ranking', () => {
	it('counts distinct users who really installed inside the window', async () => {
		const owner = await seedUser();
		const users = [await seedUser(), await seedUser()];
		const now = Date.now();
		const many = await publish(owner.id);
		const one = await publish(owner.id);
		for (const user of users) {
			await recordActivity(env.DB, user.id, many.lineageId, 'installed', now);
			await recordActivity(env.DB, user.id, many.lineageId, 'installed', now);
		}
		await recordActivity(env.DB, users[0]?.id ?? '', one.lineageId, 'installed', now);
		await recordActivity(env.DB, users[1]?.id ?? '', one.lineageId, 'previewed', now);
		await recomputeRankings(env.DB, 'installs', '7d', now);
		const ids = [many.lineageId, one.lineageId];
		const rows = (await stored('installs', '7d')).filter((row) => ids.includes(row.lineage_id));
		expect(rows.map((row) => [row.lineage_id, row.score])).toEqual([
			[many.lineageId, 2],
			[one.lineageId, 1]
		]);
	});
});
