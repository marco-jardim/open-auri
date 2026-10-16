// migrations/0001_auth.sql against the schema Better Auth expects for the configuration of
// createAuth(). Runtime schema validation is off in production (per-request instances would
// introspect D1 on every request), so this test is the guard against drift.
import type { BetterAuthPlugin } from 'better-auth';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { Harness } from './harness.ts';

type SchemaCheck = () => Promise<void> | undefined;

async function explicitCheck(harness: Harness): Promise<SchemaCheck> {
	const context = (await harness.auth.$context) as unknown as { explicitSchemaCheck?: SchemaCheck };
	const check = context.explicitSchemaCheck;
	if (typeof check !== 'function') throw new Error('Better Auth schema check is not available');
	return check;
}

async function indexNames(table: string): Promise<string[]> {
	const { results } = await env.DB.prepare(`PRAGMA index_list("${table}")`).all<{ name: string }>();
	return results.map((row) => row.name);
}

describe('migration 0001 vs Better Auth', () => {
	it('has every table and column Better Auth writes, and no required column it never writes', async () => {
		const check = await explicitCheck(new Harness());
		await expect(Promise.resolve(check())).resolves.toBeUndefined();
	});

	it('the check really compares (an extra plugin column is reported missing)', async () => {
		const probe = {
			id: 'schema-probe',
			schema: { session: { fields: { probeColumn: { type: 'string', required: false } } } }
		} as unknown as BetterAuthPlugin;
		const check = await explicitCheck(new Harness({}, { plugins: [probe] }));
		await expect(Promise.resolve(check())).rejects.toThrow(/probeColumn/);
	});

	it('creates the lookup indexes', async () => {
		expect(await indexNames('user')).toEqual(
			expect.arrayContaining([
				'user_email_uidx',
				'user_username_uidx',
				'user_usernameSkeleton_uidx'
			])
		);
		expect(await indexNames('session')).toEqual(
			expect.arrayContaining(['session_token_uidx', 'session_userId_idx'])
		);
		expect(await indexNames('account')).toEqual(expect.arrayContaining(['account_userId_idx']));
		expect(await indexNames('verification')).toEqual(
			expect.arrayContaining(['verification_identifier_idx'])
		);
		expect(await indexNames('twoFactor')).toEqual(
			expect.arrayContaining(['twoFactor_secret_idx', 'twoFactor_userId_idx'])
		);
	});

	it('cascades user deletion to the child tables', async () => {
		const { results } = await env.DB.prepare('PRAGMA foreign_key_list("session")').all<{
			table: string;
			on_delete: string;
		}>();
		expect(results).toEqual(
			expect.arrayContaining([expect.objectContaining({ table: 'user', on_delete: 'CASCADE' })])
		);
	});
});
