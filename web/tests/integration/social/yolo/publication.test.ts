// YOLO publication, writes (docs/api.md "Classe da curva"): publish, append, fork, visibility and
// restore across class × visibility × acknowledgement × kill switch, the 72 h account age, the
// daily acknowledgement quota, GATE_REJECTED `details.hard`, an S1 v2 curve through `@2`, and the
// private-only library merge with its 2× gate-run count. Calls the services directly (the routes
// only add `yoloPublication` from the env and `acknowledge` from the body). Every user and curve is
// unique, so the file can share the database.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { decodeS1 } from 'open-auri/share';
import { ApiError } from '#lib/server/api/index.ts';
import {
	appendCurveVersion,
	changeVisibility,
	forkCurve,
	loadPublishedCurve,
	publishCurve,
	restoreCurve,
	retractCurve,
	YOLO_ACKS_DAILY_MAX,
	type CurveDeps
} from '#lib/server/social/curves.ts';
import { MERGE_GATE_RUNS_MAX, mergeLocalLibrary } from '#lib/server/social/library.ts';
import { getLineageForViewer, setLineageVisibility } from '#lib/server/social/repo.ts';
import { ANONYMOUS_VIEWER, type LineageVisibility } from '#lib/server/social/types.ts';
import {
	actor,
	ageAccount,
	count,
	envelopeOf,
	presetCurve,
	published,
	uniqueRejectedCurve,
	uniqueShelfCurve,
	uniqueUltrasonicCut,
	uniqueYoloCurve,
	type Actor
} from '../curves/helpers.ts';
import { yoloS1 } from '../library/helpers.ts';

const ON: CurveDeps = { yoloPublication: 'on' };

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

/** A verified member whose account is older than 72 h (may open YOLO lineages to others). */
async function veteran(): Promise<Actor> {
	const owner = await actor();
	await ageAccount(owner.user);
	return owner;
}

async function acks(lineageId: string): Promise<number> {
	return count('SELECT count(*) AS n FROM lineage_yolo_acks WHERE lineage_id = ?', lineageId);
}

/** Publishes a YOLO curve (a fresh one unless `envelope` is given). */
function publishYolo(
	owner: Actor,
	visibility: LineageVisibility,
	options: { acknowledge?: boolean; deps?: CurveDeps; envelope?: Record<string, unknown> } = {}
) {
	return publishCurve(
		env.DB,
		owner.user.id,
		{
			envelope: options.envelope ?? envelopeOf(uniqueYoloCurve()),
			visibility,
			...(options.acknowledge ? { acknowledge: 'yolo' as const } : {})
		},
		options.deps ?? ON
	);
}

async function anonymousRead(lineageId: string): Promise<string> {
	return (await loadPublishedCurve(env.DB, lineageId, ANONYMOUS_VIEWER)).kind;
}

describe('publish', () => {
	it('an HS shelf within the limits publishes publicly as standard', async () => {
		const info = await published(await actor(), { envelope: envelopeOf(uniqueShelfCurve()) });
		expect(info.yolo).toBe(false);
		expect(
			await count('SELECT count(*) AS n FROM curves WHERE id = ? AND gate_ok = 1', info.curveId)
		).toBe(1);
		expect(await anonymousRead(info.lineageId)).toBe('ok');
	});

	it('a private YOLO curve needs nothing (kill switch off, new account, no acknowledgement)', async () => {
		const owner = await actor();
		const info = await publishYolo(owner, 'private', { deps: {} });
		expect(info.yolo).toBe(true);
		expect(await acks(info.lineageId)).toBe(0);
		const own = await loadPublishedCurve(env.DB, info.lineageId, { userId: owner.user.id });
		if (own.kind !== 'ok') throw new Error('owner cannot read the private YOLO lineage');
		expect(own.value.curve.yolo).toBe(true);
		expect(own.value.curve.gate.ok).toBe(false);
		expect(own.value.curve.waived).toContain('d7:pk-boost-above-16k');
	});

	for (const visibility of ['public', 'unlisted'] as const) {
		it(`${visibility}: kill switch off → 403 YOLO_PUBLICATION_OFF, even with the acknowledgement`, async () => {
			const error = await rejection(
				publishYolo(await veteran(), visibility, { acknowledge: true, deps: {} })
			);
			expect(error.status).toBe(403);
			expect(error.code).toBe('YOLO_PUBLICATION_OFF');
		});

		it(`${visibility}: an account younger than 72 h → 403 FORBIDDEN (account-age)`, async () => {
			const error = await rejection(publishYolo(await actor(), visibility, { acknowledge: true }));
			expect(error.status).toBe(403);
			expect(error.code).toBe('FORBIDDEN');
			expect(error.details).toMatchObject({ reason: 'account-age', minAgeHours: 72 });
		});

		it(`${visibility}: no acknowledgement → 409 YOLO_ACK_REQUIRED with the waived codes`, async () => {
			const error = await rejection(publishYolo(await veteran(), visibility));
			expect(error.status).toBe(409);
			expect(error.code).toBe('YOLO_ACK_REQUIRED');
			expect((error.details as { waived: string[] }).waived).toContain('d7:pk-boost-above-16k');
		});

		it(`${visibility}: with the acknowledgement it publishes, writes the ack and opens by id`, async () => {
			const info = await publishYolo(await veteran(), visibility, { acknowledge: true });
			expect(info.yolo).toBe(true);
			expect(await acks(info.lineageId)).toBe(1);
			const read = await loadPublishedCurve(env.DB, info.lineageId, ANONYMOUS_VIEWER);
			if (read.kind !== 'ok') throw new Error('acknowledged YOLO lineage is not linkable');
			expect(read.value.curve.yolo).toBe(true);
			expect(read.value.curve.gate.ok).toBe(false);
		});
	}

	it('a standard publication needs no acknowledgement (and writes none)', async () => {
		const info = await published(await actor());
		expect(info.yolo).toBe(false);
		expect(await acks(info.lineageId)).toBe(0);
	});

	it(`allows ${YOLO_ACKS_DAILY_MAX} acknowledgements per sliding day, then 429`, async () => {
		const owner = await veteran();
		for (let i = 0; i < YOLO_ACKS_DAILY_MAX; i++) {
			await publishYolo(owner, 'public', { acknowledge: true });
		}
		const error = await rejection(publishYolo(owner, 'public', { acknowledge: true }));
		expect(error.status).toBe(429);
		expect(error.code).toBe('QUOTA_EXCEEDED');
		expect(error.details).toMatchObject({ limit: YOLO_ACKS_DAILY_MAX, group: 'curves.yolo.ack' });
		// Private YOLO writes are not acknowledgements: still allowed.
		expect((await publishYolo(owner, 'private')).yolo).toBe(true);
	}, 60_000);

	it('a curve that fails a hard reason is 422 GATE_REJECTED with details.hard', async () => {
		const error = await rejection(
			publishCurve(
				env.DB,
				(await veteran()).user.id,
				{ envelope: envelopeOf(uniqueRejectedCurve()), visibility: 'private', acknowledge: 'yolo' },
				ON
			)
		);
		expect(error.code).toBe('GATE_REJECTED');
		const details = error.details as { reasons: string[]; hard: string[] };
		expect(details.reasons).toContain('e:output-audible');
		expect(details.hard).toContain('e:output-audible');
	});

	it('an S1 v2 curve (PK cut at 25 kHz) publishes through @2 without labels, and forks as @2', async () => {
		const owner = await actor();
		const envelope = envelopeOf(uniqueUltrasonicCut());
		expect(envelope.format).toBe('open-auri/preset@2');
		expect(envelope).not.toHaveProperty('labels');
		const info = await published(owner, { envelope });
		expect(info.yolo).toBe(false);
		const read = await loadPublishedCurve(env.DB, info.lineageId, ANONYMOUS_VIEWER);
		if (read.kind !== 'ok') throw new Error('S1 v2 lineage not readable');
		expect(decodeS1(read.value.curve.s1).version).toBe(2);
		expect(read.value.version.labels).toBeNull();
		// A fork without an envelope rebuilds one on the server (envelopeFormat: @2 for S1 v2).
		const fork = await forkCurve(env.DB, owner.user.id, info.lineageId, {});
		expect(fork.curveId).toBe(info.curveId);
	});
});

describe('append', () => {
	it('a YOLO version on a public standard lineage needs the acknowledgement', async () => {
		const owner = await veteran();
		const base = await published(owner);
		const body = { parentVersionId: base.versionId, envelope: envelopeOf(uniqueYoloCurve()) };
		const missing = await rejection(
			appendCurveVersion(env.DB, owner.user.id, base.lineageId, body, ON)
		);
		expect(missing.code).toBe('YOLO_ACK_REQUIRED');
		const off = await rejection(
			appendCurveVersion(env.DB, owner.user.id, base.lineageId, { ...body, acknowledge: 'yolo' })
		);
		expect(off.code).toBe('YOLO_PUBLICATION_OFF');
		const info = await appendCurveVersion(
			env.DB,
			owner.user.id,
			base.lineageId,
			{ ...body, acknowledge: 'yolo' },
			ON
		);
		expect(info.yolo).toBe(true);
		expect(await acks(base.lineageId)).toBe(1);
		expect(await anonymousRead(base.lineageId)).toBe('ok');
	});

	it('a YOLO version on a private lineage needs nothing', async () => {
		const owner = await actor();
		const base = await published(owner, { visibility: 'private' });
		const info = await appendCurveVersion(env.DB, owner.user.id, base.lineageId, {
			parentVersionId: base.versionId,
			envelope: envelopeOf(uniqueYoloCurve())
		});
		expect(info.yolo).toBe(true);
		expect(await acks(base.lineageId)).toBe(0);
	});

	it('a standard version on top of an acknowledged YOLO head needs nothing', async () => {
		const owner = await veteran();
		const yolo = await publishYolo(owner, 'public', { acknowledge: true });
		const info = await appendCurveVersion(env.DB, owner.user.id, yolo.lineageId, {
			parentVersionId: yolo.versionId,
			envelope: envelopeOf(presetCurve(2))
		});
		expect(info.yolo).toBe(false);
	});
});

describe('fork', () => {
	it('forks a public YOLO lineage privately without acknowledgement, publicly only with it', async () => {
		const source = await publishYolo(await veteran(), 'public', { acknowledge: true });
		const forker = await veteran();
		const own = await forkCurve(env.DB, forker.user.id, source.lineageId, {});
		expect(own.yolo).toBe(true);
		expect(await acks(own.lineageId)).toBe(0);

		const missing = await rejection(
			forkCurve(env.DB, forker.user.id, source.lineageId, { visibility: 'public' }, ON)
		);
		expect(missing.code).toBe('YOLO_ACK_REQUIRED');
		const open = await forkCurve(
			env.DB,
			forker.user.id,
			source.lineageId,
			{ visibility: 'public', acknowledge: 'yolo' },
			ON
		);
		expect(open.yolo).toBe(true);
		expect(await acks(open.lineageId)).toBe(1);
		expect(await anonymousRead(open.lineageId)).toBe('ok');
	});
});

describe('visibility and restore', () => {
	it('opening a private YOLO lineage follows the kill switch and the acknowledgement', async () => {
		const owner = await veteran();
		const info = await publishYolo(owner, 'private');
		const off = await rejection(changeVisibility(env.DB, owner.user.id, info.lineageId, 'public'));
		expect(off.code).toBe('YOLO_PUBLICATION_OFF');
		const missing = await rejection(
			changeVisibility(env.DB, owner.user.id, info.lineageId, 'unlisted', ON)
		);
		expect(missing.code).toBe('YOLO_ACK_REQUIRED');
		expect(await anonymousRead(info.lineageId)).toBe('not-found');

		const state = await changeVisibility(
			env.DB,
			owner.user.id,
			info.lineageId,
			'public',
			ON,
			'yolo'
		);
		expect(state.visibility).toBe('public');
		expect(await acks(info.lineageId)).toBe(1);
		expect(await anonymousRead(info.lineageId)).toBe('ok');
		// Closing needs nothing.
		await changeVisibility(env.DB, owner.user.id, info.lineageId, 'private');
	});

	it('a YOLO head opened without its acknowledgement row is not linkable', async () => {
		const owner = await veteran();
		const info = await publishYolo(owner, 'private');
		// Bypasses the service on purpose: the predicates themselves must hide it.
		const opened = await setLineageVisibility(
			env.DB,
			info.lineageId,
			owner.user.id,
			'public',
			Date.now()
		);
		expect(opened.ok).toBe(true);
		expect(await getLineageForViewer(env.DB, info.lineageId, ANONYMOUS_VIEWER)).toBeNull();
		expect(await anonymousRead(info.lineageId)).toBe('not-found');
		expect(
			await getLineageForViewer(env.DB, info.lineageId, { userId: owner.user.id })
		).not.toBeNull();
	});

	it('restoring a non-private YOLO lineage needs the acknowledgement; a private one does not', async () => {
		const owner = await veteran();
		const open = await publishYolo(owner, 'public', { acknowledge: true });
		await retractCurve(env.DB, owner.user.id, open.lineageId);
		const missing = await rejection(restoreCurve(env.DB, owner.user.id, open.lineageId, ON));
		expect(missing.code).toBe('YOLO_ACK_REQUIRED');
		const off = await rejection(restoreCurve(env.DB, owner.user.id, open.lineageId, {}, 'yolo'));
		expect(off.code).toBe('YOLO_PUBLICATION_OFF');
		const restored = await restoreCurve(env.DB, owner.user.id, open.lineageId, ON, 'yolo');
		expect(restored.status).toBe('active');
		expect(await anonymousRead(open.lineageId)).toBe('ok');

		const closed = await publishYolo(owner, 'private');
		await retractCurve(env.DB, owner.user.id, closed.lineageId);
		expect((await restoreCurve(env.DB, owner.user.id, closed.lineageId)).status).toBe('active');
	});
});

describe('library merge', () => {
	it('merges YOLO curves privately (no acknowledgement) and counts their classification twice', async () => {
		const owner = await actor();
		const total = MERGE_GATE_RUNS_MAX / 2 + 1;
		const items = Array.from({ length: total }, (_, i) => ({
			localId: `yolo-${i}`,
			s1: yoloS1(),
			name: `Yolo ${i}`
		}));
		const report = await mergeLocalLibrary(env.DB, owner.user.id, items);
		expect(report.created).toHaveLength(MERGE_GATE_RUNS_MAX / 2);
		expect(report.created.every((entry) => entry.yolo === true)).toBe(true);
		expect(report.rejected).toEqual([{ localId: `yolo-${total - 1}`, code: 'QUOTA_EXCEEDED' }]);
		const first = report.created[0];
		if (!first) throw new Error('nothing merged');
		const lineage = await getLineageForViewer(env.DB, first.lineageId, { userId: owner.user.id });
		expect(lineage?.visibility).toBe('private');
		expect(lineage?.curve.gateYolo).toBe(true);
		expect(await acks(first.lineageId)).toBe(0);
	}, 120_000);
});
