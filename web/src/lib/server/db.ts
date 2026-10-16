// Thin D1 helpers. Every query goes through `sql()`, which prepares the statement and binds its
// parameters; the helpers accept only the branded result, so a raw string or an unbound statement
// does not type-check. Values never enter the SQL text.
import type { D1Database, D1Meta, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';

/** Values D1 can bind. `undefined` is excluded on purpose (D1 rejects it at runtime). */
export type SqlParam = string | number | boolean | null | ArrayBuffer;

declare const boundBrand: unique symbol;

/** A D1 statement produced by {@link sql}, with all its placeholders bound. */
export type BoundStatement = D1PreparedStatement & { readonly [boundBrand]: true };

export class SqlPlaceholderError extends Error {
	constructor(expected: number, received: number) {
		super(`SQL placeholders (${expected}) do not match bound parameters (${received})`);
		this.name = 'SqlPlaceholderError';
	}
}

/**
 * Counts the parameters a statement expects: anonymous `?` placeholders, or the highest `?NNN`
 * index when numbered placeholders are used. Placeholders inside string literals, quoted
 * identifiers and comments are ignored.
 */
export function countPlaceholders(query: string): number {
	const code = query
		.replace(/'(?:[^']|'')*'/g, "''")
		.replace(/"(?:[^"]|"")*"/g, '""')
		.replace(/--[^\n]*/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '');
	let anonymous = 0;
	let highest = 0;
	for (const match of code.matchAll(/\?(\d*)/g)) {
		if (match[1]) highest = Math.max(highest, Number(match[1]));
		else anonymous += 1;
	}
	return Math.max(anonymous, highest);
}

/**
 * Prepares `query` and binds `params` positionally. The number of parameters must match the
 * placeholders, so a forgotten bind fails here instead of silently matching nothing.
 */
export function sql(db: D1Database, query: string, ...params: SqlParam[]): BoundStatement {
	const expected = countPlaceholders(query);
	if (expected !== params.length) throw new SqlPlaceholderError(expected, params.length);
	// The brand only records that bind() ran; it has no runtime representation.
	return db.prepare(query).bind(...params) as BoundStatement;
}

/** First row or `null`. */
export async function first<T = Record<string, unknown>>(
	statement: BoundStatement
): Promise<T | null> {
	return statement.first<T>();
}

/** All rows. */
export async function all<T = Record<string, unknown>>(statement: BoundStatement): Promise<T[]> {
	const result = await statement.all<T>();
	return result.results;
}

/** Executes a write; returns D1's metadata (`changes`, `last_row_id`, ...). */
export async function run(statement: BoundStatement): Promise<D1Meta> {
	const result = await statement.run();
	return result.meta;
}

/**
 * Executes the statements in one implicit transaction (D1 has no interactive transactions):
 * all succeed or all are rolled back.
 */
export async function batch<T = Record<string, unknown>>(
	db: D1Database,
	statements: readonly BoundStatement[]
): Promise<D1Result<T>[]> {
	if (statements.length === 0) return [];
	return db.batch<T>([...statements]);
}
