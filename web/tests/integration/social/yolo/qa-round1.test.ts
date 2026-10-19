// YOLO publication, QA round 1 (server):
// - M1: the kill switch YOLO_PUBLICATION gates the READS too. While it is off, an acknowledged
//   YOLO head is not served to anyone but its owner: not by id (curve, history, /c/:id), not in
//   `feed?yolo=only` (an empty page), not as an OG card, not as a fork source, not favoritable.
//   Turned on again, it is served again (the acknowledgement row stays).
// - m4: every gate run of a classification goes through the injected gate (the merge budget is
//   never exceeded: a YOLO curve costs exactly 2 runs, both counted).
// - m6: the YOLO acknowledgement is counted only once its write succeeded; a 409 on a cached
//   curve spends no gate attempt.
// - m7: while the switch is off, restoring a non-private YOLO lineage makes it private.
// - m8: an OG URL whose `?y=` does not name the version's class is a 302 to the right one.
// - the re-gate job flips a stale class to YOLO (`gate_yolo`) and the CHECK keeps the classes apart.
// Every user and curve is unique, so the file can share the database.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { gateForWrite } from 'open-auri/safety';
import { curveId, encodeS1 } from 'open-auri/share';
import { ApiError } from '#lib/server/api/index.ts';
import { getServerEnv } from '#lib/server/env.ts';
import { ogResponse } from '#lib/server/og/route.ts';
import { getOrCreateOg, type OgEnv } from '#lib/server/og/store.ts';
import { rateLimitKey } from '#lib/server/security/ratelimit.ts';
import {
	appendCurveVersion,
	forkCurve,
	loadLineageVersions,
	loadPublishedCurve,
	publishCurve,
	restoreCurve,
	retractCurve,
	type CurveDeps,
	type PublishedInfo
} from '#lib/server/social/curves.ts';
import { gateVersion, regateStale } from '#lib/server/social/gate.ts';
import {
	favoriteLineage,
	MERGE_GATE_RUNS_MAX,
	mergeLocalLibrary
} from '#lib/server/social/library.ts';
import { readFeed } from '#lib/server/social/rankings.ts';
import {
	encodeCursor,
	getLineageForViewer,
	listCurvesWithStaleGate,
	saveCurveGate
} from '#lib/server/social/repo.ts';
import { loadSharedCurve } from '#lib/server/social/shares.ts';
import { ANONYMOUS_VIEWER, DAY_MS, type YoloPublication } from '#lib/server/social/types.ts';
import {
	actor,
	ageAccount,
	ANON,
	count,
	envelopeOf,
	published,
	uniqueShelfCurve,
	uniqueYoloCurve,
	type Actor
} from '../curves/helpers.ts';
import { yoloS1 } from '../library/helpers.ts';

const ON: CurveDeps = { yoloPublication: 'on' };
const OFF: CurveDeps = {};
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

async function veteran(): Promise<Actor> {
	const owner = await actor();
	await ageAccount(owner.user);
	return owner;
}

/** The ApiError a call throws (fails the test when it resolves or throws anything else). */
async function rejection(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ApiError) return error;
		throw error;
	}
	throw new Error('expected an ApiError');
}

/** A public YOLO lineage its (old enough) owner acknowledged, published with the switch on. */
async function acknowledgedYolo(): Promise<{ owner: Actor; info: PublishedInfo }> {
	const owner = await veteran();
	const info = await publishCurve(
		env.DB,
		owner.user.id,
		{ envelope: envelopeOf(uniqueYoloCurve()), visibility: 'public', acknowledge: 'yolo' },
		ON
	);
	expect(info.yolo).toBe(true);
	return { owner, info };
}

/** Uses of a user's sliding-day counter (`group`), as the security kit stores them. */
async function used(group: string, userId: string): Promise<number> {
	const key = `${rateLimitKey.user(group, userId)}:${DAY_MS / 1000}`;
	const row = await env.DB.prepare(
		'SELECT COALESCE(sum(count), 0) AS n FROM rate_limit_counters WHERE key = ?'
	)
		.bind(key)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

function ogEnv(yoloPublication: YoloPublication): OgEnv {
	const server = getServerEnv({ env });
	return {
		db: server.db,
		media: server.media,
		publicOrigin: server.publicOrigin,
		assets: null,
		yoloPublication
	};
}

const noWait = { waitUntil: (promise: Promise<unknown>) => void promise };

/** Whether `lineageId` is on the first `yolo=only` page walked down from its creation time. */
async function inYoloFeed(info: PublishedInfo, owner: Actor, yolo: YoloPublication) {
	const lineage = await getLineageForViewer(env.DB, info.lineageId, { userId: owner.user.id });
	if (!lineage) throw new Error('owner cannot read the lineage');
	const page = await readFeed(
		env.DB,
		{
			sort: 'new',
			yolo: 'only',
			limit: 100,
			cursor: encodeCursor([lineage.createdAt + 1, ''])
		},
		yolo
	);
	return { page, listed: page.items.some((item) => item.lineage.id === info.lineageId) };
}

/** Everything others can reach of the lineage under the switch `yolo`. */
async function reach(info: PublishedInfo, owner: Actor, yolo: YoloPublication) {
	const deps: CurveDeps = yolo === 'on' ? ON : OFF;
	const other = await actor();
	const curve = await loadPublishedCurve(env.DB, info.lineageId, ANONYMOUS_VIEWER, null, deps);
	const history = await loadLineageVersions(env.DB, info.lineageId, ANONYMOUS_VIEWER, {}, deps);
	const page = await loadSharedCurve(env.DB, ANONYMOUS_VIEWER, info.lineageId, null, deps);
	const og = await getOrCreateOg(ogEnv(yolo), noWait, info.versionId, {
		render: async () => PNG
	});
	const feed = await inYoloFeed(info, owner, yolo);
	const favorite = await favoriteLineage(env.DB, other.user.id, info.lineageId, {
		yoloPublication: yolo
	});
	let fork: string;
	try {
		fork = (await forkCurve(env.DB, other.user.id, info.lineageId, {}, deps)).lineageId;
	} catch (error) {
		if (!(error instanceof ApiError)) throw error;
		fork = error.code;
	}
	return {
		curve: curve.kind,
		history: history.kind,
		page: page.kind,
		og: og.ok,
		feed: feed.listed,
		favorite: favorite.ok,
		fork
	};
}

describe('M1: the kill switch hides YOLO heads from others on every read', () => {
	it('on → off → on: link, history, /c/:id, OG, yolo=only feed, favorite and fork follow it', async () => {
		const { owner, info } = await acknowledgedYolo();

		const open = await reach(info, owner, 'on');
		expect(open).toMatchObject({
			curve: 'ok',
			history: 'ok',
			page: 'ok',
			og: true,
			feed: true,
			favorite: true
		});
		expect(open.fork).not.toBe('NOT_FOUND');

		const closed = await reach(info, owner, 'off');
		expect(closed).toEqual({
			curve: 'not-found',
			history: 'not-found',
			page: 'not-found',
			og: false,
			feed: false,
			favorite: false,
			fork: 'NOT_FOUND'
		});
		// The YOLO feed is an empty page while off (no cursor to follow).
		const empty = await readFeed(env.DB, { sort: 'new', yolo: 'only', limit: 100 }, 'off');
		expect(empty).toMatchObject({ items: [], nextCursor: null });
		// The acknowledgement stays: nothing to redo once the switch is back on.
		expect(
			await count(
				'SELECT count(*) AS n FROM lineage_yolo_acks WHERE lineage_id = ?',
				info.lineageId
			)
		).toBe(1);

		const again = await reach(info, owner, 'on');
		expect(again).toMatchObject({ curve: 'ok', history: 'ok', page: 'ok', og: true, feed: true });
	});

	it('the owner still reads, shares the page of and forks the lineage while the switch is off', async () => {
		const { owner, info } = await acknowledgedYolo();
		const viewer = { userId: owner.user.id };
		const own = await loadPublishedCurve(env.DB, info.lineageId, viewer, null, OFF);
		if (own.kind !== 'ok') throw new Error('owner cannot read the YOLO lineage');
		expect(own.value.curve.yolo).toBe(true);
		expect((await loadSharedCurve(env.DB, viewer, info.lineageId, null, OFF)).kind).toBe('ok');
		expect((await loadLineageVersions(env.DB, info.lineageId, viewer, {}, OFF)).kind).toBe('ok');
		const fork = await forkCurve(env.DB, owner.user.id, info.lineageId, {}, OFF);
		expect(fork.yolo).toBe(true);
	});

	it('a retracted YOLO lineage is a plain 404 for others while off (410 while on)', async () => {
		const { owner, info } = await acknowledgedYolo();
		await retractCurve(env.DB, owner.user.id, info.lineageId);
		expect(
			(await loadPublishedCurve(env.DB, info.lineageId, ANONYMOUS_VIEWER, null, ON)).kind
		).toBe('gone');
		expect(
			(await loadPublishedCurve(env.DB, info.lineageId, ANONYMOUS_VIEWER, null, OFF)).kind
		).toBe('not-found');
	});

	it('/og/:id.png of a YOLO version is a 404 through the route while the env switch is off', async () => {
		const { info } = await acknowledgedYolo();
		// The deployed default is "on" (901f50e); this test pins the switch off explicitly.
		const offEnv = { ...env, YOLO_PUBLICATION: 'off' };
		expect(getServerEnv({ env: offEnv }).yoloPublication).toBe('off');
		const event = ogEvent(`/og/${info.versionId}.png?y=1`, info.versionId);
		const response = await ogResponse(
			{ ...event, platform: { env: offEnv, ctx: noWait } },
			{ render: async () => PNG }
		);
		expect(response.status).toBe(404);
	});
});

describe('m4: gate runs are all counted', () => {
	it(`a merge never spends more than ${MERGE_GATE_RUNS_MAX} gate runs (a YOLO curve is exactly 2)`, async () => {
		const owner = await actor();
		let runs = 0;
		const gate: typeof gateForWrite = (bands, preampDb, options) => {
			runs++;
			return gateForWrite(bands, preampDb, options);
		};
		const yolos = MERGE_GATE_RUNS_MAX / 2;
		const items = [
			{ localId: 'shelf', s1: encodeS1(uniqueShelfCurve()), name: 'Prateleira' },
			...Array.from({ length: yolos }, (_, i) => ({
				localId: `yolo-${i}`,
				s1: yoloS1(),
				name: `Yolo ${i}`
			}))
		];
		const report = await mergeLocalLibrary(env.DB, owner.user.id, items, { deps: { gate } });
		// 1 (shelf) + 2 × (yolos − 1) runs, then the last YOLO's standard run reaches the budget and
		// its YOLO run is refused before it starts.
		expect(runs).toBe(MERGE_GATE_RUNS_MAX);
		expect(report.created).toHaveLength(yolos);
		expect(report.created.filter((entry) => entry.yolo === true)).toHaveLength(yolos - 1);
		expect(report.rejected).toEqual([{ localId: `yolo-${yolos - 1}`, code: 'QUOTA_EXCEEDED' }]);
	}, 120_000);
});

describe('m6: an acknowledgement is counted only once its write succeeded', () => {
	it('a 409 on a cached curve spends no gate attempt; the acknowledged retry counts one of each', async () => {
		const owner = await veteran();
		const envelope = envelopeOf(uniqueYoloCurve());
		// Private first: classified (one gate attempt) and cached, no acknowledgement needed.
		await publishCurve(env.DB, owner.user.id, { envelope, visibility: 'private' });
		expect(await used('curves.gate', owner.user.id)).toBe(1);

		const missing = await rejection(
			publishCurve(env.DB, owner.user.id, { envelope, visibility: 'public' }, ON)
		);
		expect(missing.code).toBe('YOLO_ACK_REQUIRED');
		expect(await used('curves.gate', owner.user.id)).toBe(1);
		const off = await rejection(
			publishCurve(env.DB, owner.user.id, { envelope, visibility: 'public', acknowledge: 'yolo' })
		);
		expect(off.code).toBe('YOLO_PUBLICATION_OFF');
		expect(await used('curves.gate', owner.user.id)).toBe(1);
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(0);

		await publishCurve(
			env.DB,
			owner.user.id,
			{ envelope, visibility: 'public', acknowledge: 'yolo' },
			ON
		);
		expect(await used('curves.gate', owner.user.id)).toBe(2);
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(1);
	});

	it('of two acknowledged appends on the same head, only the winner spends a slot', async () => {
		const owner = await veteran();
		const base = await published(owner);
		const append = () =>
			appendCurveVersion(
				env.DB,
				owner.user.id,
				base.lineageId,
				{
					parentVersionId: base.versionId,
					envelope: envelopeOf(uniqueYoloCurve()),
					acknowledge: 'yolo'
				},
				ON
			);
		const outcomes = await Promise.allSettled([append(), append()]);
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		const lost = outcomes.find((outcome) => outcome.status === 'rejected');
		const code = lost?.status === 'rejected' && lost.reason instanceof ApiError && lost.reason.code;
		// The service check or the repository batch (HEAD_MOVED), or the UNIQUE parent (DUPLICATE).
		expect(['HEAD_MOVED', 'DUPLICATE']).toContain(code);
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(1);
	});
});

describe('m7: restoring with the switch off', () => {
	it('restores a public YOLO lineage as private (no acknowledgement, no slot) and says so', async () => {
		const { owner, info } = await acknowledgedYolo();
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(1);
		await retractCurve(env.DB, owner.user.id, info.lineageId);

		const state = await restoreCurve(env.DB, owner.user.id, info.lineageId);
		expect(state).toMatchObject({ status: 'active', visibility: 'private' });
		expect(
			await count(
				"SELECT count(*) AS n FROM lineages WHERE id = ? AND status = 'active' AND visibility = 'private'",
				info.lineageId
			)
		).toBe(1);
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(1);
		expect(
			(await loadPublishedCurve(env.DB, info.lineageId, ANONYMOUS_VIEWER, null, ON)).kind
		).toBe('not-found');
		const own = await loadPublishedCurve(env.DB, info.lineageId, { userId: owner.user.id });
		expect(own.kind === 'ok' && own.value.lineage.visibility).toBe('private');
	});

	it('a standard lineage is restored with its visibility, whatever the switch', async () => {
		const owner = await actor();
		const info = await published(owner, { visibility: 'unlisted' });
		await retractCurve(env.DB, owner.user.id, info.lineageId);
		const state = await restoreCurve(env.DB, owner.user.id, info.lineageId);
		expect(state).toMatchObject({ status: 'active', visibility: 'unlisted' });
	});
});

function ogEvent(path: string, id: string) {
	return {
		request: new Request(new URL(path, env.PUBLIC_ORIGIN), {
			headers: { 'cf-connecting-ip': '10.9.8.7' }
		}),
		params: { id },
		locals: ANON,
		platform: { env, ctx: noWait }
	};
}

describe('m8: the OG card class in the URL', () => {
	it('a standard version asked with ?y=1 is a 302 to its bare URL, never cached', async () => {
		const info = await published(await actor());
		const response = await ogResponse(ogEvent(`/og/${info.versionId}.png?y=1`, info.versionId), {
			render: async () => PNG
		});
		expect(response.status).toBe(302);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('location')).toBe(
			new URL(`/og/${info.versionId}.png`, env.PUBLIC_ORIGIN).toString()
		);
		const right = await ogResponse(ogEvent(`/og/${info.versionId}.png`, info.versionId), {
			render: async () => PNG
		});
		expect(right.status).toBe(200);
		expect(right.headers.get('content-type')).toBe('image/png');
	});

	it('a YOLO version asked without ?y=1 is a class mismatch (nothing read or rendered)', async () => {
		const { info } = await acknowledgedYolo();
		let renders = 0;
		const render = async () => {
			renders++;
			return PNG;
		};
		expect(
			await getOrCreateOg(ogEnv('on'), noWait, info.versionId, { yolo: false, render })
		).toEqual({ ok: false, code: 'class-mismatch', yolo: true });
		expect(renders).toBe(0);
		const card = await getOrCreateOg(ogEnv('on'), noWait, info.versionId, { yolo: true, render });
		expect(card.ok && card.source).toBe('render');
		expect(renders).toBe(1);
	});
});

describe('the re-gate job and the YOLO class', () => {
	it('flips a curve cached as standard by an older gate to YOLO; the CHECK refuses both flags', async () => {
		const s1 = encodeS1(uniqueYoloCurve());
		const id = await curveId(s1);
		const saved = await saveCurveGate(
			env.DB,
			{
				id,
				s1,
				canonKey: `qa1;${id}`,
				gateVer: 'v2.1:0000000000000000',
				gateOk: true,
				gateReasons: [],
				levelDb: null
			},
			1
		);
		if (!saved.ok) throw new Error(`stale insert failed: ${saved.code}`);
		const list: typeof listCurvesWithStaleGate = async (db, version) =>
			(await listCurvesWithStaleGate(db, version, 1000)).filter((curve) => curve.id === id);
		expect(await regateStale(env.DB, 50, Date.now(), { list })).toStrictEqual({
			checked: 1,
			changed: 1
		});
		const row = await env.DB.prepare(
			'SELECT gate_ok, gate_yolo, gate_reasons, gate_ver FROM curves WHERE id = ?'
		)
			.bind(id)
			.first<{ gate_ok: number; gate_yolo: number; gate_reasons: string; gate_ver: string }>();
		expect(row).toMatchObject({ gate_ok: 0, gate_yolo: 1, gate_ver: await gateVersion() });
		expect(JSON.parse(row?.gate_reasons ?? '[]')).toContain('d7:pk-boost-above-16k');
		await expect(
			env.DB.prepare('UPDATE curves SET gate_ok = 1, gate_yolo = 1 WHERE id = ?').bind(id).run()
		).rejects.toThrow();
	});
});
