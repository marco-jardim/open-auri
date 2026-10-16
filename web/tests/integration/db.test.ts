import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	all,
	batch,
	countPlaceholders,
	first,
	run,
	sql,
	SqlPlaceholderError
} from '#lib/server/db.ts';

const TABLE = 't3_1_db_probe';
const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`;

describe('countPlaceholders', () => {
	it('counts anonymous and numbered placeholders outside literals and comments', () => {
		expect(countPlaceholders('SELECT 1')).toBe(0);
		expect(countPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(2);
		expect(countPlaceholders('SELECT ?2, ?1, ?2')).toBe(2);
		expect(countPlaceholders('SELECT \'?\', "x?" -- ?\n/* ? */ FROM t WHERE a = ?')).toBe(1);
		expect(countPlaceholders("SELECT 'it''s ?' WHERE a = ?")).toBe(1);
	});
});

describe('D1 helpers', () => {
	beforeAll(async () => {
		await run(sql(env.DB, CREATE));
	});

	afterAll(async () => {
		await run(sql(env.DB, `DROP TABLE IF EXISTS ${TABLE}`));
	});

	it('binds parameters as values, never as SQL', async () => {
		const hostile = `x'); DROP TABLE ${TABLE}; --`;
		const results = await batch(env.DB, [
			sql(env.DB, `INSERT INTO ${TABLE} (label) VALUES (?)`, hostile),
			sql(env.DB, `INSERT INTO ${TABLE} (label) VALUES (?1)`, 'plain')
		]);
		expect(results).toHaveLength(2);

		const select = sql(env.DB, `SELECT label FROM ${TABLE} ORDER BY id`);
		const rows = await all<{ label: string }>(select);
		expect(rows.map((row) => row.label)).toEqual([hostile, 'plain']);

		const count = sql(env.DB, `SELECT COUNT(*) AS n FROM ${TABLE} WHERE label = ?`, 'plain');
		expect((await first<{ n: number }>(count))?.n).toBe(1);

		const meta = await run(sql(env.DB, `DELETE FROM ${TABLE} WHERE label = ?`, 'plain'));
		expect(meta.changes).toBe(1);
		const gone = sql(env.DB, `SELECT id FROM ${TABLE} WHERE label = ?`, 'plain');
		expect(await first(gone)).toBeNull();
	});

	it('rejects a statement whose placeholders do not match the parameters', () => {
		expect(() => sql(env.DB, 'SELECT ? AS a, ? AS b', 1)).toThrow(SqlPlaceholderError);
		expect(() => sql(env.DB, 'SELECT 1', 'extra')).toThrow(SqlPlaceholderError);
	});

	it('treats an empty batch as a no-op', async () => {
		expect(await batch(env.DB, [])).toEqual([]);
	});
});
