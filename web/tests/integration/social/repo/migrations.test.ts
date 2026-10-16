// Migrations 0004-0006 (T4.1): on the fresh test database they ran before 0007-0010 (setup file);
// on a second, empty D1 they are applied AFTER 0001-0003 and 0007-0010 (an already migrated
// production database) and the repository and the deletion part work the same.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { createContentDeletionPolicy } from '#lib/server/account/deletion.ts';
import { batch } from '#lib/server/db.ts';
import { getLineageForViewer, listPublicFeed, publishLineage } from '#lib/server/social/repo.ts';
import { curveInput, sid, versionInput } from './helpers.ts';

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
	'ranking_state'
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

describe('already migrated database (0004-0006 applied after 0010)', () => {
	it('applies cleanly and the repository and deletion part work', async () => {
		const db = env.SOCIAL_ORDER_DB;
		const fresh = userTables(await names(db, 'table')).length === 0;
		await applyD1Migrations(
			db,
			env.TEST_MIGRATIONS.filter((migration) => !isSocial(migration.name))
		);
		const before = await names(db, 'table');
		expect(before).toContain('username_holds');
		expect(before).toContain('auth_link_uses');
		if (fresh) expect(before).not.toContain('lineages');

		await applyD1Migrations(db, env.TEST_MIGRATIONS);
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
