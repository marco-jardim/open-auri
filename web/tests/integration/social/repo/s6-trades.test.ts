// S6 anonymous batches (no user, receipt withdrawal) and S7 trades (one active trade per user,
// atomic pairing under concurrency, blind preview then reveal, expiry, averages).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	cancelTrade,
	createTrade,
	deleteS6BatchByReceipt,
	expireTrades,
	getTradeForUser,
	insertS6Batch,
	listOwnTrades,
	listS6Pairs,
	pairTrade,
	scoreTrade,
	tradeAverages,
	tryPairTrades
} from '#lib/server/social/repo.ts';
import { TRADE_TTL_MS } from '#lib/server/social/types.ts';
import { count, publish, seedUser, sid, type Published } from './helpers.ts';

async function receipt(): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', crypto.getRandomValues(new Uint8Array(32)));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('S6 batches', () => {
	it('stores the pairs, refuses a reused receipt and withdraws by receipt', async () => {
		const hash = await receipt();
		const id = sid('s6');
		const pairs = [
			{ a: 'abcdefghijkl', b: 'mnopqrstuvwx', choice: 'a' as const, levelMatched: true },
			{ a: 'preset.flat', b: 'abcdefghijkl', choice: 'tie' as const, levelMatched: false }
		];
		const input = { id, receiptHash: hash, consentVer: 's6-v1', day: '2026-10-16', pairs };
		expect(await insertS6Batch(env.DB, input)).toEqual({ ok: true, value: { id } });
		expect(await insertS6Batch(env.DB, { ...input, id: sid('s6') })).toEqual({
			ok: false,
			code: 'duplicate'
		});
		const stored = (await listS6Pairs(env.DB, { limit: 5000 })).filter(
			(pair) => pair.a === 'preset.flat' || pair.b === 'mnopqrstuvwx'
		);
		expect(
			stored
				.slice(-2)
				.map(({ a, b, choice, levelMatched, day }) => ({ a, b, choice, levelMatched, day }))
		).toEqual(pairs.map((pair) => ({ ...pair, day: '2026-10-16' })));
		expect(await deleteS6BatchByReceipt(env.DB, hash)).toBe(true);
		expect(await deleteS6BatchByReceipt(env.DB, hash)).toBe(false);
		expect(await deleteS6BatchByReceipt(env.DB, 'not-a-hash')).toBe(false);
		expect(await count('SELECT count(*) AS n FROM s6_pairs WHERE batch_id = ?', id)).toBe(0);
	});

	it('refuses malformed batches', async () => {
		const base = {
			id: sid('s6'),
			receiptHash: await receipt(),
			consentVer: 's6-v1',
			day: '2026-10-16',
			pairs: [{ a: 'aaaa', b: 'bbbb', choice: 'b' as const, levelMatched: true }]
		};
		for (const broken of [
			{ ...base, pairs: [] },
			{ ...base, day: '2026-10-16T10:00' },
			{ ...base, receiptHash: 'ABC' },
			{ ...base, consentVer: '' },
			{ ...base, pairs: [{ a: 'same', b: 'same', choice: 'a' as const, levelMatched: true }] },
			{ ...base, pairs: [{ a: 'Bad Id', b: 'x', choice: 'a' as const, levelMatched: true }] }
		]) {
			expect(await insertS6Batch(env.DB, broken)).toEqual({ ok: false, code: 'invalid-input' });
		}
	});
});

interface Player {
	userId: string;
	published: Published;
}

async function player(): Promise<Player> {
	const user = await seedUser();
	return { userId: user.id, published: await publish(user.id) };
}

async function join(who: Player, now = Date.now()) {
	const result = await createTrade(env.DB, {
		id: sid('trade'),
		userId: who.userId,
		lineageId: who.published.lineageId,
		versionId: who.published.versionId,
		now
	});
	if (!result.ok) throw new Error(result.code);
	return result.value;
}

describe('S7 trades', () => {
	it('one active trade per user; only readable, gate-approved versions', async () => {
		const me = await player();
		const owner = await seedUser();
		const hidden = await publish(owner.id, { visibility: 'private' });
		await join(me);
		expect(
			await createTrade(env.DB, {
				id: sid('trade'),
				userId: me.userId,
				lineageId: me.published.lineageId,
				versionId: me.published.versionId,
				now: Date.now()
			})
		).toEqual({ ok: false, code: 'already-active' });
		const other = await seedUser();
		expect(
			await createTrade(env.DB, {
				id: sid('trade'),
				userId: other.id,
				lineageId: hidden.lineageId,
				versionId: hidden.versionId,
				now: Date.now()
			})
		).toEqual({ ok: false, code: 'not-found' });
		expect(
			await createTrade(env.DB, {
				id: sid('trade'),
				userId: other.id,
				lineageId: me.published.lineageId,
				versionId: hidden.versionId,
				now: Date.now()
			})
		).toEqual({ ok: false, code: 'not-found' });
	});

	it('concurrent pairing primitives on the same waiting trade: exactly one match', async () => {
		const [a, b, c] = [await player(), await player(), await player()];
		const ta = await join(a);
		const tb = await join(b);
		const tc = await join(c);
		const now = Date.now();
		const results = await Promise.all([
			tryPairTrades(env.DB, tb.id, ta.id, now),
			tryPairTrades(env.DB, tc.id, ta.id, now)
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		const winner = results[0] ? tb : tc;
		const loser = results[0] ? tc : tb;
		expect(await getTradeForUser(env.DB, ta.id, a.userId)).toMatchObject({
			status: 'matched',
			matchId: winner.id
		});
		const winnerView = await getTradeForUser(env.DB, winner.id, winner.userId);
		expect(winnerView).toMatchObject({ status: 'matched', matchId: ta.id });
		expect(await getTradeForUser(env.DB, loser.id, loser.userId)).toMatchObject({
			status: 'waiting',
			matchId: null,
			partner: null
		});
		// Matched trades never pair again.
		expect(await tryPairTrades(env.DB, loser.id, ta.id, now)).toBe(false);
		expect(await tryPairTrades(env.DB, loser.id, winner.id, now)).toBe(false);
		await cancelTrade(env.DB, loser.id, loser.userId);
	});

	it('two concurrent joins on the oldest waiting trade: exactly one is matched with it', async () => {
		const [a, b, c] = [await player(), await player(), await player()];
		// The oldest waiting trade, so both joins pick it first.
		const ta = await join(a, Date.now() - TRADE_TTL_MS + 10 * 60_000);
		const tb = await join(b);
		const tc = await join(c);
		const now = Date.now();
		const [rb, rc] = await Promise.all([
			pairTrade(env.DB, tb.id, b.userId, now, 1),
			pairTrade(env.DB, tc.id, c.userId, now, 1)
		]);
		const results = [rb, rc].map((result) => (result.ok ? result.value : null));
		const withA = results.filter((value) => value?.status === 'matched' && value.matchId === ta.id);
		expect(withA).toHaveLength(1);
		expect(results.filter((value) => value?.status === 'waiting')).toHaveLength(1);
		const partner = (await getTradeForUser(env.DB, ta.id, a.userId))?.matchId;
		expect([tb.id, tc.id]).toContain(partner);
		for (const [trade, who] of [
			[tb, b],
			[tc, c]
		] as const) {
			await cancelTrade(env.DB, trade.id, who.userId);
		}
	});

	it('blind preview, reveal after both scores, averages and the own list', async () => {
		const [a, b] = [await player(), await player()];
		const ta = await join(a);
		const tb = await join(b);
		const now = Date.now();
		expect(await tryPairTrades(env.DB, ta.id, tb.id, now)).toBe(true);
		expect(await pairTrade(env.DB, ta.id, a.userId, now)).toEqual({
			ok: true,
			value: { status: 'matched', matchId: tb.id }
		});

		const blind = await getTradeForUser(env.DB, ta.id, a.userId);
		expect(blind?.partner).toEqual({
			curveId: b.published.curve.id,
			s1: b.published.curve.s1,
			lineageId: null,
			versionId: null,
			score: null
		});
		expect(JSON.stringify(blind)).not.toContain(b.userId);

		expect(await scoreTrade(env.DB, ta.id, a.userId, 4, now + 1)).toEqual({
			ok: true,
			value: { revealed: false }
		});
		expect(await scoreTrade(env.DB, ta.id, a.userId, 5, now + 2)).toEqual({
			ok: false,
			code: 'duplicate'
		});
		expect(await scoreTrade(env.DB, ta.id, b.userId, 5, now + 2)).toEqual({
			ok: false,
			code: 'not-found'
		});
		expect(await scoreTrade(env.DB, tb.id, b.userId, 9, now + 2)).toEqual({
			ok: false,
			code: 'invalid-input'
		});
		expect(await scoreTrade(env.DB, tb.id, b.userId, 5, now + 3)).toEqual({
			ok: true,
			value: { revealed: true }
		});
		const revealed = await getTradeForUser(env.DB, ta.id, a.userId);
		expect(revealed).toMatchObject({ status: 'revealed', score: 4 });
		expect(revealed?.partner).toEqual({
			curveId: b.published.curve.id,
			s1: b.published.curve.s1,
			lineageId: b.published.lineageId,
			versionId: b.published.versionId,
			score: 5
		});
		expect(JSON.stringify(revealed)).not.toContain(b.userId);

		const averages = await tradeAverages(env.DB, [a.published.lineageId, b.published.lineageId]);
		expect(averages.get(a.published.lineageId)).toEqual({ average: 5, count: 1 });
		expect(averages.get(b.published.lineageId)).toEqual({ average: 4, count: 1 });
		expect((await listOwnTrades(env.DB, a.userId)).items.map((trade) => trade.id)).toEqual([ta.id]);
		// A revealed trade frees the slot for a new one.
		expect((await join(a)).status).toBe('waiting');
	});

	it('expires overdue trades and cancels only waiting ones', async () => {
		const [a, b] = [await player(), await player()];
		const overdue = await join(a, Date.now() - TRADE_TTL_MS - 1000);
		expect(await pairTrade(env.DB, overdue.id, a.userId, Date.now())).toEqual({
			ok: false,
			code: 'invalid-input'
		});
		expect(await expireTrades(env.DB, Date.now())).toBeGreaterThanOrEqual(1);
		expect((await getTradeForUser(env.DB, overdue.id, a.userId))?.status).toBe('expired');
		const waiting = await join(b);
		expect(await cancelTrade(env.DB, waiting.id, a.userId)).toBe(false);
		expect(await cancelTrade(env.DB, waiting.id, b.userId)).toBe(true);
		expect(await cancelTrade(env.DB, waiting.id, b.userId)).toBe(false);
		expect(await pairTrade(env.DB, sid('trade'), b.userId, Date.now())).toEqual({
			ok: false,
			code: 'not-found'
		});
	});
});
