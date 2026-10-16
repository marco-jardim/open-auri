// Database-level guarantees of 0004 (T4.1): the gate trigger (invariant §0.12.4, including the
// fork and new-version paths), append-only linear history, immutable curve identity, head and
// ownership rules, CHECK limits, and the repository's mapping of those failures.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	appendVersion,
	constraintCode,
	forkLineage,
	getCurve,
	getLineageForViewer,
	listVersions,
	publishLineage,
	saveCurveGate
} from '#lib/server/social/repo.ts';
import { count, curveInput, failure, publish, seedUser, sid, versionInput } from './helpers.ts';

describe('gate trigger', () => {
	it('refuses a raw version insert on a curve rejected by the gate', async () => {
		const owner = await seedUser();
		const rejected = curveInput({ gateOk: false, gateReasons: ['GAIN_LIMIT'] });
		expect((await saveCurveGate(env.DB, rejected, Date.now())).ok).toBe(true);
		const lineageId = sid('lin');
		await env.DB.prepare(
			"INSERT INTO lineages (id, owner_user_id, visibility, created_at, updated_at) VALUES (?, ?, 'public', 1, 1)"
		)
			.bind(lineageId, owner.id)
			.run();
		const message = await failure(
			env.DB.prepare(
				"INSERT INTO versions (id, lineage_id, curve_id, name, license, lang, created_at) VALUES (?, ?, ?, 'x', 'CC0-1.0', 'pt-BR', 1)"
			)
				.bind(sid('ver'), lineageId, rejected.id)
				.run()
		);
		expect(message).toContain('gate_rejected');
		expect(constraintCode(new Error(message))).toBe('gate-rejected');
		// A missing curve is refused the same way.
		const missing = await failure(
			env.DB.prepare(
				"INSERT INTO versions (id, lineage_id, curve_id, name, license, lang, created_at) VALUES (?, ?, 'aaaaaaaaaaaa', 'x', 'CC0-1.0', 'pt-BR', 1)"
			)
				.bind(sid('ver'), lineageId)
				.run()
		);
		expect(missing).toContain('gate_rejected');
	});

	it('publication refuses a rejected curve, caches it, and writes no lineage', async () => {
		const owner = await seedUser();
		const curve = curveInput({ gateOk: false, gateReasons: ['Q_LIMIT'] });
		const lineageId = sid('lin');
		const result = await publishLineage(env.DB, {
			lineageId,
			ownerUserId: owner.id,
			visibility: 'public',
			curve,
			version: versionInput(),
			now: Date.now()
		});
		expect(result).toEqual({ ok: false, code: 'gate-rejected' });
		expect(await count('SELECT count(*) AS n FROM lineages WHERE id = ?', lineageId)).toBe(0);
		expect(await getCurve(env.DB, curve.id)).toMatchObject({
			gateOk: false,
			gateReasons: ['Q_LIMIT']
		});
	});

	it('a curve cached as rejected cannot be smuggled in with the same gate version', async () => {
		const owner = await seedUser();
		const curve = curveInput({ gateOk: false });
		await saveCurveGate(env.DB, curve, Date.now());
		const lineageId = sid('lin');
		const result = await publishLineage(env.DB, {
			lineageId,
			ownerUserId: owner.id,
			visibility: 'public',
			curve: { ...curve, gateOk: true },
			version: versionInput(),
			now: Date.now()
		});
		expect(result).toEqual({ ok: false, code: 'gate-rejected' });
		expect(await count('SELECT count(*) AS n FROM lineages WHERE id = ?', lineageId)).toBe(0);
	});

	it('new versions and forks go through the same gate', async () => {
		const owner = await seedUser();
		const forker = await seedUser();
		const source = await publish(owner.id);
		const rejected = curveInput({ gateOk: false });
		expect(
			await appendVersion(env.DB, {
				lineageId: source.lineageId,
				ownerUserId: owner.id,
				expectedHead: source.versionId,
				curve: rejected,
				version: versionInput(),
				now: Date.now()
			})
		).toEqual({ ok: false, code: 'gate-rejected' });
		const forkId = sid('lin');
		expect(
			await forkLineage(env.DB, source.versionId, {
				lineageId: forkId,
				ownerUserId: forker.id,
				visibility: 'public',
				curve: rejected,
				version: versionInput(),
				now: Date.now()
			})
		).toEqual({ ok: false, code: 'gate-rejected' });
		expect(await count('SELECT count(*) AS n FROM lineages WHERE id = ?', forkId)).toBe(0);
	});
});

describe('append-only, linear history', () => {
	it('versions cannot be updated; curve identity cannot change, its gate cache can', async () => {
		const owner = await seedUser();
		const published = await publish(owner.id);
		const update = await failure(
			env.DB.prepare("UPDATE versions SET name = 'renamed' WHERE id = ?")
				.bind(published.versionId)
				.run()
		);
		expect(update).toContain('versions_append_only');
		const s1 = await failure(
			env.DB.prepare('UPDATE curves SET s1 = ? WHERE id = ?')
				.bind('x'.repeat(68), published.curve.id)
				.run()
		);
		expect(s1).toContain('curve_immutable');
		const regated = await saveCurveGate(
			env.DB,
			{ ...published.curve, gateVer: 'v2:newer', gateOk: true, gateReasons: [] },
			Date.now()
		);
		expect(regated).toMatchObject({ ok: true, value: { gateVer: 'v2:newer' } });
	});

	it('appends on the head; a stale head is refused with head-moved', async () => {
		const owner = await seedUser();
		const published = await publish(owner.id);
		const second = versionInput();
		const appended = await appendVersion(env.DB, {
			lineageId: published.lineageId,
			ownerUserId: owner.id,
			expectedHead: published.versionId,
			curve: curveInput(),
			version: second,
			now: Date.now()
		});
		expect(appended).toEqual({ ok: true, value: { versionId: second.id } });
		const stale = await appendVersion(env.DB, {
			lineageId: published.lineageId,
			ownerUserId: owner.id,
			expectedHead: published.versionId,
			curve: curveInput(),
			version: versionInput(),
			now: Date.now()
		});
		expect(stale).toEqual({ ok: false, code: 'head-moved' });
		const history = await listVersions(env.DB, published.lineageId, { userId: owner.id });
		expect(history?.items.map((version) => version.id)).toEqual([second.id, published.versionId]);
		expect(history?.items[0]?.parentId).toBe(published.versionId);
		const lineage = await getLineageForViewer(env.DB, published.lineageId, { userId: null });
		expect(lineage?.headVersion).toBe(second.id);
	});

	it('two concurrent appends on the same head: exactly one wins', async () => {
		const owner = await seedUser();
		const published = await publish(owner.id);
		const attempt = () =>
			appendVersion(env.DB, {
				lineageId: published.lineageId,
				ownerUserId: owner.id,
				expectedHead: published.versionId,
				curve: curveInput(),
				version: versionInput(),
				now: Date.now()
			});
		const results = await Promise.all([attempt(), attempt(), attempt()]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toEqual([
			{ ok: false, code: 'head-moved' },
			{ ok: false, code: 'head-moved' }
		]);
		expect(
			await count('SELECT count(*) AS n FROM versions WHERE lineage_id = ?', published.lineageId)
		).toBe(2);
	});

	it('only the owner of an active lineage appends', async () => {
		const owner = await seedUser();
		const intruder = await seedUser();
		const published = await publish(owner.id);
		const input = {
			lineageId: published.lineageId,
			expectedHead: published.versionId,
			curve: curveInput(),
			now: Date.now()
		};
		expect(
			await appendVersion(env.DB, { ...input, ownerUserId: intruder.id, version: versionInput() })
		).toEqual({ ok: false, code: 'not-found' });
		await env.DB.prepare("UPDATE lineages SET status = 'retracted' WHERE id = ?")
			.bind(published.lineageId)
			.run();
		expect(
			await appendVersion(env.DB, { ...input, ownerUserId: owner.id, version: versionInput() })
		).toEqual({ ok: false, code: 'retracted' });
	});

	it('database rules: one root, parent in the same lineage, head only advances, no transfer', async () => {
		const owner = await seedUser();
		const other = await seedUser();
		const a = await publish(owner.id);
		const b = await publish(owner.id);
		const curve = curveInput();
		await saveCurveGate(env.DB, curve, Date.now());
		const insert = (lineageId: string, parentId: string | null) =>
			env.DB.prepare(
				"INSERT INTO versions (id, lineage_id, parent_id, curve_id, name, license, lang, created_at) VALUES (?, ?, ?, ?, 'x', 'CC0-1.0', 'pt-BR', 1)"
			)
				.bind(sid('ver'), lineageId, parentId, curve.id)
				.run();
		expect(await failure(insert(a.lineageId, null))).toContain('UNIQUE');
		expect(await failure(insert(a.lineageId, b.versionId))).toContain('parent_lineage');

		const second = versionInput();
		await appendVersion(env.DB, {
			lineageId: a.lineageId,
			ownerUserId: owner.id,
			expectedHead: a.versionId,
			curve: curveInput(),
			version: second,
			now: Date.now()
		});
		const back = await failure(
			env.DB.prepare('UPDATE lineages SET head_version = ? WHERE id = ?')
				.bind(a.versionId, a.lineageId)
				.run()
		);
		expect(back).toContain('head_not_child');
		const transfer = await failure(
			env.DB.prepare('UPDATE lineages SET owner_user_id = ? WHERE id = ?')
				.bind(other.id, a.lineageId)
				.run()
		);
		expect(transfer).toContain('owner_transfer');
		const headOnInsert = await failure(
			env.DB.prepare(
				"INSERT INTO lineages (id, owner_user_id, head_version, visibility, created_at, updated_at) VALUES (?, ?, ?, 'public', 1, 1)"
			)
				.bind(sid('lin'), owner.id, a.versionId)
				.run()
		);
		expect(headOnInsert).toContain('head_on_insert');
	});
});

describe('CHECK limits and input validation', () => {
	it('names, descriptions and notes are bounded in the database and in the repository', async () => {
		const owner = await seedUser();
		const curve = curveInput();
		const long = await publishLineage(env.DB, {
			lineageId: sid('lin'),
			ownerUserId: owner.id,
			visibility: 'public',
			curve,
			version: versionInput({ name: 'n'.repeat(81) }),
			now: Date.now()
		});
		expect(long).toEqual({ ok: false, code: 'invalid-input' });
		const published = await publish(owner.id);
		const description = await failure(
			env.DB.prepare(
				"INSERT INTO versions (id, lineage_id, parent_id, curve_id, name, description, license, lang, created_at) VALUES (?, ?, ?, ?, 'x', ?, 'CC0-1.0', 'pt-BR', 1)"
			)
				.bind(
					sid('ver'),
					published.lineageId,
					published.versionId,
					published.curve.id,
					'd'.repeat(1001)
				)
				.run()
		);
		expect(description).toContain('CHECK');
		const note = await failure(
			env.DB.prepare(
				"INSERT INTO reports (id, target_kind, target_id, reason, note, reporter_user_id, created_at) VALUES (?, 'lineage', ?, 'spam', ?, ?, 1)"
			)
				.bind(sid('rep'), published.lineageId, 'n'.repeat(501), owner.id)
				.run()
		);
		expect(note).toContain('CHECK');
		const badCurve = await saveCurveGate(env.DB, { ...curveInput(), id: 'NOT-BASE32!!' }, 1);
		expect(badCurve).toEqual({ ok: false, code: 'invalid-input' });
		expect(constraintCode(new Error('something else'))).toBeNull();
		expect(constraintCode(new Error('UNIQUE constraint failed: trades.user_id'))).toBe(
			'already-active'
		);
		expect(constraintCode(new Error('FOREIGN KEY constraint failed'))).toBe('not-found');
	});

	it('a fork of an unknown or unreadable version is not-found', async () => {
		const owner = await seedUser();
		const forker = await seedUser();
		const hidden = await publish(owner.id, { visibility: 'private' });
		const input = {
			lineageId: sid('lin'),
			ownerUserId: forker.id,
			visibility: 'public' as const,
			curve: curveInput(),
			version: versionInput(),
			now: Date.now()
		};
		expect(await forkLineage(env.DB, hidden.versionId, input)).toEqual({
			ok: false,
			code: 'not-found'
		});
		expect(await forkLineage(env.DB, sid('ver'), input)).toEqual({ ok: false, code: 'not-found' });
		const visible = await publish(owner.id);
		const fork = await forkLineage(env.DB, visible.versionId, input);
		expect(fork.ok).toBe(true);
		expect(
			(await getLineageForViewer(env.DB, input.lineageId, { userId: null }))?.forkedFromVersion
		).toBe(visible.versionId);
	});
});
