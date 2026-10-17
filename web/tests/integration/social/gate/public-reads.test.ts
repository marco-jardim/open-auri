// FX4.9 (R2-1): the by-id public reads re-gate a verdict cached under a stale gate version before
// serving it: /c/[id] (loadSharedCurve), the OG image (getOrCreateOg) and S7 (join target and the
// partner's curve). A gate that now rejects is injected; a stale row it rejects is 404 / withheld.
// Ids are unique per test (the D1 database is shared between files).
import { env } from 'cloudflare:workers';
import { NEUTRAL_BANDS } from 'open-auri/dsp';
import { gateForWrite } from 'open-auri/safety';
import { curveId, encodeS1 } from 'open-auri/share';
import { describe, expect, it } from 'vitest';
import { getServerEnv } from '#lib/server/env.ts';
import { getOrCreateOg, type OgEnv } from '#lib/server/og/store.ts';
import { gateVersion } from '#lib/server/social/gate.ts';
import { createTrade, tryPairTrades } from '#lib/server/social/repo.ts';
import { loadSharedCurve } from '#lib/server/social/shares.ts';
import { getMyTrade, joinTrade } from '#lib/server/social/trades.ts';
import { TRADE_TTL_MS } from '#lib/server/social/types.ts';
import { uid } from '../../account/helpers.ts';
import { curveInput, publish, seedUser, type Published } from '../repo/helpers.ts';

const STALE = 'v2:fx49-stale';
const ANON = { userId: null };

/** The core gate, but every verdict is a rejection (a threshold that tightened). */
const rejecting: typeof gateForWrite = (bands, preampDb) => ({
	...gateForWrite(bands, preampDb),
	ok: false
});

/** A valid, practically unique S1: one small cut on top of the neutral bands. */
function randomS1(): string {
	const [a, b] = crypto.getRandomValues(new Uint32Array(2));
	const freqHz = 100 + ((a ?? 0) % 9900);
	const gainDb = -(1 + ((b ?? 0) % 6));
	const peak = { kind: 'PK', freqHz, gainDb, qFactor: 1 } as const;
	return encodeS1({ bands: NEUTRAL_BANDS.map((band, i) => (i === 0 ? peak : band)), preampDb: 0 });
}

/** A lineage whose head curve is a valid S1, approved under the gate version `gateVer`. */
async function publishedWith(
	gateVer: string,
	visibility: 'public' | 'unlisted' = 'public'
): Promise<Published & { ownerId: string }> {
	const owner = await seedUser({});
	const s1 = randomS1();
	const curve = curveInput({ id: await curveId(s1), s1, gateVer, gateOk: true });
	return { ...(await publish(owner.id, { visibility, curve })), ownerId: owner.id };
}

async function curveRow(id: string): Promise<{ gate_ver: string; gate_ok: number } | null> {
	return env.DB.prepare('SELECT gate_ver, gate_ok FROM curves WHERE id = ?')
		.bind(id)
		.first<{ gate_ver: string; gate_ok: number }>();
}

function ogEnv(): OgEnv {
	const server = getServerEnv({ env });
	return { db: server.db, media: server.media, publicOrigin: 'http://localhost', assets: null };
}

const fakePng = async (svg: string): Promise<Uint8Array> =>
	new TextEncoder().encode(svg.slice(0, 64));

const noWait = { waitUntil: (promise: Promise<unknown>) => void promise };

describe('FX4.9: /c/[id] re-gates a stale head before serving', () => {
	it('a stale head the current gate rejects is 404 for others, still readable by the owner', async () => {
		const pub = await publishedWith(STALE, 'unlisted');
		const page = await loadSharedCurve(env.DB, ANON, pub.lineageId, null, { gate: rejecting });
		expect(page.kind).toBe('not-found');
		expect(await curveRow(pub.curve.id)).toEqual({ gate_ver: await gateVersion(), gate_ok: 0 });
		const own = await loadSharedCurve(env.DB, { userId: pub.ownerId }, pub.lineageId, null);
		expect(own.kind).toBe('ok');
	});

	it('a current verdict is served as stored (the injected gate never runs)', async () => {
		const pub = await publishedWith(await gateVersion());
		const page = await loadSharedCurve(env.DB, ANON, pub.lineageId, null, { gate: rejecting });
		expect(page.kind).toBe('ok');
		expect((await curveRow(pub.curve.id))?.gate_ok).toBe(1);
	});

	it('a stale head the current gate accepts is served and its cache refreshed', async () => {
		const pub = await publishedWith(STALE);
		const page = await loadSharedCurve(env.DB, ANON, pub.lineageId, null, {
			gate: (bands, preampDb) => ({ ...gateForWrite(bands, preampDb), ok: true, reasons: [] })
		});
		expect(page.kind).toBe('ok');
		expect(await curveRow(pub.curve.id)).toEqual({ gate_ver: await gateVersion(), gate_ok: 1 });
	});
});

describe('FX4.9: the OG image re-gates a stale curve before rendering or serving', () => {
	it('a stale curve the current gate rejects is not-found and nothing is rendered', async () => {
		const pub = await publishedWith(STALE);
		let renders = 0;
		const result = await getOrCreateOg(ogEnv(), noWait, pub.versionId, {
			gate: rejecting,
			render: async (svg) => {
				renders += 1;
				return fakePng(svg);
			}
		});
		expect(result).toEqual({ ok: false, code: 'not-found' });
		expect(renders).toBe(0);
		expect((await curveRow(pub.curve.id))?.gate_ok).toBe(0);
	});

	it('a current curve is rendered as before', async () => {
		const pub = await publishedWith(await gateVersion());
		const result = await getOrCreateOg(ogEnv(), noWait, pub.versionId, {
			gate: rejecting,
			render: fakePng
		});
		expect(result.ok).toBe(true);
	});
});

describe('FX4.9: S7 re-gates stale verdicts on the target and on the partner', () => {
	const FAR = Date.now() + 4000 * TRADE_TTL_MS;

	async function tradesOf(userId: string): Promise<number> {
		const row = await env.DB.prepare('SELECT count(*) AS n FROM trades WHERE user_id = ?')
			.bind(userId)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	it('joining with a stale head the current gate rejects: stranger 404, owner 422; no trade', async () => {
		// Someone else's lineage: once re-gated, the head is not listable, so it is not found.
		const foreign = await publishedWith(STALE);
		const stranger = await seedUser({});
		const byStranger = await joinTrade(
			env.DB,
			stranger.id,
			{ lineageId: foreign.lineageId },
			{ now: FAR, gate: rejecting }
		);
		expect(byStranger).toEqual({ ok: false, code: 'not-found' });
		const current = await gateVersion();
		expect(await curveRow(foreign.curve.id)).toEqual({ gate_ver: current, gate_ok: 0 });
		expect(await tradesOf(stranger.id)).toBe(0);

		// The owner's own active lineage stays tradeable for them, but its curve now fails the gate
		// (the stored verdict said it passed: without the re-gate this join would succeed).
		const own = await publishedWith(STALE);
		const byOwner = await joinTrade(
			env.DB,
			own.ownerId,
			{ lineageId: own.lineageId },
			{ now: FAR, gate: rejecting }
		);
		expect(byOwner).toEqual({ ok: false, code: 'gate-rejected' });
		expect(await curveRow(own.curve.id)).toEqual({ gate_ver: current, gate_ok: 0 });
		expect(await tradesOf(own.ownerId)).toBe(0);
	});

	it('a partner whose curve went stale and is now rejected is withheld and the pair cancelled', async () => {
		const version = await gateVersion();
		const a = await publishedWith(version);
		const b = await publishedWith(version);
		const now = FAR + 10 * TRADE_TTL_MS;
		const ta = uid('trade');
		const tb = uid('trade');
		for (const [id, who] of [
			[ta, a],
			[tb, b]
		] as const) {
			const created = await createTrade(env.DB, {
				id,
				userId: who.ownerId,
				lineageId: who.lineageId,
				versionId: who.versionId,
				now
			});
			expect(created.ok).toBe(true);
		}
		expect(await tryPairTrades(env.DB, ta, tb, now + 1)).toBe(true);
		const blind = await getMyTrade(env.DB, a.ownerId, ta, { gate: rejecting, now: now + 2 });
		expect(blind?.partner).toMatchObject({ revealed: false, curveId: b.curve.id });

		// A threshold change: B's cached verdict is now stale, and the current gate rejects it.
		await env.DB.prepare('UPDATE curves SET gate_ver = ? WHERE id = ?')
			.bind(STALE, b.curve.id)
			.run();
		const after = await getMyTrade(env.DB, a.ownerId, ta, { gate: rejecting, now: now + 3 });
		expect(after).toMatchObject({ status: 'cancelled', partner: null });
		expect(await curveRow(b.curve.id)).toEqual({ gate_ver: version, gate_ok: 0 });
	});
});
