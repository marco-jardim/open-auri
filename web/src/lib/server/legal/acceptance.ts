// Policy acknowledgements of signed-in users (table policy_acceptances, migration 0008).
// The endpoint and the layout wiring come with T3.5/T3.7; account deletion must run
// deleteAcceptancesStatement() in its batch. No `$app/*` imports: tested in the Worker pool.
import type { D1Database } from '@cloudflare/workers-types';
import { all, first, run, sql, type BoundStatement } from '../db.ts';
import { isPolicyVersion } from '../../content/legal/version.ts';

export class PolicyAcceptanceInputError extends Error {
	constructor(field: 'userId' | 'version' | 'now') {
		super(`Invalid policy acceptance ${field}`);
		this.name = 'PolicyAcceptanceInputError';
	}
}

function checkUser(userId: string): void {
	if (typeof userId !== 'string' || !userId || userId.length > 128) {
		throw new PolicyAcceptanceInputError('userId');
	}
}

function check(userId: string, version: string): void {
	checkUser(userId);
	if (!isPolicyVersion(version)) throw new PolicyAcceptanceInputError('version');
}

/**
 * Records that `userId` acknowledged `version` at `now` (epoch ms). Idempotent: the first
 * acknowledgement is kept. Returns true only when a new row was written.
 */
export async function recordAcceptance(
	db: D1Database,
	userId: string,
	version: string,
	now: number
): Promise<boolean> {
	check(userId, version);
	if (!Number.isSafeInteger(now) || now < 0) throw new PolicyAcceptanceInputError('now');
	const meta = await run(
		sql(
			db,
			'INSERT INTO policy_acceptances (user_id, version, accepted_at) VALUES (?, ?, ?) ' +
				'ON CONFLICT (user_id, version) DO NOTHING',
			userId,
			version,
			now
		)
	);
	return meta.changes > 0;
}

/** Whether `userId` already acknowledged `version`. */
export async function hasAccepted(
	db: D1Database,
	userId: string,
	version: string
): Promise<boolean> {
	check(userId, version);
	const row = await first<{ found: number }>(
		sql(
			db,
			'SELECT 1 AS found FROM policy_acceptances WHERE user_id = ? AND version = ?',
			userId,
			version
		)
	);
	return row !== null;
}

/** Latest version `userId` acknowledged, or null; feeds the banner's `seenVersion`. */
export async function latestAcceptedVersion(
	db: D1Database,
	userId: string
): Promise<string | null> {
	checkUser(userId);
	const row = await first<{ version: string }>(
		sql(
			db,
			'SELECT version FROM policy_acceptances WHERE user_id = ? ' +
				'ORDER BY version DESC, accepted_at DESC LIMIT 1',
			userId
		)
	);
	return row?.version ?? null;
}

/** All acknowledgements of `userId`, oldest first (for the LGPD data export). */
export async function listAcceptances(
	db: D1Database,
	userId: string
): Promise<{ version: string; acceptedAt: number }[]> {
	checkUser(userId);
	const rows = await all<{ version: string; accepted_at: number }>(
		sql(
			db,
			'SELECT version, accepted_at FROM policy_acceptances WHERE user_id = ? ' +
				'ORDER BY accepted_at, version',
			userId
		)
	);
	return rows.map((row) => ({ version: row.version, acceptedAt: row.accepted_at }));
}

/** Statement that deletes every acknowledgement of `userId`; for the account-deletion batch. */
export function deleteAcceptancesStatement(db: D1Database, userId: string): BoundStatement {
	checkUser(userId);
	return sql(db, 'DELETE FROM policy_acceptances WHERE user_id = ?', userId);
}
