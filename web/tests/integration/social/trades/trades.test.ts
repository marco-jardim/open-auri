// T4.10 S7 blind trade: join/pair/score/reveal/cancel/expire through the service and the real
// `+server.ts` handlers. Pairing races (service and route), one active trade per user under
// concurrency, never the same lineage or a banned user, blind responses without partner identity,
// gate-rejected / unlisted / private lineages of others refused, expiry at 72 h with injected time.
//
// Isolation (the D1 database is shared between files): service tests run at injected times in
// disjoint far-future windows, where trades of other files (real clock) are already expired and
// never candidates; expiry tests run in the past (more than a day before the real clock), so they
// only expire trades that were already overdue for a day. Leftover waiting trades are cancelled.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	cancelTrade,
	createTrade,
	getTradeForUser,
	tryPairTrades
} from '#lib/server/social/repo.ts';
import {
	expireOverdueTrades,
	getMyTrade,
	joinTrade,
	scoreMyTrade,
	type JoinInput,
	type TradeDto
} from '#lib/server/social/trades.ts';
import { DAY_MS, TRADE_TTL_MS } from '#lib/server/social/types.ts';
import { DELETE as cancelRoute } from '../../../../src/routes/api/v1/trades/[id]/+server.ts';
import { POST as scoreRoute } from '../../../../src/routes/api/v1/trades/[id]/score/+server.ts';
import { POST as joinRoute } from '../../../../src/routes/api/v1/trades/+server.ts';
import { GET as meRoute } from '../../../../src/routes/api/v1/trades/me/+server.ts';
import { count, locals, nick, origin, uid, type SeededUser } from '../../account/helpers.ts';
import { ban, publish, seedUser, type Published } from '../repo/helpers.ts';

const BASE = Date.now() + 1000 * TRADE_TTL_MS;
let slot = 0;
/** A fresh far-future time window: trades of earlier windows are expired there. */
function epoch(): number {
	slot += 1;
	return BASE + slot * 10 * TRADE_TTL_MS;
}

type Auth = ReturnType<typeof locals>;

interface Player {
	user: SeededUser;
	pub: Published;
	auth: Auth;
}

async function player(visibility: 'public' | 'unlisted' | 'private' = 'public'): Promise<Player> {
	const user = await seedUser({ username: nick('tr') });
	const pub = await publish(user.id, { visibility });
	return { user, pub, auth: locals(user, uid('session')) };
}

async function join(
	who: { user: SeededUser; pub?: Published },
	now: number,
	input: Partial<JoinInput> = {}
): Promise<TradeDto> {
	const lineageId = input.lineageId ?? who.pub?.lineageId ?? '';
	const result = await joinTrade(env.DB, who.user.id, { ...input, lineageId }, { now });
	if (!result.ok) throw new Error(`join failed: ${result.code}`);
	return result.value;
}

async function rawCreate(who: Player, now: number): Promise<string> {
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

function randomIp(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(3));
	return `10.${bytes[0] ?? 0}.${bytes[1] ?? 0}.${bytes[2] ?? 1}`;
}

function routeEvent(
	method: string,
	path: string,
	routeId: string,
	auth: Auth,
	init: { id?: string; body?: unknown } = {}
) {
	const headers: Record<string, string> = { 'cf-connecting-ip': randomIp() };
	if (method !== 'GET') headers.origin = origin();
	if (init.body !== undefined) headers['content-type'] = 'application/json';
	return {
		request: new Request(new URL(path, origin()), {
			method,
			headers,
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
		}),
		locals: auth,
		platform: { env },
		route: { id: routeId },
		params: { id: init.id ?? '' }
	};
}

const postJoin = (auth: Auth, body: unknown) =>
	joinRoute(routeEvent('POST', '/api/v1/trades', '/api/v1/trades', auth, { body }));
const getMine = (auth: Auth, query = '') =>
	meRoute(routeEvent('GET', `/api/v1/trades/me${query}`, '/api/v1/trades/me', auth));
const postScore = (auth: Auth, id: string, body: unknown) =>
	scoreRoute(
		routeEvent('POST', `/api/v1/trades/${id}/score`, '/api/v1/trades/[id]/score', auth, {
			id,
			body
		})
	);
const deleteTrade = (auth: Auth, id: string) =>
	cancelRoute(routeEvent('DELETE', `/api/v1/trades/${id}`, '/api/v1/trades/[id]', auth, { id }));

async function errorOf(response: Response, status: number): Promise<string> {
	expect(response.status).toBe(status);
	const body = (await response.json()) as { error: { code: string } };
	return body.error.code;
}

async function matchOf(tradeId: string, userId: string): Promise<string | null> {
	return (await getTradeForUser(env.DB, tradeId, userId))?.matchId ?? null;
}

const TRADE_KEYS = [
	'createdAt',
	'expiresAt',
	'id',
	'lineageId',
	'matchedAt',
	'partner',
	'score',
	'scoredAt',
	'status',
	'versionId'
];

describe('S7 join and pairing', () => {
	it('waits alone, pairs the next join; the blind view leaks no partner identity', async () => {
		const now = epoch();
		const [a, b] = [await player(), await player()];
		const ta = await join(a, now);
		expect(ta).toMatchObject({ status: 'waiting', partner: null, lineageId: a.pub.lineageId });
		expect(ta.versionId).toBe(a.pub.versionId);
		expect(ta.expiresAt).toBe(now + TRADE_TTL_MS);

		const tb = await join(b, now + 1);
		expect(tb.status).toBe('matched');
		expect(tb.expiresAt).toBe(now + 1 + TRADE_TTL_MS);
		expect(Object.keys(tb).sort()).toEqual(TRADE_KEYS);
		expect(tb.partner).toEqual({ revealed: false, curveId: a.pub.curve.id, s1: a.pub.curve.s1 });
		expect(await matchOf(ta.id, a.user.id)).toBe(tb.id);

		const response = await getMine(a.auth);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('no-store');
		const text = await response.text();
		const body = JSON.parse(text) as { items: TradeDto[]; nextCursor: string | null };
		const mine = body.items.find((item) => item.id === ta.id);
		expect(mine?.status).toBe('matched');
		expect(Object.keys(mine ?? {}).sort()).toEqual(TRADE_KEYS);
		expect(Object.keys(mine?.partner ?? {}).sort()).toEqual(['curveId', 'revealed', 's1']);
		for (const secret of [
			b.user.id,
			b.user.email,
			b.user.username ?? 'no-username',
			b.pub.lineageId,
			b.pub.versionId,
			tb.id,
			'Private Name',
			'Warm vocal'
		]) {
			expect(text).not.toContain(secret);
		}
		expect(await errorOf(await getMine(a.auth, '?cursor=@@not-a-cursor'), 400)).toBe(
			'INVALID_CURSOR'
		);
	});

	it('race: two simultaneous service joins against one waiting trade make exactly one match', async () => {
		for (let round = 0; round < 3; round++) {
			const now = epoch();
			const [a, b, c] = [await player(), await player(), await player()];
			const ta = await join(a, now);
			const results = await Promise.all([
				joinTrade(env.DB, b.user.id, { lineageId: b.pub.lineageId }, { now: now + 1 }),
				joinTrade(env.DB, c.user.id, { lineageId: c.pub.lineageId }, { now: now + 1 })
			]);
			const trades = results.map((result) => (result.ok ? result.value : null));
			const [tb, tc] = trades;
			if (!tb || !tc) throw new Error('both joins must succeed');
			const partnerOfA = await matchOf(ta.id, a.user.id);
			expect([tb.id, tc.id]).toContain(partnerOfA);
			expect(await count('SELECT count(*) AS n FROM trades WHERE match_id = ?', ta.id)).toBe(1);
			const winner = partnerOfA === tb.id ? { trade: tb, who: b } : { trade: tc, who: c };
			const loser = partnerOfA === tb.id ? { trade: tc, who: c } : { trade: tb, who: b };
			expect(await matchOf(winner.trade.id, winner.who.user.id)).toBe(ta.id);
			const loserView = await getTradeForUser(env.DB, loser.trade.id, loser.who.user.id);
			expect(loserView).toMatchObject({ status: 'waiting', matchId: null, partner: null });
			await cancelTrade(env.DB, loser.trade.id, loser.who.user.id);
		}
	});

	it('race: two simultaneous route joins never match one trade twice', async () => {
		const [a, b, c] = [await player(), await player(), await player()];
		// The oldest waiting trade on the real clock (no pairing at creation).
		const ta = await rawCreate(a, Date.now() - TRADE_TTL_MS + 5 * 60_000);
		const [rb, rc] = await Promise.all([
			postJoin(b.auth, { lineageId: b.pub.lineageId }),
			postJoin(c.auth, { lineageId: c.pub.lineageId })
		]);
		expect([rb.status, rc.status]).toEqual([201, 201]);
		const tb = ((await rb.json()) as { trade: TradeDto }).trade;
		const tc = ((await rc.json()) as { trade: TradeDto }).trade;
		expect(await count('SELECT count(*) AS n FROM trades WHERE match_id = ?', ta)).toBeLessThan(2);
		const pairs: [string, string][] = [
			[ta, a.user.id],
			[tb.id, b.user.id],
			[tc.id, c.user.id]
		];
		for (const [id, userId] of pairs) {
			const view = await getTradeForUser(env.DB, id, userId);
			if (view?.status === 'matched' && view.matchId) {
				// Symmetric: the partner points back, and nobody else points here.
				expect(
					await count(
						'SELECT count(*) AS n FROM trades WHERE id = ? AND match_id = ?',
						view.matchId,
						id
					)
				).toBe(1);
				expect(await count('SELECT count(*) AS n FROM trades WHERE match_id = ?', id)).toBe(1);
			} else {
				expect(view?.status).toBe('waiting');
				await cancelTrade(env.DB, id, userId);
			}
		}
		const withA = [tb, tc].filter(
			(trade) => trade.status === 'matched' && trade.partner?.s1 === a.pub.curve.s1
		);
		expect(withA.length).toBeLessThan(2);
	});

	it('one active trade per user, also under concurrency; cancel only the own waiting trade', async () => {
		const now = epoch();
		const a = await player();
		const second = await publish(a.user.id);
		const [r1, r2] = await Promise.all([
			joinTrade(env.DB, a.user.id, { lineageId: a.pub.lineageId }, { now }),
			joinTrade(env.DB, a.user.id, { lineageId: second.lineageId }, { now })
		]);
		const oks = [r1, r2].filter((result) => result.ok);
		expect(oks).toHaveLength(1);
		expect(
			[r1, r2].filter((result) => !result.ok).map((result) => (result.ok ? null : result.code))
		).toEqual(['already-active']);
		const active = oks[0]?.ok ? oks[0].value : null;
		if (!active) throw new Error('one join must succeed');
		expect(await errorOf(await postJoin(a.auth, { lineageId: second.lineageId }), 409)).toBe(
			'ALREADY_ACTIVE'
		);

		const stranger = await player();
		expect(await errorOf(await deleteTrade(stranger.auth, active.id), 404)).toBe('NOT_FOUND');
		expect(await errorOf(await deleteTrade(a.auth, 'x'), 404)).toBe('NOT_FOUND');
		const cancelled = await deleteTrade(a.auth, active.id);
		expect(cancelled.status).toBe(200);
		expect(await cancelled.json()).toEqual({ cancelled: true });
		expect(await errorOf(await deleteTrade(a.auth, active.id), 409)).toBe('CONFLICT');
		expect((await getMyTrade(env.DB, a.user.id, active.id))?.status).toBe('cancelled');
		// The slot is free again.
		const again = await join(a, now + 1, {
			lineageId: second.lineageId,
			versionId: second.versionId
		});
		expect(again).toMatchObject({ status: 'waiting', versionId: second.versionId });
		await cancelTrade(env.DB, again.id, a.user.id);
	});

	it('never pairs with the same lineage or with a banned user', async () => {
		const now = epoch();
		const banned = await player();
		const tBanned = await join(banned, now);
		await ban(banned.user.id);
		const a = await player();
		const ta = await join(a, now + 1);
		expect(ta.status).toBe('waiting');
		// Another user trading a's public lineage: same lineage, never paired with a.
		const fan = { user: await seedUser({ username: nick('tr') }) };
		const tFan = await join(fan, now + 2, { lineageId: a.pub.lineageId });
		expect(tFan.status).toBe('waiting');
		expect(tFan.versionId).toBe(a.pub.versionId);

		const d = await player();
		const td = await join(d, now + 3);
		expect(td.status).toBe('matched');
		expect(await matchOf(ta.id, a.user.id)).toBe(td.id);
		expect((await getTradeForUser(env.DB, tBanned.id, banned.user.id))?.status).toBe('waiting');
		expect((await getTradeForUser(env.DB, tFan.id, fan.user.id))?.status).toBe('waiting');
		await cancelTrade(env.DB, tBanned.id, banned.user.id);
		await cancelTrade(env.DB, tFan.id, fan.user.id);
	});
});

describe('S7 scoring and reveal', () => {
	it('scores once; reveals only after both; averages per lineage', async () => {
		const now = epoch();
		const [a, b] = [await player(), await player()];
		const ta = await join(a, now);
		const tb = await join(b, now + 1);
		expect(tb.status).toBe('matched');

		const first = await postScore(a.auth, ta.id, { score: 4 });
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as { revealed: boolean; trade: TradeDto };
		expect(firstBody.revealed).toBe(false);
		expect(firstBody.trade).toMatchObject({ status: 'matched', score: 4 });
		expect(firstBody.trade.partner).toEqual({
			revealed: false,
			curveId: b.pub.curve.id,
			s1: b.pub.curve.s1
		});
		expect(await errorOf(await postScore(a.auth, ta.id, { score: 5 }), 409)).toBe('DUPLICATE');
		expect(await errorOf(await postScore(b.auth, ta.id, { score: 5 }), 404)).toBe('NOT_FOUND');
		expect(await errorOf(await postScore(b.auth, tb.id, { score: 0 }), 400)).toBe('INVALID_BODY');
		expect(await errorOf(await postScore(b.auth, tb.id, { score: 2.5 }), 400)).toBe('INVALID_BODY');
		// Still blind for b: a's score is not visible before b scores.
		const blindB = await getMyTrade(env.DB, b.user.id, tb.id);
		expect(blindB?.partner).toEqual({
			revealed: false,
			curveId: a.pub.curve.id,
			s1: a.pub.curve.s1
		});

		const second = await postScore(b.auth, tb.id, { score: 2 });
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as { revealed: boolean; trade: TradeDto };
		expect(secondBody.revealed).toBe(true);
		expect(secondBody.trade).toMatchObject({ status: 'revealed', score: 2 });

		const listed = (await (await getMine(a.auth)).json()) as { items: TradeDto[] };
		const revealed = listed.items.find((item) => item.id === ta.id);
		expect(revealed).toMatchObject({ status: 'revealed', score: 4 });
		expect(revealed?.partner).toEqual({
			revealed: true,
			curveId: b.pub.curve.id,
			s1: b.pub.curve.s1,
			score: 2,
			nickname: b.user.username,
			username: b.user.username,
			lineage: { id: b.pub.lineageId, versionId: b.pub.versionId, name: 'Warm vocal' }
		});
		expect(JSON.stringify(listed)).not.toContain(b.user.id);
		expect(JSON.stringify(listed)).not.toContain(tb.id);
		expect(await errorOf(await postScore(a.auth, ta.id, { score: 3 }), 409)).toBe('DUPLICATE');
	});

	it('the revealed partner link uses the canonical nickname, the display form is kept', async () => {
		const now = epoch();
		const a = await player();
		const b = await player();
		const display = (b.user.username ?? '').toUpperCase();
		await env.DB.prepare('UPDATE "user" SET "displayUsername" = ? WHERE "id" = ?')
			.bind(display, b.user.id)
			.run();
		const ta = await join(a, now);
		const tb = await join(b, now + 1);
		expect(tb.status).toBe('matched');
		await scoreMyTrade(env.DB, a.user.id, ta.id, 3, now + 2);
		await scoreMyTrade(env.DB, b.user.id, tb.id, 4, now + 3);
		const view = await getMyTrade(env.DB, a.user.id, ta.id);
		expect(view?.partner).toMatchObject({
			revealed: true,
			nickname: display,
			username: b.user.username
		});
	});

	it('a partner banned after the match: no nickname and no lineage link after the reveal', async () => {
		const now = epoch();
		const [a, b] = [await player(), await player()];
		const ta = await join(a, now);
		const tb = await join(b, now + 1);
		expect(tb.status).toBe('matched');
		await ban(b.user.id);
		expect(
			await errorOf(await getMine(locals(b.user, uid('session'), { banned: true })), 403)
		).toBe('BANNED');
		expect(await scoreMyTrade(env.DB, a.user.id, ta.id, 5, now + 2)).toMatchObject({
			ok: true,
			value: { revealed: false }
		});
		expect(await scoreMyTrade(env.DB, b.user.id, tb.id, 1, now + 3)).toMatchObject({
			ok: true,
			value: { revealed: true }
		});
		const view = await getMyTrade(env.DB, a.user.id, ta.id);
		expect(view?.partner).toEqual({
			revealed: true,
			curveId: b.pub.curve.id,
			s1: b.pub.curve.s1,
			score: 1,
			nickname: null,
			username: null,
			lineage: null
		});
	});
});

describe('S7 refusals', () => {
	it('refuses unlisted and private lineages of others, gate-rejected curves and bad input', async () => {
		const owner = await player('unlisted');
		const hidden = await publish(owner.user.id, { visibility: 'private' });
		const joiner = await player();
		for (const lineageId of [owner.pub.lineageId, hidden.lineageId, 'lin-does-not-exist']) {
			expect(await errorOf(await postJoin(joiner.auth, { lineageId }), 404)).toBe('NOT_FOUND');
		}
		// A version of another lineage.
		expect(
			await errorOf(
				await postJoin(joiner.auth, {
					lineageId: joiner.pub.lineageId,
					versionId: owner.pub.versionId
				}),
				404
			)
		).toBe('NOT_FOUND');
		expect(await errorOf(await postJoin(joiner.auth, {}), 400)).toBe('INVALID_BODY');
		expect(await errorOf(await postJoin(joiner.auth, { lineageId: 'bad id!' }), 400)).toBe(
			'INVALID_BODY'
		);
		const unverified = locals(joiner.user, uid('session'), { emailVerified: false });
		expect(
			await errorOf(await postJoin(unverified, { lineageId: joiner.pub.lineageId }), 403)
		).toBe('EMAIL_NOT_VERIFIED');

		// Own lineage whose curve the gate now rejects: 422; someone else's: not listable, 404.
		const rejectedOwn = await publish(joiner.user.id);
		const otherOwner = await player();
		for (const curveId of [rejectedOwn.curve.id, otherOwner.pub.curve.id]) {
			await env.DB.prepare('UPDATE curves SET gate_ok = 0, gate_reasons = ? WHERE id = ?')
				.bind('["test"]', curveId)
				.run();
		}
		expect(
			await errorOf(await postJoin(joiner.auth, { lineageId: rejectedOwn.lineageId }), 422)
		).toBe('GATE_REJECTED');
		expect(
			await errorOf(await postJoin(joiner.auth, { lineageId: otherOwner.pub.lineageId }), 404)
		).toBe('NOT_FOUND');
		expect(await count('SELECT count(*) AS n FROM trades WHERE user_id = ?', joiner.user.id)).toBe(
			0
		);

		// The owner may trade an own unlisted lineage.
		const own = await join(owner, epoch());
		expect(own.status).toBe('waiting');
		await cancelTrade(env.DB, own.id, owner.user.id);
	});
});

type LineageChange = 'retracted' | 'removed' | 'hidden' | 'private';

/** What the owner (retract, make private) or an admin (moderation) does to a lineage. */
async function changeLineage(lineageId: string, change: LineageChange): Promise<void> {
	const statement =
		change === 'retracted'
			? "UPDATE lineages SET status = 'retracted' WHERE id = ?"
			: change === 'private'
				? "UPDATE lineages SET visibility = 'private' WHERE id = ?"
				: 'UPDATE lineages SET moderation = ? WHERE id = ?';
	const params = change === 'removed' || change === 'hidden' ? [change, lineageId] : [lineageId];
	await env.DB.prepare(statement)
		.bind(...params)
		.run();
}

async function statusOf(tradeId: string): Promise<string | null> {
	const row = await env.DB.prepare('SELECT status FROM trades WHERE id = ?')
		.bind(tradeId)
		.first<{ status: string }>();
	return row?.status ?? null;
}

describe('S7 lineage state (listable, or own while active and visible)', () => {
	it('refuses at join an own lineage retracted or hidden by moderation, and one made private by its author', async () => {
		const owner = await player();
		for (const change of ['retracted', 'removed', 'hidden'] as const) {
			const own = await publish(owner.user.id);
			await changeLineage(own.lineageId, change);
			expect(await errorOf(await postJoin(owner.auth, { lineageId: own.lineageId }), 404)).toBe(
				'NOT_FOUND'
			);
		}
		// Someone else's public lineage the author made private: no longer joinable.
		const author = await player();
		await changeLineage(author.pub.lineageId, 'private');
		expect(
			await errorOf(await postJoin(owner.auth, { lineageId: author.pub.lineageId }), 404)
		).toBe('NOT_FOUND');
		expect(await count('SELECT count(*) AS n FROM trades WHERE user_id = ?', owner.user.id)).toBe(
			0
		);
		// The author's own private lineage (active, visible) is still tradeable by the author.
		const own = await join(author, epoch());
		expect(own.status).toBe('waiting');
		await cancelTrade(env.DB, own.id, author.user.id);
	});

	it('pairing skips waiting trades whose lineage was moderated, retracted or made private', async () => {
		const now = epoch();
		// Own lineage, then removed by an admin.
		const moderated = await player();
		const tModerated = await join(moderated, now);
		await changeLineage(moderated.pub.lineageId, 'removed');
		// Own lineage, then retracted by the owner.
		const retracted = await player();
		const tRetracted = await join(retracted, now + 1);
		await changeLineage(retracted.pub.lineageId, 'retracted');
		// A third party queued a public lineage; the author made it private afterwards.
		const author = await player();
		const fan = { user: await seedUser({ username: nick('tr') }) };
		const tFan = await join(fan, now + 2, { lineageId: author.pub.lineageId });
		await changeLineage(author.pub.lineageId, 'private');
		for (const id of [tModerated.id, tRetracted.id, tFan.id]) {
			expect(await statusOf(id)).toBe('waiting');
		}

		const d = await player();
		const td = await join(d, now + 3);
		expect(td).toMatchObject({ status: 'waiting', partner: null });
		for (const id of [tModerated.id, tRetracted.id, tFan.id]) {
			expect(await statusOf(id)).toBe('waiting');
		}
		// The stale trades cannot pair with each other either; a qualifying join pairs with d.
		const e = await player();
		const te = await join(e, now + 4);
		expect(te.status).toBe('matched');
		expect(te.partner).toEqual({ revealed: false, curveId: d.pub.curve.id, s1: d.pub.curve.s1 });
		await cancelTrade(env.DB, tModerated.id, moderated.user.id);
		await cancelTrade(env.DB, tRetracted.id, retracted.user.id);
		await cancelTrade(env.DB, tFan.id, fan.user.id);
	});

	it('a matched trade whose partner lineage stops qualifying withholds the S1 and cancels the pair', async () => {
		for (const change of ['removed', 'retracted', 'private'] as const) {
			const now = epoch();
			const a = await player();
			// b trades an own lineage for moderation and retraction, a third party's otherwise.
			const author = await player();
			const b =
				change === 'private'
					? { user: await seedUser({ username: nick('tr') }), pub: author.pub }
					: await player();
			const ta = await join(a, now);
			const tb = await join(b, now + 1);
			expect(tb.status).toBe('matched');
			expect(tb.partner).toMatchObject({ s1: a.pub.curve.s1 });
			await changeLineage(b.pub.lineageId, change);

			const auth = locals(a.user, uid('session'));
			const text = await (await getMine(auth)).text();
			expect(text).not.toContain(b.pub.curve.s1);
			expect(text).not.toContain(b.pub.curve.id);
			const items = (JSON.parse(text) as { items: TradeDto[] }).items;
			expect(items.find((item) => item.id === ta.id)).toMatchObject({
				status: 'cancelled',
				partner: null
			});
			// Cancelled in the database too, on both sides; no score, no reveal.
			expect(await statusOf(ta.id)).toBe('cancelled');
			expect(await statusOf(tb.id)).toBe('cancelled');
			expect(await getMyTrade(env.DB, b.user.id, tb.id)).toMatchObject({
				status: 'cancelled',
				partner: null
			});
			expect(await scoreMyTrade(env.DB, a.user.id, ta.id, 5, now + 2)).toEqual({
				ok: false,
				code: 'not-active'
			});
		}
	});

	it('scoring a matched trade whose partner stopped qualifying cancels the pair instead', async () => {
		const now = epoch();
		const [a, b] = [await player(), await player()];
		const ta = await join(a, now);
		const tb = await join(b, now + 1);
		expect(tb.status).toBe('matched');
		await changeLineage(b.pub.lineageId, 'hidden');
		expect(await scoreMyTrade(env.DB, a.user.id, ta.id, 5, now + 2)).toEqual({
			ok: false,
			code: 'not-active'
		});
		expect(await statusOf(ta.id)).toBe('cancelled');
		expect(await statusOf(tb.id)).toBe('cancelled');
	});

	it('a revealed trade stops serving the partner curve once its lineage no longer qualifies', async () => {
		const now = epoch();
		const a = await player();
		const author = await player();
		const fan = { user: await seedUser({ username: nick('tr') }), pub: author.pub };
		const ta = await join(a, now);
		const tFan = await join(fan, now + 1);
		expect(tFan.status).toBe('matched');
		await scoreMyTrade(env.DB, a.user.id, ta.id, 4, now + 2);
		await scoreMyTrade(env.DB, fan.user.id, tFan.id, 3, now + 3);
		expect((await getMyTrade(env.DB, a.user.id, ta.id))?.partner).toMatchObject({
			revealed: true,
			s1: author.pub.curve.s1
		});

		await changeLineage(author.pub.lineageId, 'private');
		const view = await getMyTrade(env.DB, a.user.id, ta.id);
		expect(view).toMatchObject({ status: 'revealed', score: 4, partner: null });
		const text = await (await getMine(locals(a.user, uid('session')))).text();
		expect(text).not.toContain(author.pub.curve.s1);
		// The finished trade is left as it was.
		expect(await statusOf(ta.id)).toBe('revealed');
		// The fan's side (a's lineage still public) is unaffected.
		expect((await getMyTrade(env.DB, fan.user.id, tFan.id))?.partner).toMatchObject({
			revealed: true,
			s1: a.pub.curve.s1
		});
	});
});

describe('S7 expiry', () => {
	it('expires a waiting trade 72 h after joining and a matched one 72 h after pairing', async () => {
		// More than a day before the real clock: only trades overdue for a day are touched.
		const start = Date.now() - 2 * DAY_MS - TRADE_TTL_MS;
		const [a, b, c] = [await player(), await player(), await player()];
		const ta = await rawCreate(a, start);
		await expireOverdueTrades(env.DB, start + TRADE_TTL_MS - 1);
		expect((await getMyTrade(env.DB, a.user.id, ta))?.status).toBe('waiting');
		await expireOverdueTrades(env.DB, start + TRADE_TTL_MS);
		expect((await getMyTrade(env.DB, a.user.id, ta))?.status).toBe('expired');
		expect(await scoreMyTrade(env.DB, a.user.id, ta, 3, start + TRADE_TTL_MS)).toEqual({
			ok: false,
			code: 'not-active'
		});

		const tb = await rawCreate(b, start + 10);
		const tc = await rawCreate(c, start + 11);
		const matchedAt = start + 20;
		expect(await tryPairTrades(env.DB, tb, tc, matchedAt)).toBe(true);
		const deadline = matchedAt + TRADE_TTL_MS;
		expect((await getMyTrade(env.DB, b.user.id, tb))?.expiresAt).toBe(deadline);
		expect(await scoreMyTrade(env.DB, b.user.id, tb, 3, deadline)).toEqual({
			ok: false,
			code: 'not-active'
		});
		await expireOverdueTrades(env.DB, deadline - 1);
		expect((await getMyTrade(env.DB, c.user.id, tc))?.status).toBe('matched');
		await expireOverdueTrades(env.DB, deadline);
		for (const [id, who] of [
			[tb, b],
			[tc, c]
		] as const) {
			expect(await getMyTrade(env.DB, who.user.id, id)).toMatchObject({
				status: 'expired',
				partner: null
			});
		}
	});
});
