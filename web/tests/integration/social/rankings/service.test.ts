// T4.6 rankings service: the job recomputes every metric × window pair through the repository;
// scores count distinct verified, non-banned users other than the owner; exclusions apply at
// compute and at read time; windows; deterministic tie-break; idempotent recompute (an older run is
// ignored). Other files share the database and recompute the same pairs, so assertions only look
// at this file's lineages and never at absolute ranks or global counts.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	addFavorite,
	encodeCursor,
	getRankingState,
	recordActivity
} from '#lib/server/social/repo.ts';
import { readFeed, readRankings, runRankingsJob } from '#lib/server/social/rankings.ts';
import {
	DAY_MS,
	RANKING_METRICS,
	RANKING_WINDOWS,
	type RankingWindow
} from '#lib/server/social/types.ts';
import {
	ban,
	EXCLUSIONS,
	exclude,
	internalKeyPaths,
	only,
	publish,
	rankedEntries,
	seedUser,
	type Exclusion,
	type Published,
	type SeededUser
} from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

async function fans(count: number): Promise<SeededUser[]> {
	const users: SeededUser[] = [];
	for (let i = 0; i < count; i += 1) users.push(await seedUser());
	return users;
}

function target(item: Published, ownerUserId: string) {
	return { lineageId: item.lineageId, curveId: item.curve.id, ownerUserId };
}

describe('runRankingsJob', () => {
	it('recomputes the six metric × window pairs and summarizes the run', async () => {
		const now = Date.now();
		const summary = await runRankingsJob(env.DB, now);
		expect(summary.computedAt).toBe(now);
		expect(summary.failed).toEqual([]);
		expect(summary.pairs.map((pair) => `${pair.metric}/${pair.window}`)).toEqual(
			RANKING_METRICS.flatMap((metric) => RANKING_WINDOWS.map((window) => `${metric}/${window}`))
		);
		expect(summary.applied + summary.skipped).toBe(6);
		for (const metric of RANKING_METRICS) {
			for (const window of RANKING_WINDOWS) {
				const state = await getRankingState(env.DB, metric, window);
				expect(state?.computedAt).toBeGreaterThanOrEqual(now);
			}
		}
		await expect(runRankingsJob(env.DB, Number.NaN)).rejects.toMatchObject({
			code: 'invalid-input'
		});
	});

	it('counts distinct verified, non-banned users and never the owner', async () => {
		const owner = await seedUser();
		const [a, b, c] = await fans(3);
		const unverified = await seedUser({ verified: false });
		const banned = await seedUser();
		const now = Date.now();
		const top = await publish(owner.id);
		const two = await publish(owner.id);
		for (const fan of [a, b, c, owner, unverified, banned]) {
			await addFavorite(env.DB, fan?.id ?? '', top.lineageId, now - 1000);
		}
		await addFavorite(env.DB, a?.id ?? '', two.lineageId, now - 1000);
		await addFavorite(env.DB, b?.id ?? '', two.lineageId, now - 1000);
		await ban(banned.id);
		for (const user of [a, b, owner]) {
			await recordActivity(env.DB, user?.id ?? '', two.lineageId, 'installed', now - 500);
			await recordActivity(env.DB, user?.id ?? '', two.lineageId, 'installed', now - 400);
		}
		await recordActivity(env.DB, c?.id ?? '', two.lineageId, 'previewed', now - 400);
		await recordActivity(env.DB, unverified.id, two.lineageId, 'installed', now - 400);

		await runRankingsJob(env.DB, Date.now());
		const mine = [top.lineageId, two.lineageId];
		const favorites = (await rankedEntries('favorites', 'all')).filter((entry) =>
			mine.includes(entry.lineage.id)
		);
		expect(favorites.map((entry) => [entry.lineage.id, entry.score])).toEqual([
			[top.lineageId, 3],
			[two.lineageId, 2]
		]);
		const installs = (await rankedEntries('installs', '7d')).filter((entry) =>
			mine.includes(entry.lineage.id)
		);
		expect(installs.map((entry) => [entry.lineage.id, entry.score])).toEqual([[two.lineageId, 2]]);
	});

	it('applies the 7d, 30d and all windows', async () => {
		const owner = await seedUser();
		const [fan] = await fans(1);
		const now = Date.now();
		const week = await publish(owner.id);
		const month = await publish(owner.id);
		const old = await publish(owner.id);
		await addFavorite(env.DB, fan?.id ?? '', week.lineageId, now - DAY_MS);
		await addFavorite(env.DB, fan?.id ?? '', month.lineageId, now - 10 * DAY_MS);
		await addFavorite(env.DB, fan?.id ?? '', old.lineageId, now - 40 * DAY_MS);
		await recordActivity(env.DB, fan?.id ?? '', old.lineageId, 'installed', now - 40 * DAY_MS);

		await runRankingsJob(env.DB, now);
		const mine = [week.lineageId, month.lineageId, old.lineageId];
		const expected: Record<RankingWindow, string[]> = {
			'7d': [week.lineageId],
			'30d': [week.lineageId, month.lineageId],
			all: [week.lineageId, month.lineageId, old.lineageId]
		};
		for (const window of RANKING_WINDOWS) {
			expect(only(await rankedEntries('favorites', window), mine)).toEqual(expected[window]);
		}
		expect(only(await rankedEntries('installs', '30d'), mine)).toEqual([]);
		expect(only(await rankedEntries('installs', 'all'), mine)).toEqual([old.lineageId]);
	});

	it('breaks ties by score, then most recent activity, then lineage id', async () => {
		const owner = await seedUser();
		const [a, b] = await fans(2);
		const now = Date.now();
		const best = await publish(owner.id);
		const recent = await publish(owner.id);
		const tieX = await publish(owner.id);
		const tieY = await publish(owner.id);
		await addFavorite(env.DB, a?.id ?? '', best.lineageId, now - 5 * DAY_MS);
		await addFavorite(env.DB, b?.id ?? '', best.lineageId, now - 5 * DAY_MS);
		await addFavorite(env.DB, a?.id ?? '', recent.lineageId, now - 1000);
		await addFavorite(env.DB, a?.id ?? '', tieX.lineageId, now - 2000);
		await addFavorite(env.DB, b?.id ?? '', tieY.lineageId, now - 2000);

		await runRankingsJob(env.DB, now);
		const ties = [tieX.lineageId, tieY.lineageId].sort();
		const mine = [best.lineageId, recent.lineageId, ...ties];
		const expected = [best.lineageId, recent.lineageId, ...ties];
		expect(only(await rankedEntries('favorites', '30d'), mine)).toEqual(expected);
		expect(only(await rankedEntries('favorites', 'all'), mine)).toEqual(expected);
		const entries = (await rankedEntries('favorites', 'all')).filter((entry) =>
			mine.includes(entry.lineage.id)
		);
		const ranks = entries.map((entry) => entry.rank);
		expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
	});

	it('excludes private, unlisted, moderated, retracted, gate-failed and banned-owner lineages at compute time', async () => {
		const [fan] = await fans(1);
		const now = Date.now();
		const ownerOk = await seedUser();
		const control = await publish(ownerOk.id);
		await addFavorite(env.DB, fan?.id ?? '', control.lineageId, now - 1000);
		const excluded: string[] = [];
		for (const kind of EXCLUSIONS) {
			const owner = await seedUser();
			const item = await publish(owner.id);
			await addFavorite(env.DB, fan?.id ?? '', item.lineageId, now - 1000);
			await recordActivity(env.DB, fan?.id ?? '', item.lineageId, 'installed', now - 1000);
			await exclude(kind, target(item, owner.id));
			excluded.push(item.lineageId);
		}

		await runRankingsJob(env.DB, Date.now());
		const mine = [control.lineageId, ...excluded];
		expect(only(await rankedEntries('favorites', '7d'), mine)).toEqual([control.lineageId]);
		expect(only(await rankedEntries('installs', '7d'), mine)).toEqual([]);
		const stored = await env.DB.prepare(
			`SELECT count(*) AS n FROM rankings WHERE lineage_id IN (${excluded.map(() => '?').join(', ')})`
		)
			.bind(...excluded)
			.first<{ n: number }>();
		expect(stored?.n).toBe(0);
	});

	it('re-checks every exclusion at read time, before the next run', async () => {
		const [fan] = await fans(1);
		const now = Date.now();
		const ownerOk = await seedUser();
		const control = await publish(ownerOk.id);
		await addFavorite(env.DB, fan?.id ?? '', control.lineageId, now - 1000);
		const victims: { kind: Exclusion; item: Published; ownerId: string }[] = [];
		for (const kind of EXCLUSIONS) {
			const owner = await seedUser();
			const item = await publish(owner.id);
			await addFavorite(env.DB, fan?.id ?? '', item.lineageId, now - 1000);
			victims.push({ kind, item, ownerId: owner.id });
		}
		const mine = [control.lineageId, ...victims.map((victim) => victim.item.lineageId)];

		await runRankingsJob(env.DB, Date.now());
		expect(only(await rankedEntries('favorites', '7d'), mine).sort()).toEqual([...mine].sort());

		for (const victim of victims) await exclude(victim.kind, target(victim.item, victim.ownerId));
		expect(only(await rankedEntries('favorites', '7d'), mine)).toEqual([control.lineageId]);
		const feed = await readFeed(env.DB, { sort: 'favorites', window: '7d', limit: 100 });
		expect(internalKeyPaths(feed)).toEqual([]);
	});

	it('is idempotent: same input gives the same rows and an older run changes nothing', async () => {
		const owner = await seedUser();
		const [a, b] = await fans(2);
		const now = Date.now();
		const one = await publish(owner.id);
		const two = await publish(owner.id);
		await addFavorite(env.DB, a?.id ?? '', one.lineageId, now - 1000);
		await addFavorite(env.DB, b?.id ?? '', one.lineageId, now - 1000);
		await addFavorite(env.DB, a?.id ?? '', two.lineageId, now - 1000);
		const mine = [one.lineageId, two.lineageId];
		const snapshot = async () =>
			(await rankedEntries('favorites', '30d'))
				.filter((entry) => mine.includes(entry.lineage.id))
				.map((entry) => [entry.lineage.id, entry.score]);

		const run = Date.now();
		await runRankingsJob(env.DB, run);
		const first = await snapshot();
		expect(first).toEqual([
			[one.lineageId, 2],
			[two.lineageId, 1]
		]);

		await runRankingsJob(env.DB, run);
		expect(await snapshot()).toEqual(first);

		const stale = await runRankingsJob(env.DB, run - 60_000);
		expect(stale).toMatchObject({ applied: 0, skipped: 6, rows: 0, failed: [] });
		expect(await snapshot()).toEqual(first);
		expect((await getRankingState(env.DB, 'favorites', '30d'))?.computedAt).toBeGreaterThanOrEqual(
			run
		);

		const page = await readRankings(env.DB, 'favorites', '30d', { limit: 1 });
		expect(page.computedAt).toBeGreaterThanOrEqual(run);
	});

	it('keeps going when a pair fails and reports it', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const broken = new Proxy(env.DB, {
			get(target, property) {
				if (property === 'batch') return () => Promise.reject(new Error('d1 down'));
				const value: unknown = Reflect.get(target, property);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const summary = await runRankingsJob(broken, Date.now());
		expect(summary.failed).toHaveLength(6);
		expect(summary).toMatchObject({ applied: 0, skipped: 0, rows: 0 });
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({
				event: 'rankings.pair_failed',
				metric: 'favorites',
				window: '7d',
				error: 'Error'
			})
		);
	});
});

describe('readRankings and readFeed', () => {
	it('validates metric, window and cursor', async () => {
		await expect(readRankings(env.DB, 'likes' as 'favorites', '7d')).rejects.toMatchObject({
			code: 'invalid-input'
		});
		await expect(readRankings(env.DB, 'favorites', '7d', { cursor: '!!' })).rejects.toMatchObject({
			code: 'invalid-cursor'
		});
		await expect(readFeed(env.DB, { sort: 'likes' as 'new', window: '7d' })).rejects.toMatchObject({
			code: 'invalid-input'
		});
	});

	it('sort=new lists only public lineages, newest first, with no ranking fields', async () => {
		const owner = await seedUser();
		// Old, random creation times: nobody else's lineages sit in this slice of the feed.
		const base = 946_684_800_000 + Math.floor(Math.random() * 1e10);
		const older = await publish(owner.id, { now: base + 1 });
		const hiddenA = await publish(owner.id, { now: base + 2, visibility: 'private' });
		const hiddenB = await publish(owner.id, { now: base + 2, visibility: 'unlisted' });
		const newer = await publish(owner.id, { now: base + 3 });
		const feed = await readFeed(env.DB, {
			sort: 'new',
			cursor: encodeCursor([base + 4, '']),
			limit: 2
		});
		expect(feed).toMatchObject({ sort: 'new', window: null, computedAt: null });
		expect(feed.items.map((item) => item.lineage.id)).toEqual([newer.lineageId, older.lineageId]);
		expect(feed.items.every((item) => item.rank === null && item.score === null)).toBe(true);
		const ids = feed.items.map((item) => item.lineage.id);
		expect(ids).not.toContain(hiddenA.lineageId);
		expect(ids).not.toContain(hiddenB.lineageId);
	});
});
