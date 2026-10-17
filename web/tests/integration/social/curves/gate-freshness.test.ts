// FX4.4: the gate cache cannot go stale and still be trusted. By-id reads and actions of the curves
// service re-gate a head whose cached verdict is not current (a head that now fails stops being
// linkable), the re-gate job lists heads of linkable lineages first and skips rows of a newer gate
// implementation, and every publish attempt that reaches the gate (accepted or rejected) counts
// toward a daily quota. Every curve here is unique (shared D1): presets are never made stale.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { gateForWrite } from 'open-auri/safety';
import { ApiError } from '#lib/server/api/index.ts';
import {
	appendCurveVersion,
	DAILY_GATE_ATTEMPT_QUOTA,
	forkCurve,
	loadPublishedCurve,
	publishCurve
} from '#lib/server/social/curves.ts';
import { GATE_IMPL, gateVersion } from '#lib/server/social/gate.ts';
import { listStaleCurvesByPriority } from '#lib/server/social/queries/curves.ts';
import { getCurve } from '#lib/server/social/repo.ts';
import { curveInput, publish, seedUser } from '../repo/helpers.ts';
import {
	acceptAll,
	actor,
	count,
	envelopeOf,
	presetCurve,
	published,
	uniqueRejectedCurve
} from './helpers.ts';

/** A gate version of the legacy format (ordinal 0): stale for this isolate. */
const LEGACY = 'v2:0123456789abcdef';

async function makeStale(curveId: string): Promise<void> {
	const statement = env.DB.prepare('UPDATE curves SET gate_ver = ? WHERE id = ?');
	await statement.bind(LEGACY, curveId).run();
}

function countingGate(inner: typeof gateForWrite): {
	gate: typeof gateForWrite;
	calls: () => number;
} {
	let calls = 0;
	const gate: typeof gateForWrite = (bands, preampDb, options) => {
		calls++;
		return inner(bands, preampDb, options);
	};
	return { gate, calls: () => calls };
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ApiError) return error;
		throw error;
	}
	throw new Error('expected an ApiError');
}

/** A public lineage whose head the real gate refuses but which was cached as accepted. */
async function wronglyAccepted(): Promise<{
	owner: Awaited<ReturnType<typeof actor>>;
	lineageId: string;
	curveId: string;
}> {
	const owner = await actor();
	const info = await published(owner, {
		envelope: envelopeOf(uniqueRejectedCurve()),
		gate: acceptAll
	});
	return { owner, lineageId: info.lineageId, curveId: info.curveId };
}

describe('lazy re-gate on by-id reads and actions', () => {
	it('a stale head that now fails is re-gated on read and stops being linkable', async () => {
		const { owner, lineageId, curveId } = await wronglyAccepted();
		// Under the current gate version the cached (wrong) verdict is trusted as is.
		expect((await loadPublishedCurve(env.DB, lineageId, { userId: null })).kind).toBe('ok');

		await makeStale(curveId);
		expect((await loadPublishedCurve(env.DB, lineageId, { userId: null })).kind).toBe('not-found');
		const row = await getCurve(env.DB, curveId);
		expect(row?.gateVer).toBe(await gateVersion());
		expect(row?.gateOk).toBe(false);

		// The owner still reads it, with the new verdict.
		const own = await loadPublishedCurve(env.DB, lineageId, { userId: owner.user.id });
		expect(own.kind).toBe('ok');
		if (own.kind === 'ok') expect(own.value.curve.gate.ok).toBe(false);
	});

	it('re-gates a stale head once and serves the current verdict afterwards', async () => {
		const { lineageId, curveId } = await wronglyAccepted();
		await makeStale(curveId);
		const spy = countingGate(acceptAll);
		const viewer = { userId: null };
		const first = await loadPublishedCurve(env.DB, lineageId, viewer, null, { gate: spy.gate });
		expect(first.kind).toBe('ok');
		expect(spy.calls()).toBe(1);
		if (first.kind === 'ok') expect(first.value.curve.gate.version).toBe(await gateVersion());
		await loadPublishedCurve(env.DB, lineageId, viewer, null, { gate: spy.gate });
		expect(spy.calls()).toBe(1);
	});

	it('fork of a stale head that now fails is 404 for another user', async () => {
		const { lineageId, curveId } = await wronglyAccepted();
		await makeStale(curveId);
		const forker = await actor();
		const error = await failure(forkCurve(env.DB, forker.user.id, lineageId, {}));
		expect([error.status, error.code]).toEqual([404, 'NOT_FOUND']);
		expect((await getCurve(env.DB, curveId))?.gateOk).toBe(false);
	});

	it('an owner action (append) re-gates the stale head before answering', async () => {
		const { owner, lineageId, curveId } = await wronglyAccepted();
		const head = await loadPublishedCurve(env.DB, lineageId, { userId: owner.user.id });
		if (head.kind !== 'ok') throw new Error('expected the owner to read the lineage');
		await makeStale(curveId);
		const next = await appendCurveVersion(env.DB, owner.user.id, lineageId, {
			parentVersionId: head.value.version.id,
			envelope: envelopeOf(presetCurve(2))
		});
		expect(next.lineageId).toBe(lineageId);
		const row = await getCurve(env.DB, curveId);
		expect(row?.gateVer).toBe(await gateVersion());
		expect(row?.gateOk).toBe(false);
	});
});

describe('re-gate job listing', () => {
	it('lists heads of linkable lineages first and skips rows of a newer implementation', async () => {
		const owner = await seedUser({});
		// Among the oldest rows of the table (created_at 1): a stale head of a private lineage, a
		// stale linkable head and a linkable head cached by a newer gate implementation.
		const loose = curveInput({ gateVer: LEGACY });
		const looseSaved = await publish(owner.id, { visibility: 'private', now: 1, curve: loose });
		const head = await publish(owner.id, { now: 1, curve: curveInput({ gateVer: LEGACY }) });
		const newerVer = `v2.${GATE_IMPL + 1}:ffffffffffffffff`;
		const newer = await publish(owner.id, { now: 1, curve: curveInput({ gateVer: newerVer }) });
		expect(looseSaved.curve.id).toBe(loose.id);

		const version = await gateVersion();
		const ids = (await listStaleCurvesByPriority(env.DB, version, 1000, GATE_IMPL)).map(
			(curve) => curve.id
		);
		expect(ids).toContain(head.curve.id);
		expect(ids).not.toContain(newer.curve.id);
		const looseAt = ids.indexOf(loose.id);
		// The private lineage's head is not linkable: listed after every linkable head.
		expect(looseAt === -1 || looseAt > ids.indexOf(head.curve.id)).toBe(true);

		// A newer isolate (greater ordinal) does pick the row as stale.
		const later = await listStaleCurvesByPriority(env.DB, 'v2.999999:x', 1000, GATE_IMPL + 1);
		expect(later.map((curve) => curve.id)).toContain(newer.curve.id);
	});
});

describe('gate attempt quota', () => {
	it(`rejected attempts count: attempt ${DAILY_GATE_ATTEMPT_QUOTA + 1} is 429`, async () => {
		const owner = await actor();
		const now = Date.now();
		const rejected = envelopeOf(uniqueRejectedCurve());
		for (let i = 0; i < DAILY_GATE_ATTEMPT_QUOTA; i++) {
			const error = await failure(
				publishCurve(env.DB, owner.user.id, { envelope: rejected, visibility: 'public' }, { now })
			);
			expect(error.code).toBe('GATE_REJECTED');
		}
		const error = await failure(
			publishCurve(
				env.DB,
				owner.user.id,
				{ envelope: envelopeOf(presetCurve(0)), visibility: 'public' },
				{ now }
			)
		);
		expect([error.status, error.code]).toEqual([429, 'QUOTA_EXCEEDED']);
		const lineages = await count(
			'SELECT count(*) AS n FROM lineages WHERE owner_user_id = ?',
			owner.user.id
		);
		expect(lineages).toBe(0);
	});

	it('an invalid envelope never reaches the gate and is not counted', async () => {
		const owner = await actor();
		const now = Date.now();
		for (let i = 0; i < DAILY_GATE_ATTEMPT_QUOTA + 1; i++) {
			const error = await failure(
				publishCurve(
					env.DB,
					owner.user.id,
					{ envelope: { format: 'nope' }, visibility: 'public' },
					{ now }
				)
			);
			expect(error.code).toBe('INVALID_CURVE');
		}
		const info = await publishCurve(
			env.DB,
			owner.user.id,
			{ envelope: envelopeOf(presetCurve(0)), visibility: 'public' },
			{ now }
		);
		expect(info.lineageId).toBeTruthy();
	});
});
