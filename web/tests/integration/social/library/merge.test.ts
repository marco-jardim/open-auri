// Merge of the browser library (T4.3): POST /api/v1/me/library/merge through the real route and
// mergeLocalLibrary directly. Dedupe by curve id and canonKey (account and batch), conflicts on a
// different name, gate/S1/text rejections (nothing created), idempotency, batch limit, daily quota
// and authz. Accepted curves are the official presets (real gate, cached per curve).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { gateForWrite } from 'open-auri/safety';
import { canonKey, decodeS1 } from 'open-auri/share';
import {
	MERGE_BATCH_MAX,
	MERGE_DAILY_MAX,
	MERGE_GATE_RUNS_MAX,
	MERGE_GATED_DAILY_MAX,
	mergeLocalLibrary,
	type MergeItem,
	type MergeReport
} from '#lib/server/social/library.ts';
import { POST } from '../../../../src/routes/api/v1/me/library/merge/+server.ts';
import {
	bodyOf,
	count,
	curveInput,
	errorCode,
	member,
	presetS1,
	publish,
	rejectedS1,
	routeEvent,
	sid,
	SIGNED_OUT,
	type Member
} from './helpers.ts';

function merge(who: Member | null, body: unknown) {
	return POST(
		routeEvent({
			method: 'POST',
			path: '/api/v1/me/library/merge',
			locals: who ? who.locals : SIGNED_OUT,
			body
		})
	);
}

async function report(who: Member, items: MergeItem[]): Promise<MergeReport> {
	const response = await merge(who, { items });
	expect(response.status).toBe(200);
	return bodyOf<MergeReport>(response);
}

function ownLineages(userId: string): Promise<number> {
	return count('SELECT count(*) AS n FROM lineages WHERE owner_user_id = ?', userId);
}

function item(localId: string, s1: string, name = 'Local curve'): MergeItem {
	return { localId, s1, name };
}

describe('POST /api/v1/me/library/merge', () => {
	it('creates private lineages, then is idempotent', async () => {
		const me = await member();
		const items = [
			item('a', presetS1(0), 'Bright'),
			{
				...item('b', presetS1(1), 'Dark'),
				description: 'Line one\nLine two',
				lang: 'en-US' as const
			}
		];
		const first = await report(me, items);
		expect(first.created.map((entry) => entry.localId)).toEqual(['a', 'b']);
		expect(first.duplicates).toEqual([]);
		expect(first.rejected).toEqual([]);
		expect(first.conflicts).toEqual([]);
		for (const { lineageId } of first.created) {
			const row = await env.DB.prepare(
				'SELECT l.visibility AS visibility, v.name AS name, v.license AS license ' +
					'FROM lineages l JOIN versions v ON v.id = l.head_version WHERE l.id = ? AND l.owner_user_id = ?'
			)
				.bind(lineageId, me.user.id)
				.first<{ visibility: string; name: string; license: string }>();
			expect(row?.visibility).toBe('private');
			expect(row?.license).toBe('CC-BY-4.0');
		}
		expect(await ownLineages(me.user.id)).toBe(2);

		const second = await report(me, items);
		expect(second.created).toEqual([]);
		expect(second.duplicates).toEqual(
			first.created.map(({ localId, lineageId }) => ({ localId, lineageId }))
		);
		expect(await ownLineages(me.user.id)).toBe(2);
	});

	it('dedupes inside the batch: same name is a duplicate, another name a conflict', async () => {
		const me = await member();
		const result = await report(me, [
			item('one', presetS1(2), 'Same'),
			item('two', presetS1(2), 'Same'),
			item('three', presetS1(2), 'Different')
		]);
		expect(result.created).toHaveLength(1);
		const lineageId = result.created[0]?.lineageId ?? '';
		expect(result.duplicates).toEqual([{ localId: 'two', lineageId }]);
		expect(result.conflicts).toEqual([{ localId: 'three', lineageId, field: 'name' }]);
		expect(await ownLineages(me.user.id)).toBe(1);
	});

	it("dedupes by canonKey against the account's own lineages", async () => {
		const me = await member();
		const s1 = presetS1(3);
		const decoded = decodeS1(s1);
		// An own lineage whose curve has another id but the same canonical key (name 'Warm vocal').
		const own = await publish(me.user.id, {
			visibility: 'public',
			curve: curveInput({ canonKey: canonKey(decoded.bands, decoded.preampDb) })
		});
		const result = await report(me, [item('x', s1, 'Warm vocal'), item('y', s1, 'Renamed')]);
		expect(result.created).toEqual([]);
		expect(result.duplicates).toEqual([{ localId: 'x', lineageId: own.lineageId }]);
		expect(result.conflicts).toEqual([{ localId: 'y', lineageId: own.lineageId, field: 'name' }]);
	});

	it("another user's lineage of the same curve is not a duplicate", async () => {
		const other = await member();
		const me = await member();
		await report(other, [item('o', presetS1(4))]);
		const result = await report(me, [item('m', presetS1(4))]);
		expect(result.created).toHaveLength(1);
	});

	it('reports gate, S1 and text rejections and creates nothing for them', async () => {
		const me = await member();
		const refused = rejectedS1();
		const result = await report(me, [
			item('gate', refused),
			item('gate-again', refused),
			item('s1', 'S1-not-a-curve'),
			item('url', presetS1(5), 'see https://example.com'),
			item('blank', presetS1(5), '   ')
		]);
		expect(result.created).toEqual([]);
		expect(result.rejected.map((entry) => [entry.localId, entry.code])).toEqual([
			['gate', 'GATE_REJECTED'],
			['gate-again', 'GATE_REJECTED'],
			['s1', 'INVALID_CURVE'],
			['url', 'INVALID_TEXT'],
			['blank', 'INVALID_TEXT']
		]);
		expect(result.rejected[0]?.reasons).toContain('k:kind-not-allowed');
		expect(result.rejected[2]?.reasons?.length).toBeGreaterThan(0);
		expect(await ownLineages(me.user.id)).toBe(0);
	});

	it('400 for an empty batch, more than the limit or repeated localIds', async () => {
		const me = await member();
		const tooMany = Array.from({ length: MERGE_BATCH_MAX + 1 }, (_, i) =>
			item(`i${i}`, presetS1(i))
		);
		for (const items of [[], tooMany, [item('d', presetS1(0)), item('d', presetS1(1))]]) {
			const response = await merge(me, { items });
			expect(response.status).toBe(400);
			expect(await errorCode(response)).toBe('INVALID_BODY');
		}
		await expect(mergeLocalLibrary(env.DB, me.user.id, tooMany)).rejects.toThrow(RangeError);
		expect(await ownLineages(me.user.id)).toBe(0);
	});

	it('authz: 401 signed out, 403 unverified, 403 foreign origin', async () => {
		const body = { items: [item('a', presetS1(0))] };
		const anonymous = await merge(null, body);
		expect(anonymous.status).toBe(401);
		expect(await errorCode(anonymous)).toBe('AUTH_REQUIRED');
		const unverified = await member({ verified: false });
		const refused = await merge(unverified, body);
		expect(refused.status).toBe(403);
		expect(await errorCode(refused)).toBe('EMAIL_NOT_VERIFIED');
		const me = await member();
		const foreign = await POST(
			routeEvent({
				method: 'POST',
				path: '/api/v1/me/library/merge',
				locals: me.locals,
				body,
				headers: { origin: 'https://evil.example' }
			})
		);
		expect(foreign.status).toBe(403);
		expect(await ownLineages(me.user.id)).toBe(0);
	});

	it('stops creating once the daily quota is spent (items stay local)', async () => {
		const me = await member();
		const now = Date.now();
		await env.DB.prepare(
			'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) ' +
				'INSERT INTO lineages (id, owner_user_id, forked_from_version, head_version, visibility, ' +
				"status, moderation, curated, created_at, updated_at) SELECT ? || '-' || i, ?, NULL, NULL, " +
				"'private', 'active', 'visible', 0, ?, ? FROM n"
		)
			.bind(MERGE_DAILY_MAX, sid('quota'), me.user.id, now - 1000, now - 1000)
			.run();
		const result = await mergeLocalLibrary(env.DB, me.user.id, [item('q', presetS1(6))], { now });
		expect(result.created).toEqual([]);
		expect(result.rejected).toEqual([{ localId: 'q', code: 'QUOTA_EXCEEDED' }]);

		// A day later the quota is back.
		const later = await mergeLocalLibrary(env.DB, me.user.id, [item('q', presetS1(6))], {
			now: now + 24 * 60 * 60 * 1000
		});
		expect(later.created).toHaveLength(1);
	});

	it('FX4.6: caps uncached gate runs per request; the rest is QUOTA_EXCEEDED to retry', async () => {
		const me = await member();
		const unique = new Set<string>();
		while (unique.size < MERGE_GATE_RUNS_MAX + 5) unique.add(rejectedS1());
		const items = [...unique].map((s1, i) => item(`g${i}`, s1));
		let runs = 0;
		const gate: typeof gateForWrite = (bands, preampDb) => {
			runs++;
			return gateForWrite(bands, preampDb);
		};
		const first = await mergeLocalLibrary(env.DB, me.user.id, items, { deps: { gate } });
		expect(runs).toBe(MERGE_GATE_RUNS_MAX);
		const codes = first.rejected.map((entry) => entry.code);
		expect(codes.filter((code) => code === 'GATE_REJECTED')).toHaveLength(MERGE_GATE_RUNS_MAX);
		expect(codes.filter((code) => code === 'QUOTA_EXCEEDED')).toHaveLength(5);

		// The retry finds the first verdicts cached and gates the rest.
		runs = 0;
		const retry = await mergeLocalLibrary(env.DB, me.user.id, items, { deps: { gate } });
		expect(runs).toBe(5);
		expect(retry.rejected.every((entry) => entry.code === 'GATE_REJECTED')).toBe(true);
		expect(await ownLineages(me.user.id)).toBe(0);
	});

	it('FX4.6: every gated item uses the daily quota, rejected ones included', async () => {
		const me = await member();
		const window = 86_400;
		const start = Math.floor(Date.now() / 1000 / window) * window;
		await env.DB.prepare(
			'INSERT INTO rate_limit_counters (key, window_start, count, expires_at) VALUES (?, ?, ?, ?)'
		)
			.bind(
				`u:library.merge.gated:${me.user.id}:${window}`,
				start,
				MERGE_GATED_DAILY_MAX - 1,
				start + 2 * window
			)
			.run();
		const result = await mergeLocalLibrary(env.DB, me.user.id, [
			item('r', rejectedS1()),
			item('a', presetS1(7)),
			item('b', presetS1(8))
		]);
		expect(result.rejected.map((entry) => [entry.localId, entry.code])).toEqual([
			['r', 'GATE_REJECTED'],
			['a', 'QUOTA_EXCEEDED'],
			['b', 'QUOTA_EXCEEDED']
		]);
		expect(result.created).toEqual([]);
		expect(await ownLineages(me.user.id)).toBe(0);
	});
});
