import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { batch, first, run, sql } from '#lib/server/db.ts';
import {
	PolicyAcceptanceInputError,
	deleteAcceptancesStatement,
	hasAccepted,
	latestAcceptedVersion,
	listAcceptances,
	recordAcceptance
} from '#lib/server/legal/acceptance.ts';
import { POLICY_VERSION } from '#lib/content/legal/version.ts';

const USER = 'user-t3-4-a';
const OTHER = 'user-t3-4-b';
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

beforeEach(async () => {
	await run(sql(env.DB, 'DELETE FROM policy_acceptances WHERE user_id IN (?, ?)', USER, OTHER));
});

describe('policy_acceptances (migration 0008)', () => {
	it('has the planned columns and composite primary key', async () => {
		const columns = await env.DB.prepare('PRAGMA table_info(policy_acceptances)').all<{
			name: string;
			type: string;
			notnull: number;
			pk: number;
		}>();
		expect(
			columns.results.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))
		).toEqual([
			{ name: 'user_id', type: 'TEXT', notnull: 1, pk: 1 },
			{ name: 'version', type: 'TEXT', notnull: 1, pk: 2 },
			{ name: 'accepted_at', type: 'INTEGER', notnull: 1, pk: 0 }
		]);
	});
});

describe('recordAcceptance / hasAccepted', () => {
	it('records once per user and version and keeps the first timestamp', async () => {
		expect(await hasAccepted(env.DB, USER, POLICY_VERSION)).toBe(false);
		expect(await recordAcceptance(env.DB, USER, POLICY_VERSION, NOW)).toBe(true);
		expect(await recordAcceptance(env.DB, USER, POLICY_VERSION, NOW + 60_000)).toBe(false);
		expect(await hasAccepted(env.DB, USER, POLICY_VERSION)).toBe(true);
		const row = await first<{ accepted_at: number; n: number }>(
			sql(
				env.DB,
				'SELECT accepted_at, COUNT(*) AS n FROM policy_acceptances WHERE user_id = ?',
				USER
			)
		);
		expect(row).toEqual({ accepted_at: NOW, n: 1 });
	});

	it('is scoped per user and per version', async () => {
		await recordAcceptance(env.DB, USER, '2026-01-01', NOW - 1000);
		expect(await hasAccepted(env.DB, USER, POLICY_VERSION)).toBe(false);
		expect(await hasAccepted(env.DB, OTHER, '2026-01-01')).toBe(false);
		expect(await latestAcceptedVersion(env.DB, USER)).toBe('2026-01-01');
		expect(await latestAcceptedVersion(env.DB, OTHER)).toBeNull();

		await recordAcceptance(env.DB, USER, POLICY_VERSION, NOW);
		expect(await latestAcceptedVersion(env.DB, USER)).toBe(POLICY_VERSION);
		expect(await listAcceptances(env.DB, USER)).toEqual([
			{ version: '2026-01-01', acceptedAt: NOW - 1000 },
			{ version: POLICY_VERSION, acceptedAt: NOW }
		]);
	});

	it('binds hostile identifiers as values', async () => {
		const hostile = "x'); DROP TABLE policy_acceptances; --";
		expect(await recordAcceptance(env.DB, hostile, POLICY_VERSION, NOW)).toBe(true);
		expect(await hasAccepted(env.DB, hostile, POLICY_VERSION)).toBe(true);
		await batch(env.DB, [deleteAcceptancesStatement(env.DB, hostile)]);
		expect(await hasAccepted(env.DB, hostile, POLICY_VERSION)).toBe(false);
	});

	it('deletes every acknowledgement of one user only (account deletion batch)', async () => {
		await recordAcceptance(env.DB, USER, POLICY_VERSION, NOW);
		await recordAcceptance(env.DB, USER, '2026-01-01', NOW);
		await recordAcceptance(env.DB, OTHER, POLICY_VERSION, NOW);
		const [result] = await batch(env.DB, [deleteAcceptancesStatement(env.DB, USER)]);
		expect(result.meta.changes).toBe(2);
		expect(await listAcceptances(env.DB, USER)).toEqual([]);
		expect(await hasAccepted(env.DB, OTHER, POLICY_VERSION)).toBe(true);
	});

	it('rejects invalid input before touching the database', async () => {
		await expect(recordAcceptance(env.DB, '', POLICY_VERSION, NOW)).rejects.toThrow(
			PolicyAcceptanceInputError
		);
		await expect(recordAcceptance(env.DB, 'u'.repeat(129), POLICY_VERSION, NOW)).rejects.toThrow(
			'Invalid policy acceptance userId'
		);
		await expect(recordAcceptance(env.DB, USER, 'v2', NOW)).rejects.toThrow(
			'Invalid policy acceptance version'
		);
		for (const now of [Number.NaN, -1, 1.5]) {
			await expect(recordAcceptance(env.DB, USER, POLICY_VERSION, now)).rejects.toThrow(
				'Invalid policy acceptance now'
			);
		}
		await expect(hasAccepted(env.DB, USER, '')).rejects.toThrow(PolicyAcceptanceInputError);
		await expect(latestAcceptedVersion(env.DB, '')).rejects.toThrow(PolicyAcceptanceInputError);
		await expect(listAcceptances(env.DB, '')).rejects.toThrow(PolicyAcceptanceInputError);
		expect(() => deleteAcceptancesStatement(env.DB, '')).toThrow(PolicyAcceptanceInputError);
		expect(await listAcceptances(env.DB, USER)).toEqual([]);
	});
});
