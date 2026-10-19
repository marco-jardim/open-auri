// YOLO publication, QA round 2 (server, PR #49):
// - the append / visibility race: an append of a YOLO version and a visibility change that opens
//   the lineage, in both orders, never leave a lineage visible to others with a YOLO head its
//   owner did not acknowledge (the write whose state moved is retried with the YOLO rules of the
//   state it finds; a restore the same way);
// - the 5-a-day acknowledgement cap holds under concurrent openings, and a failed write gives its
//   slot back;
// - classification run counts: a hard rejection is exactly 1 gate run, a YOLO curve exactly 2, all
//   through the injected gate (classification, re-gate, library merge);
// - the automatic hiding applies the threshold of the head the lineage has AS IT IS HIDDEN (a
//   standard version appended in between is judged by the standard threshold), and audits it;
// - a curation the head refuses as it is written (an append made it YOLO) is UNSUPPORTED, without
//   an audit row;
// - an OG class redirect keeps the URL's other query parameters.
// Every user and curve is unique, so the file can share the database.
import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { gateForWrite } from 'open-auri/safety';
import { curveId, encodeS1 } from 'open-auri/share';
import { listAudit } from '#lib/server/admin/audit.ts';
import { ApiError } from '#lib/server/api/index.ts';
import { ogResponse } from '#lib/server/og/route.ts';
import { rateLimitKey } from '#lib/server/security/ratelimit.ts';
import {
	appendCurveVersion,
	changeVisibility,
	loadPublishedCurve,
	publishCurve,
	restoreCurve,
	retractCurve,
	STATE_ATTEMPTS,
	YOLO_ACKS_DAILY_MAX,
	type CurveDeps,
	type PublishedInfo
} from '#lib/server/social/curves.ts';
import { checkPublishable, regateCurve, regateStale } from '#lib/server/social/gate.ts';
import { mergeLocalLibrary } from '#lib/server/social/library.ts';
import {
	AUTO_HIDE_THRESHOLD,
	decide,
	maybeAutoHide,
	YOLO_AUTO_HIDE_THRESHOLD,
	type DecisionDeps
} from '#lib/server/social/moderation.ts';
import {
	getCurve,
	insertReport,
	listCurvesWithStaleGate,
	saveCurveGate,
	setLineageVisibility
} from '#lib/server/social/repo.ts';
import { ANONYMOUS_VIEWER, DAY_MS } from '#lib/server/social/types.ts';
import {
	actor,
	ageAccount,
	ANON,
	count,
	envelopeOf,
	presetCurve,
	published,
	uniqueRejectedCurve,
	uniqueShelfCurve,
	uniqueYoloCurve,
	type Actor
} from '../curves/helpers.ts';
import { lineageCurated, lineageModeration, reporter, seedUser } from '../moderation/helpers.ts';

const ON: CurveDeps = { yoloPublication: 'on' };
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const noWait = { waitUntil: (promise: Promise<unknown>) => void promise };

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

function acks(lineageId: string): Promise<number> {
	return count('SELECT count(*) AS n FROM lineage_yolo_acks WHERE lineage_id = ?', lineageId);
}

/** The lineage as stored: visibility and the class of its head curve. */
async function stored(lineageId: string) {
	return env.DB.prepare(
		'SELECT l.visibility AS visibility, l.status AS status, l.head_version AS head, ' +
			'c.gate_yolo AS yolo FROM lineages l JOIN versions v ON v.id = l.head_version ' +
			'JOIN curves c ON c.id = v.curve_id WHERE l.id = ?'
	)
		.bind(lineageId)
		.first<{ visibility: string; status: string; head: string; yolo: number }>();
}

/**
 * Whether others may see a YOLO head the owner did not acknowledge: a non-private lineage whose
 * head is YOLO without an acknowledgement row of (lineage, head curve). Must never be true.
 */
async function unacknowledgedYoloExposed(lineageId: string): Promise<boolean> {
	return (
		(await count(
			'SELECT count(*) AS n FROM lineages l JOIN versions v ON v.id = l.head_version ' +
				'JOIN curves c ON c.id = v.curve_id WHERE l.id = ? AND l.visibility <> ? AND ' +
				'c.gate_yolo = 1 AND NOT EXISTS (SELECT 1 FROM lineage_yolo_acks k ' +
				'WHERE k.lineage_id = l.id AND k.curve_id = c.id)',
			lineageId,
			'private'
		)) > 0
	);
}

/**
 * `db` whose next `batch` first awaits `hook` (once): a concurrent request that lands between the
 * reads of a call and its write (moderation writes go through one batch each).
 */
function beforeNextBatch(db: D1Database, hook: () => Promise<unknown>): D1Database {
	let pending: (() => Promise<unknown>) | null = hook;
	return new Proxy(db, {
		get(target, property) {
			if (property === 'batch') {
				return async (statements: Parameters<D1Database['batch']>[0]) => {
					const run = pending;
					pending = null;
					if (run) await run();
					return target.batch(statements);
				};
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

/** A YOLO version on top of `parentVersionId` (private lineages need no acknowledgement). */
function appendYolo(
	owner: Actor,
	lineageId: string,
	parentVersionId: string,
	acknowledge?: 'yolo'
): Promise<PublishedInfo> {
	return appendCurveVersion(
		env.DB,
		owner.user.id,
		lineageId,
		{ parentVersionId, envelope: envelopeOf(uniqueYoloCurve()), acknowledge },
		ON
	);
}

/** A private lineage with a standard head. */
function privateStandard(owner: Actor): Promise<PublishedInfo> {
	return published(owner, { visibility: 'private', envelope: envelopeOf(presetCurve(2)) });
}

describe('append vs visibility change (both orders)', () => {
	it('the visibility opens first: the YOLO append is re-judged as public (409 without the ack)', async () => {
		const owner = await veteran();
		const base = await privateStandard(owner);
		let opened = 0;
		const deps: CurveDeps = {
			...ON,
			beforeWrite: async (attempt) => {
				if (attempt !== 1) return;
				opened++;
				// The append read the lineage as private (no acknowledgement); it opens now.
				await changeVisibility(env.DB, owner.user.id, base.lineageId, 'public', ON);
			}
		};
		const refused = await rejection(
			appendCurveVersion(
				env.DB,
				owner.user.id,
				base.lineageId,
				{ parentVersionId: base.versionId, envelope: envelopeOf(uniqueYoloCurve()) },
				deps
			)
		);
		expect(opened).toBe(1);
		expect(refused.code).toBe('YOLO_ACK_REQUIRED');
		// Nothing of the append was written: the public lineage keeps its standard head.
		expect(await stored(base.lineageId)).toMatchObject({
			visibility: 'public',
			head: base.versionId,
			yolo: 0
		});
		expect(
			await count('SELECT count(*) AS n FROM versions WHERE lineage_id = ?', base.lineageId)
		).toBe(1);
		expect(await acks(base.lineageId)).toBe(0);
		expect(await unacknowledgedYoloExposed(base.lineageId)).toBe(false);
		const read = await loadPublishedCurve(env.DB, base.lineageId, ANONYMOUS_VIEWER, null, ON);
		expect(read.kind === 'ok' && read.value.curve.yolo).toBe(false);
	});

	it('the visibility opens first: with the ack, the retried append is acknowledged (one slot)', async () => {
		const owner = await veteran();
		const base = await privateStandard(owner);
		const deps: CurveDeps = {
			...ON,
			beforeWrite: async (attempt) => {
				if (attempt === 1) {
					await changeVisibility(env.DB, owner.user.id, base.lineageId, 'public', ON);
				}
			}
		};
		const info = await appendCurveVersion(
			env.DB,
			owner.user.id,
			base.lineageId,
			{
				parentVersionId: base.versionId,
				envelope: envelopeOf(uniqueYoloCurve()),
				acknowledge: 'yolo'
			},
			deps
		);
		expect(info.yolo).toBe(true);
		expect(await stored(base.lineageId)).toMatchObject({
			visibility: 'public',
			head: info.versionId,
			yolo: 1
		});
		expect(await acks(base.lineageId)).toBe(1);
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(1);
		expect(await unacknowledgedYoloExposed(base.lineageId)).toBe(false);
		const read = await loadPublishedCurve(env.DB, base.lineageId, ANONYMOUS_VIEWER, null, ON);
		expect(read.kind === 'ok' && read.value.curve.yolo).toBe(true);
	});

	it('the YOLO append lands first: the opening is re-judged on the new head (409 without the ack)', async () => {
		const owner = await veteran();
		const base = await privateStandard(owner);
		const appended: { info: PublishedInfo | null } = { info: null };
		const deps: CurveDeps = {
			...ON,
			beforeWrite: async (attempt) => {
				// The opening classified the standard head (nothing to acknowledge); a YOLO version
				// becomes the head now (private: no acknowledgement needed for the append).
				if (attempt === 1) {
					appended.info = await appendYolo(owner, base.lineageId, base.versionId);
				}
			}
		};
		const refused = await rejection(
			changeVisibility(env.DB, owner.user.id, base.lineageId, 'public', deps)
		);
		expect(appended.info).not.toBeNull();
		expect(refused.code).toBe('YOLO_ACK_REQUIRED');
		expect(await stored(base.lineageId)).toMatchObject({ visibility: 'private', yolo: 1 });
		expect(await acks(base.lineageId)).toBe(0);
		expect(await unacknowledgedYoloExposed(base.lineageId)).toBe(false);
	});

	it('the YOLO append lands first: with the ack, the new head is acknowledged', async () => {
		const owner = await veteran();
		const base = await privateStandard(owner);
		const appended: { info: PublishedInfo | null } = { info: null };
		const deps: CurveDeps = {
			...ON,
			beforeWrite: async (attempt) => {
				if (attempt === 1) {
					appended.info = await appendYolo(owner, base.lineageId, base.versionId);
				}
			}
		};
		const state = await changeVisibility(
			env.DB,
			owner.user.id,
			base.lineageId,
			'public',
			deps,
			'yolo'
		);
		expect(state.visibility).toBe('public');
		const head = appended.info;
		if (!head) throw new Error('the concurrent append did not run');
		expect(await stored(base.lineageId)).toMatchObject({
			visibility: 'public',
			head: head.versionId,
			yolo: 1
		});
		expect(
			await count(
				'SELECT count(*) AS n FROM lineage_yolo_acks WHERE lineage_id = ? AND curve_id = ?',
				base.lineageId,
				head.curveId
			)
		).toBe(1);
		// The first attempt (standard head) took no slot; the retry took exactly one.
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(1);
		expect(await unacknowledgedYoloExposed(base.lineageId)).toBe(false);
	});

	it(`a state that keeps moving ends in 409 HEAD_MOVED after ${STATE_ATTEMPTS} attempts, no slot spent`, async () => {
		const owner = await veteran();
		const info = await published(owner, {
			envelope: envelopeOf(presetCurve(4)),
			visibility: 'public'
		});
		let attempts = 0;
		const deps: CurveDeps = {
			...ON,
			beforeWrite: async () => {
				attempts++;
				// Every attempt finds another visibility than the one it read.
				const next = attempts % 2 === 1 ? 'unlisted' : 'public';
				await setLineageVisibility(env.DB, info.lineageId, owner.user.id, next, Date.now());
			}
		};
		const refused = await rejection(
			appendCurveVersion(
				env.DB,
				owner.user.id,
				info.lineageId,
				{
					parentVersionId: info.versionId,
					envelope: envelopeOf(uniqueYoloCurve()),
					acknowledge: 'yolo'
				},
				deps
			)
		);
		expect(refused.code).toBe('HEAD_MOVED');
		expect(attempts).toBe(STATE_ATTEMPTS);
		expect(await stored(info.lineageId)).toMatchObject({ head: info.versionId, yolo: 0 });
		expect(await acks(info.lineageId)).toBe(0);
		// Each attempt took a slot and gave it back.
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(0);
	});

	it('a restore follows the visibility it finds (closed: no ack, no slot; reopened: acked)', async () => {
		const owner = await veteran();
		const info = await publishCurve(
			env.DB,
			owner.user.id,
			{ envelope: envelopeOf(uniqueYoloCurve()), visibility: 'public', acknowledge: 'yolo' },
			ON
		);
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(1);
		await retractCurve(env.DB, owner.user.id, info.lineageId);
		const closing: CurveDeps = {
			...ON,
			beforeWrite: async (attempt) => {
				if (attempt === 1) {
					await setLineageVisibility(env.DB, info.lineageId, owner.user.id, 'private', Date.now());
				}
			}
		};
		const restored = await restoreCurve(env.DB, owner.user.id, info.lineageId, closing, 'yolo');
		expect(restored).toMatchObject({ status: 'active', visibility: 'private' });
		// The first attempt's slot (public, acknowledged) was given back.
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(1);

		await retractCurve(env.DB, owner.user.id, info.lineageId);
		const reopening: CurveDeps = {
			...ON,
			beforeWrite: async (attempt) => {
				if (attempt === 1) {
					await setLineageVisibility(env.DB, info.lineageId, owner.user.id, 'unlisted', Date.now());
				}
			}
		};
		const again = await restoreCurve(env.DB, owner.user.id, info.lineageId, reopening, 'yolo');
		expect(again).toMatchObject({ status: 'active', visibility: 'unlisted' });
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(2);
		expect(await unacknowledgedYoloExposed(info.lineageId)).toBe(false);
	});
});

describe('the daily acknowledgement cap is atomic', () => {
	it(`of 8 concurrent openings exactly ${YOLO_ACKS_DAILY_MAX} succeed; a refusal spends nothing`, async () => {
		const owner = await veteran();
		const lineages: PublishedInfo[] = [];
		for (let i = 0; i < 8; i++) {
			lineages.push(
				await publishCurve(env.DB, owner.user.id, {
					envelope: envelopeOf(uniqueYoloCurve()),
					visibility: 'private'
				})
			);
		}
		const outcomes = await Promise.allSettled(
			lineages.map((info) =>
				changeVisibility(env.DB, owner.user.id, info.lineageId, 'public', ON, 'yolo')
			)
		);
		const opened = outcomes.filter((outcome) => outcome.status === 'fulfilled');
		expect(opened).toHaveLength(YOLO_ACKS_DAILY_MAX);
		for (const outcome of outcomes) {
			if (outcome.status === 'fulfilled') continue;
			expect(outcome.reason).toBeInstanceOf(ApiError);
			expect(outcome.reason instanceof ApiError && outcome.reason.code).toBe('QUOTA_EXCEEDED');
		}
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(YOLO_ACKS_DAILY_MAX);
		let publicCount = 0;
		let ackCount = 0;
		for (const info of lineages) {
			if ((await stored(info.lineageId))?.visibility === 'public') publicCount++;
			ackCount += await acks(info.lineageId);
			expect(await unacknowledgedYoloExposed(info.lineageId)).toBe(false);
		}
		expect(publicCount).toBe(YOLO_ACKS_DAILY_MAX);
		expect(ackCount).toBe(YOLO_ACKS_DAILY_MAX);

		// Past the cap, one more opening is a 429 that leaves the counter where it was.
		const late = lineages.find((info) => !opened.some((o) => o.value.lineageId === info.lineageId));
		if (!late) throw new Error('every lineage was opened');
		const refused = await rejection(
			changeVisibility(env.DB, owner.user.id, late.lineageId, 'unlisted', ON, 'yolo')
		);
		expect(refused.code).toBe('QUOTA_EXCEEDED');
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(YOLO_ACKS_DAILY_MAX);
	});

	it('a write that fails gives its slot back (no acknowledgement, no slot)', async () => {
		const owner = await veteran();
		const info = await publishCurve(env.DB, owner.user.id, {
			envelope: envelopeOf(uniqueYoloCurve()),
			visibility: 'private'
		});
		let head = info.versionId;
		const deps: CurveDeps = {
			...ON,
			// The head moves under every attempt: each opening fails after taking its slot.
			beforeWrite: async () => {
				head = (await appendYolo(owner, info.lineageId, head)).versionId;
			}
		};
		const refused = await rejection(
			changeVisibility(env.DB, owner.user.id, info.lineageId, 'public', deps, 'yolo')
		);
		expect(refused.code).toBe('HEAD_MOVED');
		expect(await used('curves.yolo.ack', owner.user.id)).toBe(0);
		expect(await acks(info.lineageId)).toBe(0);
		expect(await stored(info.lineageId)).toMatchObject({ visibility: 'private', head });
	});
});

describe('classification run counts (all through the injected gate)', () => {
	function countingGate(): { gate: typeof gateForWrite; runs: () => number } {
		let runs = 0;
		const gate: typeof gateForWrite = (bands, preampDb, options) => {
			runs++;
			return gateForWrite(bands, preampDb, options);
		};
		return { gate, runs: () => runs };
	}

	async function stale(s1: string): Promise<string> {
		const id = await curveId(s1);
		const saved = await saveCurveGate(
			env.DB,
			{
				id,
				s1,
				canonKey: `qa2;${id}`,
				gateVer: 'v2.1:0000000000000000',
				gateOk: true,
				gateReasons: [],
				levelDb: null
			},
			1
		);
		if (!saved.ok) throw new Error(`stale insert failed: ${saved.code}`);
		return id;
	}

	it('publication check: hard rejection 1, YOLO 2, standard 1', async () => {
		for (const [s1, runs, verdict] of [
			[encodeS1(uniqueRejectedCurve()), 1, 'rejected'],
			[encodeS1(uniqueYoloCurve()), 2, 'yolo'],
			[encodeS1(uniqueShelfCurve()), 1, 'standard']
		] as const) {
			const spy = countingGate();
			const check = await checkPublishable(env.DB, s1, Date.now(), { gate: spy.gate });
			expect(check.ok ? check.class : 'rejected').toBe(verdict);
			expect(check.gateRuns).toBe(runs);
			expect(spy.runs()).toBe(runs);
		}
	});

	it('lazy re-gate (regateCurve) and the job step (regateStale): hard 1, YOLO 2', async () => {
		const hard = await stale(encodeS1(uniqueRejectedCurve()));
		const yolo = await stale(encodeS1(uniqueYoloCurve()));
		const lazy = countingGate();
		const record = await getCurve(env.DB, hard);
		if (!record) throw new Error('missing stale row');
		const fresh = await regateCurve(env.DB, record, Date.now(), { gate: lazy.gate });
		expect(fresh).toMatchObject({ gateOk: false, gateYolo: false });
		expect(lazy.runs()).toBe(1);

		const job = countingGate();
		const list: typeof listCurvesWithStaleGate = async (db, version) =>
			(await listCurvesWithStaleGate(db, version, 1000)).filter((curve) => curve.id === yolo);
		expect(await regateStale(env.DB, 50, Date.now(), { gate: job.gate, list })).toEqual({
			checked: 1,
			changed: 1
		});
		expect(job.runs()).toBe(2);
		expect(await getCurve(env.DB, yolo)).toMatchObject({ gateOk: false, gateYolo: true });
	});

	it('library merge: a hard rejection and a YOLO curve cost 1 + 2 counted runs', async () => {
		const owner = await actor();
		const spy = countingGate();
		const report = await mergeLocalLibrary(
			env.DB,
			owner.user.id,
			[
				{ localId: 'hard', s1: encodeS1(uniqueRejectedCurve()), name: 'Duro' },
				{ localId: 'yolo', s1: encodeS1(uniqueYoloCurve()), name: 'Yolo' }
			],
			{ deps: { gate: spy.gate } }
		);
		expect(spy.runs()).toBe(3);
		expect(report.rejected.map((entry) => entry.localId)).toEqual(['hard']);
		expect(report.created.map((entry) => [entry.localId, entry.yolo])).toEqual([['yolo', true]]);
	});
});

describe('automatic hiding: the threshold of the current head, atomically', () => {
	async function reportedYolo(reporters: number) {
		const owner = await veteran();
		const info = await published(owner, {
			envelope: envelopeOf(uniqueYoloCurve()),
			yolo: true
		});
		const now = Date.now();
		for (let i = 0; i < reporters; i++) {
			await insertReport(env.DB, {
				id: crypto.randomUUID(),
				targetKind: 'lineage',
				targetId: info.lineageId,
				reason: 'dangerous',
				note: null,
				reporterUserId: (await reporter()).id,
				now
			});
		}
		return { owner, info, now };
	}

	async function autoHides(lineageId: string) {
		const trail = await listAudit(env.DB, { targetId: lineageId });
		return trail.rows.filter((row) => row.action === 'moderation.auto_hide');
	}

	it(`a YOLO head is hidden by ${YOLO_AUTO_HIDE_THRESHOLD} eligible reporters, audited with that threshold`, async () => {
		const { info, now } = await reportedYolo(YOLO_AUTO_HIDE_THRESHOLD);
		expect(await maybeAutoHide(env.DB, 'lineage', info.lineageId, now)).toBe(true);
		expect(await lineageModeration(info.lineageId)).toBe('auto_hidden');
		const rows = await autoHides(info.lineageId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.detail).toEqual({
			reporters: YOLO_AUTO_HIDE_THRESHOLD,
			threshold: YOLO_AUTO_HIDE_THRESHOLD,
			yolo: true
		});
	});

	it('a standard version appended before the write: judged by the standard threshold', async () => {
		const { owner, info, now } = await reportedYolo(YOLO_AUTO_HIDE_THRESHOLD);
		const racing = beforeNextBatch(env.DB, () =>
			appendCurveVersion(
				env.DB,
				owner.user.id,
				info.lineageId,
				{ parentVersionId: info.versionId, envelope: envelopeOf(presetCurve(5)) },
				ON
			)
		);
		expect(await maybeAutoHide(racing, 'lineage', info.lineageId, now)).toBe(false);
		expect(await lineageModeration(info.lineageId)).toBe('visible');
		expect(await autoHides(info.lineageId)).toEqual([]);

		// The standard threshold: one more eligible reporter hides it, audited without `yolo`.
		await insertReport(env.DB, {
			id: crypto.randomUUID(),
			targetKind: 'lineage',
			targetId: info.lineageId,
			reason: 'spam',
			note: null,
			reporterUserId: (await reporter()).id,
			now
		});
		expect(await maybeAutoHide(env.DB, 'lineage', info.lineageId, now)).toBe(true);
		const rows = await autoHides(info.lineageId);
		expect(rows.map((row) => row.detail)).toEqual([
			{ reporters: AUTO_HIDE_THRESHOLD, threshold: AUTO_HIDE_THRESHOLD }
		]);
	});
});

describe('curation refused as it is written', () => {
	// Curation never reaches Better Auth (only the ban decision does).
	const noAuth = new Proxy(
		{},
		{
			get() {
				throw new Error('curation does not use Better Auth');
			}
		}
	) as DecisionDeps['auth'];

	function deps(db: D1Database, actorId: string): DecisionDeps {
		return { db, actorId, auth: noAuth, headers: new Headers() };
	}

	async function curations(lineageId: string): Promise<string[]> {
		const trail = await listAudit(env.DB, { targetId: lineageId });
		return trail.rows.map((row) => row.action).filter((action) => action.includes('curate'));
	}

	it('an append makes the head YOLO after the check: UNSUPPORTED, nothing written, no audit', async () => {
		const admin = await seedUser();
		const owner = await veteran();
		const info = await published(owner, { envelope: envelopeOf(presetCurve(6)) });
		const racing = beforeNextBatch(env.DB, () =>
			appendYolo(owner, info.lineageId, info.versionId, 'yolo')
		);
		const result = await decide(deps(racing, admin.id), {
			decision: 'curate',
			targetKind: 'lineage',
			targetId: info.lineageId,
			reason: ''
		});
		expect(result).toEqual({ ok: false, code: 'UNSUPPORTED' });
		expect(await lineageCurated(info.lineageId)).toBe(0);
		expect(await curations(info.lineageId)).toEqual([]);
	});

	it('a standard head is curated with exactly one audit row', async () => {
		const admin = await seedUser();
		const info = await published(await actor(), { envelope: envelopeOf(presetCurve(7)) });
		const input = { targetKind: 'lineage' as const, targetId: info.lineageId, reason: '' };
		expect(await decide(deps(env.DB, admin.id), { ...input, decision: 'curate' })).toEqual({
			ok: true,
			resolved: 0
		});
		expect(await lineageCurated(info.lineageId)).toBe(1);
		expect(await curations(info.lineageId)).toEqual(['moderation.curate']);
	});
});

describe('OG class redirect keeps the other query parameters', () => {
	function ogEvent(path: string, id: string, yoloPublication: 'on' | 'off') {
		return {
			request: new Request(new URL(path, env.PUBLIC_ORIGIN), {
				headers: { 'cf-connecting-ip': '10.9.8.6' }
			}),
			params: { id },
			locals: ANON,
			platform: { env: { ...env, YOLO_PUBLICATION: yoloPublication }, ctx: noWait }
		};
	}

	async function location(path: string, id: string, yolo: 'on' | 'off'): Promise<string | null> {
		const response = await ogResponse(ogEvent(path, id, yolo), { render: async () => PNG });
		expect(response.status).toBe(302);
		expect(response.headers.get('cache-control')).toBe('no-store');
		return response.headers.get('location');
	}

	it('standard: only `y` is removed (order and repeated keys kept)', async () => {
		const info = await published(await actor());
		const path = `/og/${info.versionId}.png`;
		const url = (query: string) => new URL(`${path}${query}`, env.PUBLIC_ORIGIN).toString();
		expect(await location(`${path}?utm_source=x&y=1&v=2&v=3`, info.versionId, 'off')).toBe(
			url('?utm_source=x&v=2&v=3')
		);
		expect(await location(`${path}?y=1`, info.versionId, 'off')).toBe(url(''));
	});

	it('YOLO: `y` is set to 1 in place, the rest kept', async () => {
		const owner = await veteran();
		const info = await published(owner, { envelope: envelopeOf(uniqueYoloCurve()), yolo: true });
		const path = `/og/${info.versionId}.png`;
		const url = (query: string) => new URL(`${path}${query}`, env.PUBLIC_ORIGIN).toString();
		expect(await location(`${path}?utm_source=x`, info.versionId, 'on')).toBe(
			url('?utm_source=x&y=1')
		);
		expect(await location(`${path}?a=1&y=0&b=2`, info.versionId, 'on')).toBe(url('?a=1&y=1&b=2'));
	});
});
