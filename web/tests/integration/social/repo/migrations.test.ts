// Migrations 0004-0006 (T4.1): on the fresh test database they ran before 0007-0010 (setup file);
// on a second, empty D1 they are applied AFTER 0001-0003 and 0007-0010 (an already migrated
// production database) and the repository and the deletion part work the same. Migration 0013
// (YOLO): on the fresh database (columns, table, trigger, CHECK) and on that second database,
// applied over rows written up to 0012.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { createContentDeletionPolicy } from '#lib/server/account/deletion.ts';
import { batch } from '#lib/server/db.ts';
import { getLineageForViewer, listPublicFeed, publishLineage } from '#lib/server/social/repo.ts';
import { curveInput, sid, versionInput } from './helpers.ts';

// `env.DB` and `env.SOCIAL_ORDER_DB` are D1 bindings of the integration config.

const SOCIAL_TABLES = [
	'curves',
	'lineages',
	'versions',
	'favorites',
	'activity',
	'shares',
	'share_events',
	'share_event_users',
	'packs',
	'pack_items',
	'reports',
	's6_batches',
	's6_pairs',
	'trades',
	'rankings',
	'ranking_state',
	'lineage_yolo_acks'
];

const SOCIAL_TRIGGERS = [
	'curves_identity_immutable',
	'versions_gate_ok',
	'versions_parent_same_lineage',
	'versions_append_only',
	'lineages_head_null_on_insert',
	'lineages_head_advances',
	'lineages_owner_fixed',
	'packs_owner_fixed'
];

async function names(db: D1Database, type: 'table' | 'trigger' | 'index'): Promise<string[]> {
	const rows = await db
		.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
		.bind(type)
		.all<{ name: string }>();
	return rows.results.map((row) => row.name);
}

function isSocial(name: string): boolean {
	return /^000[4-6]_/.test(name);
}

/** Ordinal of a migration file name (`0013_yolo.sql` → 13). */
function ordinal(name: string): number {
	return Number(name.slice(0, 4));
}

async function columns(db: D1Database, table: string): Promise<string[]> {
	const rows = await db
		.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
		.bind(table)
		.all<{ name: string }>();
	return rows.results.map((row) => row.name);
}

/** A curve row written by raw SQL (no gate_yolo column needed: works before and after 0013). */
async function rawCurve(db: D1Database, gate: { ok: 0 | 1; yolo?: 0 | 1 }): Promise<string> {
	const curve = curveInput();
	const yolo = gate.yolo === undefined ? '' : ', gate_yolo';
	const mark = gate.yolo === undefined ? '' : ', ?';
	await db
		.prepare(
			`INSERT INTO curves (id, s1, canon_key, gate_ver, gate_ok${yolo}, gate_reasons, level_db, ` +
				`created_at) VALUES (?, ?, ?, ?, ?${mark}, '[]', NULL, ?)`
		)
		.bind(
			...[curve.id, curve.s1, curve.canonKey, curve.gateVer, gate.ok],
			...(gate.yolo === undefined ? [] : [gate.yolo]),
			Date.now()
		)
		.run();
	return curve.id;
}

/** A lineage without owner and a root version on `curveId`, by raw SQL; throws what D1 throws. */
async function rawVersion(db: D1Database, curveId: string): Promise<string> {
	const lineageId = sid('lin');
	const versionId = sid('ver');
	const now = Date.now();
	await db
		.prepare(
			'INSERT INTO lineages (id, owner_user_id, forked_from_version, head_version, visibility, ' +
				"status, moderation, curated, created_at, updated_at) VALUES (?, NULL, NULL, NULL, 'private', " +
				"'active', 'visible', 0, ?, ?)"
		)
		.bind(lineageId, now, now)
		.run();
	await db
		.prepare(
			'INSERT INTO versions (id, lineage_id, parent_id, curve_id, name, description, license, ' +
				"recipe, lang, created_at) VALUES (?, ?, NULL, ?, 'Raw', '', 'CC0-1.0', NULL, 'pt-BR', ?)"
		)
		.bind(versionId, lineageId, curveId, now)
		.run();
	return versionId;
}

async function error(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (thrown) {
		return thrown instanceof Error ? thrown.message : String(thrown);
	}
	return '';
}

/** Position of the migration whose name starts with `prefix` (e.g. '0004_'). */
function position(order: string[], prefix: string): number {
	const index = order.findIndex((name) => name.startsWith(prefix));
	expect(index, prefix).toBeGreaterThanOrEqual(0);
	return index;
}

function userTables(tables: string[]): string[] {
	return tables.filter((name) => !name.startsWith('_cf_') && !name.startsWith('sqlite_'));
}

describe('fresh database (setup order: 0004-0006 before 0007-0010)', () => {
	it('has every social table, trigger and the indexes the repository relies on', async () => {
		const tables = await names(env.DB, 'table');
		for (const table of SOCIAL_TABLES) expect(tables, table).toContain(table);
		const triggers = await names(env.DB, 'trigger');
		for (const trigger of SOCIAL_TRIGGERS) expect(triggers, trigger).toContain(trigger);
		const indexes = await names(env.DB, 'index');
		for (const index of [
			'curves_canon_key',
			'lineages_owner',
			'lineages_public_feed',
			'versions_single_root',
			'favorites_lineage',
			'activity_lineage',
			'shares_owner',
			'reports_target',
			'trades_one_active_per_user',
			'trades_pairing',
			'rankings_rank'
		]) {
			expect(indexes, index).toContain(index);
		}
		const applied = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{
			name: string;
		}>();
		const order = applied.results.map((row) => row.name);
		expect(position(order, '0004_')).toBeLessThan(position(order, '0009_'));
		expect(position(order, '0006_')).toBeLessThan(position(order, '0010_'));
	});

	it('S6 batches hold no user, IP or time finer than the day', async () => {
		const columns = await env.DB.prepare("SELECT name FROM pragma_table_info('s6_batches')").all<{
			name: string;
		}>();
		expect(columns.results.map((row) => row.name).sort()).toEqual(
			['consent_ver', 'day', 'id', 'receipt_hash'].sort()
		);
	});
});

describe('0013 YOLO on the fresh database', () => {
	it('adds curves.gate_yolo, the acknowledgement table and the new versions trigger', async () => {
		expect(await columns(env.DB, 'curves')).toContain('gate_yolo');
		expect(await columns(env.DB, 'lineage_yolo_acks')).toEqual([
			'lineage_id',
			'curve_id',
			'acked_at'
		]);
		expect(await names(env.DB, 'trigger')).toContain('versions_gate_ok');
		const applied = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{
			name: string;
		}>();
		expect(applied.results.map((row) => row.name)).toContain('0013_yolo.sql');
	});

	it('the CHECK refuses a curve that is both standard and YOLO', async () => {
		expect(await error(rawCurve(env.DB, { ok: 1, yolo: 1 }))).toContain('CHECK constraint failed');
		const standard = await rawCurve(env.DB, { ok: 1 });
		const row = await env.DB.prepare('SELECT gate_yolo FROM curves WHERE id = ?')
			.bind(standard)
			.first<{ gate_yolo: number }>();
		expect(row?.gate_yolo).toBe(0);
		expect(
			await error(
				env.DB.prepare('UPDATE curves SET gate_yolo = 1 WHERE id = ?').bind(standard).run()
			)
		).toContain('CHECK constraint failed');
	});

	it('the trigger accepts standard and YOLO curves and refuses rejected or missing ones', async () => {
		const standard = await rawCurve(env.DB, { ok: 1, yolo: 0 });
		const yolo = await rawCurve(env.DB, { ok: 0, yolo: 1 });
		const rejected = await rawCurve(env.DB, { ok: 0, yolo: 0 });
		expect(await rawVersion(env.DB, standard)).toMatch(/^ver-/);
		expect(await rawVersion(env.DB, yolo)).toMatch(/^ver-/);
		const refused = await error(rawVersion(env.DB, rejected));
		expect(refused).toContain('gate_rejected: the curve passes neither the standard nor the YOLO');
		expect(await error(rawVersion(env.DB, 'zzzzzzzzzzzz'))).toContain('gate_rejected');
	});

	it('acknowledgements reference a lineage and a curve and go with the lineage', async () => {
		const yolo = await rawCurve(env.DB, { ok: 0, yolo: 1 });
		const versionId = await rawVersion(env.DB, yolo);
		const version = await env.DB.prepare('SELECT lineage_id FROM versions WHERE id = ?')
			.bind(versionId)
			.first<{ lineage_id: string }>();
		const lineageId = version?.lineage_id ?? '';
		await env.DB.prepare(
			'INSERT INTO lineage_yolo_acks (lineage_id, curve_id, acked_at) VALUES (?, ?, ?)'
		)
			.bind(lineageId, yolo, Date.now())
			.run();
		expect(
			await error(
				env.DB.prepare(
					'INSERT INTO lineage_yolo_acks (lineage_id, curve_id, acked_at) VALUES (?, ?, ?)'
				)
					.bind(lineageId, 'zzzzzzzzzzzz', Date.now())
					.run()
			)
		).toContain('FOREIGN KEY constraint failed');
		await env.DB.prepare('DELETE FROM lineages WHERE id = ?').bind(lineageId).run();
		const left = await env.DB.prepare(
			'SELECT count(*) AS n FROM lineage_yolo_acks WHERE lineage_id = ?'
		)
			.bind(lineageId)
			.first<{ n: number }>();
		expect(left?.n).toBe(0);
	});
});

describe('already migrated database (0004-0006 applied after 0010, 0013 over 0012 data)', () => {
	it('applies cleanly and the repository and deletion part work', async () => {
		const db = env.SOCIAL_ORDER_DB;
		const fresh = userTables(await names(db, 'table')).length === 0;
		// The state production was in before 0004-0006 arrived: every other migration up to 0010.
		// Later migrations (0012 alters versions) only ever ran after the social tables existed.
		await applyD1Migrations(
			db,
			env.TEST_MIGRATIONS.filter(
				(migration) => !isSocial(migration.name) && ordinal(migration.name) <= 10
			)
		);
		const before = await names(db, 'table');
		expect(before).toContain('username_holds');
		expect(before).toContain('auth_link_uses');
		if (fresh) expect(before).not.toContain('lineages');

		// Up to 0012 (social schema included), with rows written before 0013 existed.
		await applyD1Migrations(
			db,
			env.TEST_MIGRATIONS.filter((migration) => ordinal(migration.name) <= 12)
		);
		let legacyCurve: string | null = null;
		if (fresh) {
			expect(await columns(db, 'curves')).not.toContain('gate_yolo');
			legacyCurve = await rawCurve(db, { ok: 1 });
			await rawVersion(db, legacyCurve);
			expect(await error(rawVersion(db, await rawCurve(db, { ok: 0 })))).toContain('gate_rejected');
		}

		await applyD1Migrations(db, env.TEST_MIGRATIONS);
		if (legacyCurve !== null) {
			const legacy = await db
				.prepare('SELECT gate_ok, gate_yolo FROM curves WHERE id = ?')
				.bind(legacyCurve)
				.first<{ gate_ok: number; gate_yolo: number }>();
			expect(legacy).toEqual({ gate_ok: 1, gate_yolo: 0 });
			// The recreated trigger: a standard curve still takes versions, a YOLO one now does too.
			expect(await rawVersion(db, legacyCurve)).toMatch(/^ver-/);
			expect(await rawVersion(db, await rawCurve(db, { ok: 0, yolo: 1 }))).toMatch(/^ver-/);
			expect(await error(rawVersion(db, await rawCurve(db, { ok: 0, yolo: 0 })))).toContain(
				'gate_rejected'
			);
			expect(await error(rawCurve(db, { ok: 1, yolo: 1 }))).toContain('CHECK constraint failed');
		}
		expect(await columns(db, 'curves')).toContain('gate_yolo');
		expect(await names(db, 'table')).toContain('lineage_yolo_acks');
		const tables = await names(db, 'table');
		for (const table of SOCIAL_TABLES) expect(tables, table).toContain(table);
		const triggers = await names(db, 'trigger');
		for (const trigger of SOCIAL_TRIGGERS) expect(triggers, trigger).toContain(trigger);
		const applied = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{
			name: string;
		}>();
		const order = applied.results.map((row) => row.name);
		if (fresh) {
			expect(position(order, '0010_')).toBeLessThan(position(order, '0004_'));
		}

		// The schema works in this order too: publish, read, then close the account.
		const userId = sid('user');
		const at = new Date().toISOString();
		await db
			.prepare(
				'INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", ' +
					'"username", "banned", "library_visibility") VALUES (?, ?, ?, 1, ?, ?, ?, 0, ?)'
			)
			.bind(userId, 'Private Name', `${userId}@example.com`, at, at, userId.slice(0, 20), 'public')
			.run();
		const lineageId = sid('lin');
		const version = versionInput();
		const published = await publishLineage(db, {
			lineageId,
			ownerUserId: userId,
			visibility: 'public',
			curve: curveInput(),
			version,
			now: Date.now()
		});
		expect(published).toEqual({ ok: true, value: { lineageId, versionId: version.id } });
		expect((await getLineageForViewer(db, lineageId, { userId: null }))?.head.id).toBe(version.id);
		const feed = await listPublicFeed(db, { limit: 100 });
		expect(feed.items.map((item) => item.id)).toContain(lineageId);

		await batch(db, createContentDeletionPolicy().statements(db, userId, 'delete-all', Date.now()));
		await db.prepare('DELETE FROM "user" WHERE "id" = ?').bind(userId).run();
		const left = await db
			.prepare('SELECT count(*) AS n FROM lineages WHERE id = ?')
			.bind(lineageId)
			.first<{ n: number }>();
		expect(left?.n).toBe(0);
	});
});
