// #27: a head (or version) cached as REJECTED under a stale gate version is hidden by the readable
// rows, so the by-id reads used to keep it 404 after the gate was relaxed. They now re-gate it
// first (one gate run, through regateCurve) and serve it once the current gate accepts it; a
// still-rejected one answers exactly like a missing id. Private, moderated, withdrawn and
// banned-owner lineages are never re-gated nor exposed by someone else's read. The re-gate job
// lists stale rejected heads of publicly listable lineages right after the accepted linkable ones.
// Ids and curves are unique per test (the D1 database is shared between files).
import { env } from 'cloudflare:workers';
import { NEUTRAL_BANDS } from 'open-auri/dsp';
import { gateForWrite } from 'open-auri/safety';
import { curveId, encodeS1 } from 'open-auri/share';
import { describe, expect, it } from 'vitest';
import { ApiError, apiErrorFrom } from '#lib/server/api/errors.ts';
import { getServerEnv } from '#lib/server/env.ts';
import { getOrCreateOg, type OgEnv } from '#lib/server/og/store.ts';
import {
	loadLineageVersions,
	loadPublishedCurve,
	readResponse,
	type PublishedCurve,
	type ReadResult
} from '#lib/server/social/curves.ts';
import { GATE_IMPL, gateVersion } from '#lib/server/social/gate.ts';
import {
	appendVersion,
	getCurve,
	listStaleCurvesForRegate,
	retractLineage,
	setModeration
} from '#lib/server/social/repo.ts';
import { loadSharedCurve } from '#lib/server/social/shares.ts';
import type { CurveInput, LineageVisibility } from '#lib/server/social/types.ts';
import {
	ban,
	curveInput,
	publish,
	seedUser,
	sid,
	versionInput,
	type Published
} from '../repo/helpers.ts';

const STALE = 'v2:issue27-stale';
const ANON = { userId: null };

/** The core gate with a forced verdict (a gate that was relaxed, or one that still rejects). */
function countingGate(accept: boolean): { gate: typeof gateForWrite; calls: () => number } {
	let calls = 0;
	const gate: typeof gateForWrite = (bands, preampDb, options) => {
		calls++;
		const result = gateForWrite(bands, preampDb, options);
		return accept ? { ...result, ok: true, reasons: [] } : { ...result, ok: false };
	};
	return { gate, calls: () => calls };
}

/** A valid S1: one small cut on top of the neutral bands. */
function randomS1(): string {
	const [a, b] = crypto.getRandomValues(new Uint32Array(2));
	const freqHz = 100 + ((a ?? 0) % 9900);
	const gainDb = -(1 + ((b ?? 0) % 6));
	const peak = { kind: 'PK', freqHz, gainDb, qFactor: 1 } as const;
	return encodeS1({ bands: NEUTRAL_BANDS.map((band, i) => (i === 0 ? peak : band)), preampDb: 0 });
}

/** A decodable curve not yet in the shared database, accepted under `gateVer`. */
async function uniqueCurve(gateVer: string): Promise<CurveInput> {
	for (;;) {
		const s1 = randomS1();
		const id = await curveId(s1);
		if (!(await getCurve(env.DB, id))) return curveInput({ id, s1, gateVer, gateOk: true });
	}
}

async function setCached(id: string, gateVer: string, gateOk: boolean): Promise<void> {
	await env.DB.prepare('UPDATE curves SET gate_ver = ?, gate_ok = ? WHERE id = ?')
		.bind(gateVer, gateOk ? 1 : 0, id)
		.run();
}

/**
 * A lineage whose head is cached under `gateVer` with the verdict `gateOk`. Versions can only be
 * published on accepted curves (trigger), so a rejection is written to the cache afterwards.
 */
async function headWith(
	gateVer: string,
	gateOk: boolean,
	visibility: LineageVisibility = 'public'
): Promise<Published & { ownerId: string }> {
	const owner = await seedUser({});
	const curve = await uniqueCurve(gateVer);
	const pub = await publish(owner.id, { visibility, curve });
	if (!gateOk) await setCached(curve.id, gateVer, false);
	return { ...pub, ownerId: owner.id };
}

interface TwoVersions {
	lineageId: string;
	older: { versionId: string; curve: CurveInput };
	head: { versionId: string; curve: CurveInput };
}

/** A public lineage with an older version and a head, both accepted under `gateVer`. */
async function twoVersions(gateVer: string): Promise<TwoVersions> {
	const root = await headWith(gateVer, true);
	const curve = await uniqueCurve(gateVer);
	const version = versionInput();
	const appended = await appendVersion(env.DB, {
		lineageId: root.lineageId,
		ownerUserId: root.ownerId,
		expectedHead: root.versionId,
		curve,
		version,
		now: Date.now()
	});
	if (!appended.ok) throw new Error(`append failed: ${appended.code}`);
	return {
		lineageId: root.lineageId,
		older: { versionId: root.versionId, curve: root.curve },
		head: { versionId: version.id, curve }
	};
}

async function curveRow(id: string): Promise<{ gate_ver: string; gate_ok: number } | null> {
	return env.DB.prepare('SELECT gate_ver, gate_ok FROM curves WHERE id = ?')
		.bind(id)
		.first<{ gate_ver: string; gate_ok: number }>();
}

/** The HTTP response of `GET /api/v1/curves/[id]` (anonymous) for a read result. */
async function apiResponse(result: ReadResult<PublishedCurve>): Promise<{
	status: number;
	headers: Record<string, string>;
	body: string;
}> {
	let response: Response;
	try {
		response = await readResponse(new Request('http://localhost/api/v1/curves/x'), result, true);
	} catch (error) {
		if (!(error instanceof ApiError)) throw error;
		response = apiErrorFrom(error);
	}
	return {
		status: response.status,
		headers: Object.fromEntries(response.headers.entries()),
		body: await response.text()
	};
}

function ogEnv(): OgEnv {
	const server = getServerEnv({ env });
	return { db: server.db, media: server.media, publicOrigin: 'http://localhost', assets: null };
}

const fakePng = async (svg: string): Promise<Uint8Array> =>
	new TextEncoder().encode(svg.slice(0, 64));

const noWait = { waitUntil: (promise: Promise<unknown>) => void promise };

describe('#27: a head rejected under an old gate and accepted now is served', () => {
	it('200 after one read (one gate run), cache updated, no gate run afterwards', async () => {
		const current = await gateVersion();
		const pub = await headWith(STALE, false);
		const accept = countingGate(true);
		const first = await loadPublishedCurve(env.DB, pub.lineageId, ANON, null, {
			gate: accept.gate
		});
		expect(first.kind).toBe('ok');
		expect((await apiResponse(first)).status).toBe(200);
		if (first.kind === 'ok') expect(first.value.curve.gate).toMatchObject({ ok: true });
		expect(accept.calls()).toBe(1);
		expect(await curveRow(pub.curve.id)).toEqual({ gate_ver: current, gate_ok: 1 });

		const again = await loadPublishedCurve(env.DB, pub.lineageId, ANON, null, {
			gate: accept.gate
		});
		expect(again.kind).toBe('ok');
		expect(accept.calls()).toBe(1);
	});

	it('the same on /c/[id], the version history and the OG image of the head', async () => {
		const current = await gateVersion();
		const accept = countingGate(true);
		const deps = { gate: accept.gate };
		const shared = await headWith(STALE, false, 'unlisted');
		const page = await loadSharedCurve(env.DB, ANON, shared.lineageId, null, deps);
		expect(page.kind).toBe('ok');

		const history = await headWith(STALE, false);
		const stranger = { userId: (await seedUser({})).id };
		const versions = await loadLineageVersions(env.DB, history.lineageId, stranger, {}, deps);
		expect(versions.kind).toBe('ok');

		const og = await headWith(STALE, false);
		const image = await getOrCreateOg(ogEnv(), noWait, og.versionId, { ...deps, render: fakePng });
		expect(image.ok).toBe(true);

		expect(accept.calls()).toBe(3);
		for (const pub of [shared, history, og]) {
			expect(await curveRow(pub.curve.id)).toEqual({ gate_ver: current, gate_ok: 1 });
		}
	});

	it('an older version whose own curve, or whose head, was rejected under an old gate', async () => {
		const current = await gateVersion();
		const accept = countingGate(true);

		// Its own curve: re-gated by the version read of the curve page (the head is current).
		const own = await twoVersions(current);
		await setCached(own.older.curve.id, STALE, false);
		const read = await loadPublishedCurve(env.DB, own.lineageId, ANON, own.older.versionId, {
			gate: accept.gate
		});
		expect(read.kind).toBe('ok');
		if (read.kind === 'ok') expect(read.value.version.id).toBe(own.older.versionId);
		expect(accept.calls()).toBe(1);
		expect(await curveRow(own.older.curve.id)).toEqual({ gate_ver: current, gate_ok: 1 });

		// Its head: the OG image of the older version re-gates the head first.
		const head = await twoVersions(current);
		await setCached(head.head.curve.id, STALE, false);
		const image = await getOrCreateOg(ogEnv(), noWait, head.older.versionId, {
			gate: accept.gate,
			render: fakePng
		});
		expect(image.ok).toBe(true);
		expect(accept.calls()).toBe(2);
		expect(await curveRow(head.head.curve.id)).toEqual({ gate_ver: current, gate_ok: 1 });
	});
});

describe('#27: a head rejected under an old gate and still rejected stays missing', () => {
	it('404, identical to a missing curve; re-gated once, then a fresh rejection', async () => {
		const current = await gateVersion();
		const reject = countingGate(false);
		const deps = { gate: reject.gate };
		const pub = await headWith(STALE, false);

		const hidden = await loadPublishedCurve(env.DB, pub.lineageId, ANON, null, deps);
		const missing = await loadPublishedCurve(env.DB, sid('lin'), ANON, null, deps);
		expect(hidden).toEqual({ kind: 'not-found' });
		expect(hidden).toEqual(missing);
		const hiddenResponse = await apiResponse(hidden);
		expect(hiddenResponse.status).toBe(404);
		expect(hiddenResponse).toEqual(await apiResponse(missing));
		expect(reject.calls()).toBe(1);
		expect(await curveRow(pub.curve.id)).toEqual({ gate_ver: current, gate_ok: 0 });

		// The rejection is current now: the next read does not run the gate again.
		const later = await loadPublishedCurve(env.DB, pub.lineageId, ANON, null, deps);
		expect(later).toEqual(missing);
		expect(reject.calls()).toBe(1);
	});

	it('/c/[id] and the OG image answer like a missing id too', async () => {
		const reject = countingGate(false);
		const deps = { gate: reject.gate };
		const page = await headWith(STALE, false, 'unlisted');
		const shared = await loadSharedCurve(env.DB, ANON, page.lineageId, null, deps);
		expect(shared).toEqual(await loadSharedCurve(env.DB, ANON, sid('lin'), null, deps));
		expect(shared).toEqual({ kind: 'not-found' });

		const og = await headWith(STALE, false);
		const ogDeps = { ...deps, render: fakePng };
		const image = await getOrCreateOg(ogEnv(), noWait, og.versionId, ogDeps);
		expect(image).toEqual(await getOrCreateOg(ogEnv(), noWait, sid('ver'), ogDeps));
		expect(image).toEqual({ ok: false, code: 'not-found' });
		expect(reject.calls()).toBe(2);
	});
});

describe('#27: a fresh rejection is never re-gated', () => {
	it('404 with no gate run on the curve page, /c/[id], the history and the OG image', async () => {
		const current = await gateVersion();
		const accept = countingGate(true);
		const pub = await headWith(current, false);
		const deps = { gate: accept.gate };
		expect(await loadPublishedCurve(env.DB, pub.lineageId, ANON, null, deps)).toEqual({
			kind: 'not-found'
		});
		expect(await loadSharedCurve(env.DB, ANON, pub.lineageId, null, deps)).toEqual({
			kind: 'not-found'
		});
		expect(await loadLineageVersions(env.DB, pub.lineageId, ANON, {}, deps)).toEqual({
			kind: 'not-found'
		});
		expect(
			await getOrCreateOg(ogEnv(), noWait, pub.versionId, { ...deps, render: fakePng })
		).toEqual({ ok: false, code: 'not-found' });
		expect(accept.calls()).toBe(0);
		expect(await curveRow(pub.curve.id)).toEqual({ gate_ver: current, gate_ok: 0 });
	});
});

describe('#27: private, moderated or withdrawn curves are never exposed', () => {
	it('a stale rejected head of such a lineage is neither re-gated nor served to others', async () => {
		const accept = countingGate(true);
		const deps = { gate: accept.gate };
		const privateOne = await headWith(STALE, false, 'private');
		const moderated = await headWith(STALE, false);
		const now = Date.now();
		expect(await setModeration(env.DB, 'lineage', moderated.lineageId, 'hidden', now)).toBe(true);
		const withdrawn = await headWith(STALE, false);
		const retracted = await retractLineage(env.DB, withdrawn.lineageId, withdrawn.ownerId, now);
		expect(retracted.ok).toBe(true);
		const bannedOwner = await headWith(STALE, false);
		await ban(bannedOwner.ownerId);
		const stranger = await seedUser({});

		for (const pub of [privateOne, moderated, withdrawn, bannedOwner]) {
			for (const viewer of [ANON, { userId: stranger.id }]) {
				const read = await loadPublishedCurve(env.DB, pub.lineageId, viewer, null, deps);
				expect(read).toEqual({ kind: 'not-found' });
				expect(await apiResponse(read)).toEqual(
					await apiResponse(await loadPublishedCurve(env.DB, sid('lin'), viewer, null, deps))
				);
				expect(await loadSharedCurve(env.DB, viewer, pub.lineageId, null, deps)).toEqual({
					kind: 'not-found'
				});
				expect(await loadLineageVersions(env.DB, pub.lineageId, viewer, {}, deps)).toEqual({
					kind: 'not-found'
				});
			}
			expect(
				await getOrCreateOg(ogEnv(), noWait, pub.versionId, { ...deps, render: fakePng })
			).toEqual({ ok: false, code: 'not-found' });
			expect(await curveRow(pub.curve.id)).toEqual({ gate_ver: STALE, gate_ok: 0 });
		}
		expect(accept.calls()).toBe(0);
	});
});

describe('#27: the re-gate job lists stale rejected heads of publicly listable lineages early', () => {
	it('accepted linkable heads, then rejected public heads, then the rest', async () => {
		const owner = await seedUser({});
		// Among the oldest rows of the table (created_at 1), all cached under a stale version.
		const stale = (): CurveInput => curveInput({ gateVer: STALE });
		const accepted = await publish(owner.id, { now: 1, curve: stale() });
		const rejected = await publish(owner.id, { now: 1, curve: stale() });
		const unlisted = await publish(owner.id, { visibility: 'unlisted', now: 1, curve: stale() });
		const hidden = await publish(owner.id, { visibility: 'private', now: 1, curve: stale() });
		for (const pub of [rejected, unlisted, hidden]) await setCached(pub.curve.id, STALE, false);

		const list = await listStaleCurvesForRegate(env.DB, await gateVersion(), 1000, GATE_IMPL);
		const ids = list.map((curve) => curve.id);
		const at = (pub: Published): number => ids.indexOf(pub.curve.id);
		expect(at(accepted)).toBeGreaterThanOrEqual(0);
		expect(at(rejected)).toBeGreaterThan(at(accepted));
		expect(list[at(rejected)]?.gateOk).toBe(false);
		// Rejected heads of unlisted or private lineages are not listable: after every listable one.
		for (const later of [unlisted, hidden]) {
			expect(at(later) === -1 || at(later) > at(rejected)).toBe(true);
		}
	});
});
