// Issues #29/#31: bounded S7 re-gating, stale pairing candidates and score-time refreshes.
// Unique decodable curves and disjoint future windows keep the shared D1 fixtures isolated.
import { env } from 'cloudflare:workers';
import { curveId, encodeS1 } from 'open-auri/share';
import type { gateForWrite } from 'open-auri/safety';
import { describe, expect, it } from 'vitest';
import { gateVersion } from '#lib/server/social/gate.ts';
import {
	cancelTrade,
	createTrade,
	getCurve,
	getTradeForUser,
	scoreTrade,
	tryPairTrades
} from '#lib/server/social/repo.ts';
import {
	joinTrade,
	listMyTrades,
	pairWaitingTrade,
	scoreMyTrade,
	TRADE_REGATE_PER_READ
} from '#lib/server/social/trades.ts';
import { TRADE_TTL_MS } from '#lib/server/social/types.ts';
import { uid } from '../../account/helpers.ts';
import { acceptAll, uniqueRejectedCurve } from '../curves/helpers.ts';
import { curveInput, publish, seedUser } from '../repo/helpers.ts';

const STALE = 'v2:issue-29-31';
const BASE = Date.now() + 20_000 * TRADE_TTL_MS;
let slot = 0;
const epoch = () => BASE + ++slot * 10 * TRADE_TTL_MS;

async function player() {
	const user = await seedUser({});
	const s1 = encodeS1(uniqueRejectedCurve());
	const curve = curveInput({ id: await curveId(s1), s1, gateVer: await gateVersion() });
	return { user, pub: await publish(user.id, { curve }) };
}

type Player = Awaited<ReturnType<typeof player>>;

async function queue(who: Player, now: number): Promise<string> {
	const id = uid('trade');
	const created = await createTrade(env.DB, {
		id,
		userId: who.user.id,
		lineageId: who.pub.lineageId,
		versionId: who.pub.versionId,
		now
	});
	if (!created.ok) throw new Error(`create failed: ${created.code}`);
	return id;
}

async function makeStale(who: Player): Promise<void> {
	await env.DB.prepare('UPDATE curves SET gate_ver = ? WHERE id = ?')
		.bind(STALE, who.pub.curve.id)
		.run();
}

function countingGate(ok: boolean, acceptedS1?: string) {
	let calls = 0;
	const gate: typeof gateForWrite = (bands, preampDb, options) => {
		calls++;
		return {
			...acceptAll(bands, preampDb, options),
			ok: ok || encodeS1({ bands, preampDb }) === acceptedS1
		};
	};
	return { gate, calls: () => calls };
}

describe('S7 re-gate budgets', () => {
	it('withholds one of five stale partners on one read, then refreshes only the deferred curve', async () => {
		const now = epoch();
		const reader = await player();
		const pairs: { partner: Player; ownId: string; partnerId: string }[] = [];
		for (let i = 0; i < TRADE_REGATE_PER_READ + 1; i++) {
			const partner = await player();
			const ownId = await queue(reader, now + i * 10);
			const partnerId = await queue(partner, now + i * 10);
			expect(await tryPairTrades(env.DB, ownId, partnerId, now + i * 10 + 1)).toBe(true);
			expect((await scoreTrade(env.DB, ownId, reader.user.id, 4, now + i * 10 + 2)).ok).toBe(true);
			expect((await scoreTrade(env.DB, partnerId, partner.user.id, 3, now + i * 10 + 3)).ok).toBe(
				true
			);
			pairs.push({ partner, ownId, partnerId });
		}
		for (const { partner } of pairs) await makeStale(partner);

		const spy = countingGate(true);
		const first = await listMyTrades(
			env.DB,
			reader.user.id,
			{},
			{ gate: spy.gate, now: now + 100 }
		);
		if (!first.ok) throw new Error(first.code);
		expect(spy.calls()).toBe(TRADE_REGATE_PER_READ);
		expect(first.value.items.filter((item) => item.partner !== null)).toHaveLength(
			TRADE_REGATE_PER_READ
		);
		const withheld = first.value.items.filter((item) => item.partner === null);
		expect(withheld).toHaveLength(1);
		expect(withheld[0]?.status).toBe('revealed');
		let deferred = 0;
		for (const { partner, ownId, partnerId } of pairs) {
			const row = await getCurve(env.DB, partner.pub.curve.id);
			if (row?.gateVer === STALE) {
				deferred++;
				expect(withheld[0]?.id).toBe(ownId);
				expect(JSON.stringify(first.value)).not.toContain(partner.pub.curve.s1);
			} else {
				expect(row?.gateVer).toBe(await gateVersion());
			}
			expect((await getTradeForUser(env.DB, partnerId, partner.user.id))?.status).toBe('revealed');
		}
		expect(deferred).toBe(1);

		const second = await listMyTrades(
			env.DB,
			reader.user.id,
			{},
			{ gate: spy.gate, now: now + 101 }
		);
		if (!second.ok) throw new Error(second.code);
		expect(spy.calls()).toBe(TRADE_REGATE_PER_READ + 1);
		expect(second.value.items.every((item) => item.partner !== null)).toBe(true);
	});

	it.each([false, true])('join budget (stale target: %s)', async (staleTarget) => {
		const now = epoch();
		const candidates: { who: Player; id: string }[] = [];
		for (let i = 0; i < TRADE_REGATE_PER_READ + 1; i++) {
			const who = await player();
			const id = await queue(who, now + i);
			await makeStale(who);
			candidates.push({ who, id });
		}
		const joiner = await player();
		if (staleTarget) await makeStale(joiner);
		const spy = countingGate(false, joiner.pub.curve.s1);
		try {
			const result = await joinTrade(
				env.DB,
				joiner.user.id,
				{ lineageId: joiner.pub.lineageId },
				{ gate: spy.gate, now: now + 100 }
			);
			expect(result).toMatchObject({ ok: true, value: { status: 'waiting', partner: null } });
			expect(spy.calls()).toBe(TRADE_REGATE_PER_READ);
			const rows = await Promise.all(
				candidates.map(({ who }) => getCurve(env.DB, who.pub.curve.id))
			);
			expect(rows.filter((row) => row?.gateVer === STALE && row.gateOk)).toHaveLength(
				staleTarget ? 2 : 1
			);
			expect(rows.filter((row) => row?.gateVer !== STALE && !row?.gateOk)).toHaveLength(
				TRADE_REGATE_PER_READ - (staleTarget ? 1 : 0)
			);
			for (const { who, id } of candidates) {
				expect(await getTradeForUser(env.DB, id, who.user.id)).toMatchObject({
					status: 'waiting',
					matchId: null
				});
			}
			if (result.ok) await cancelTrade(env.DB, result.value.id, joiner.user.id);
		} finally {
			for (const { who, id } of candidates) await cancelTrade(env.DB, id, who.user.id);
		}
	});

	it('pairing spends the same four-curve budget on its own curve and on stale candidates', async () => {
		const now = epoch();
		const own = await player();
		const ownId = await queue(own, now);
		const candidates: { who: Player; id: string }[] = [];
		for (let i = 0; i < TRADE_REGATE_PER_READ + 1; i++) {
			const who = await player();
			const id = await queue(who, now + i + 1);
			await makeStale(who);
			candidates.push({ who, id });
		}
		await makeStale(own);
		const spy = countingGate(false, own.pub.curve.s1);
		try {
			expect(await pairWaitingTrade(env.DB, ownId, now + 100, 5, { gate: spy.gate })).toEqual({
				status: 'waiting'
			});
			expect(spy.calls()).toBe(TRADE_REGATE_PER_READ);
			expect(await getCurve(env.DB, own.pub.curve.id)).toMatchObject({
				gateOk: true,
				gateVer: await gateVersion()
			});
			const rows = await Promise.all(
				candidates.map(({ who }) => getCurve(env.DB, who.pub.curve.id))
			);
			expect(rows.filter((row) => row?.gateVer === STALE && row.gateOk)).toHaveLength(2);
			expect(rows.filter((row) => row?.gateOk === false)).toHaveLength(TRADE_REGATE_PER_READ - 1);
		} finally {
			await cancelTrade(env.DB, ownId, own.user.id);
			for (const { who, id } of candidates) await cancelTrade(env.DB, id, who.user.id);
		}
	});

	it('re-gates a stale accepted candidate before pairing it, without gating it twice', async () => {
		const now = epoch();
		const [a, b] = [await player(), await player()];
		const ta = await queue(a, now);
		const tb = await queue(b, now + 1);
		await makeStale(a);
		const spy = countingGate(true);
		expect(await pairWaitingTrade(env.DB, tb, now + 2, 5, { gate: spy.gate })).toEqual({
			status: 'matched',
			matchId: ta
		});
		expect(spy.calls()).toBe(1);
		expect((await getCurve(env.DB, a.pub.curve.id))?.gateVer).toBe(await gateVersion());
		expect((await getTradeForUser(env.DB, ta, a.user.id))?.matchId).toBe(tb);
	});
});

describe('S7 score-time re-gating', () => {
	for (const ok of [true, false]) {
		it(`refreshes a stale partner before scoring when the new verdict is ${ok ? 'accepted' : 'rejected'}`, async () => {
			const now = epoch();
			const [a, b] = [await player(), await player()];
			const ta = await queue(a, now);
			const tb = await queue(b, now + 1);
			expect(await tryPairTrades(env.DB, ta, tb, now + 2)).toBe(true);
			await makeStale(b);
			const spy = countingGate(ok);
			const result = await scoreMyTrade(env.DB, a.user.id, ta, 5, now + 3, { gate: spy.gate });
			expect(spy.calls()).toBe(1);
			expect(await getCurve(env.DB, b.pub.curve.id)).toMatchObject({
				gateVer: await gateVersion(),
				gateOk: ok
			});
			if (ok) {
				expect(result).toMatchObject({
					ok: true,
					value: {
						revealed: false,
						trade: { status: 'matched', score: 5, partner: { s1: b.pub.curve.s1 } }
					}
				});
			} else {
				expect(result).toEqual({ ok: false, code: 'not-active' });
				for (const [id, who] of [
					[ta, a],
					[tb, b]
				] as const) {
					expect(await getTradeForUser(env.DB, id, who.user.id)).toMatchObject({
						status: 'cancelled',
						score: null
					});
				}
			}
		});
	}
});
