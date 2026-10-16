// Active sessions of the signed-in user for /conta. Read and revoked by id straight from the
// session table, always scoped to the owner (`userId = ?`), so a session id of someone else is
// simply "not found". Tokens never leave this module. There is no cookie cache (auth.ts), so a
// revoked session stops working on its next request.
import type { D1Database } from '@cloudflare/workers-types';
import { all, run, sql } from '../db.ts';
import { toEpoch } from './profile.ts';

export interface AccountSession {
	id: string;
	/** Browser family and OS ("Firefox on Linux"), reduced at sign-in; null when unknown. */
	browser: string | null;
	os: string | null;
	createdAt: number;
	/** Last time Better Auth refreshed the session (approximate last activity). */
	lastActiveAt: number;
	expiresAt: number;
	current: boolean;
	/** Opened by an administrator impersonating the account (admin plugin). */
	impersonated: boolean;
}

/** Splits the reduced user agent of auth/user-agent.ts; "Other" parts count as unknown. */
export function parseDevice(userAgent: string | null): {
	browser: string | null;
	os: string | null;
} {
	const match = /^(.+) on (.+)$/.exec(userAgent ?? '');
	if (!match) return { browser: null, os: null };
	const known = (value: string | undefined) => (value && value !== 'Other' ? value : null);
	return { browser: known(match[1]), os: known(match[2]) };
}

interface SessionRow {
	id: string;
	userAgent: string | null;
	createdAt: string | number;
	updatedAt: string | number;
	expiresAt: string | number;
	impersonatedBy: string | null;
}

/** Unexpired sessions of `userId`, current first, then most recently active. */
export async function listAccountSessions(
	db: D1Database,
	userId: string,
	currentSessionId: string | null,
	now: number
): Promise<AccountSession[]> {
	const rows = await all<SessionRow>(
		sql(
			db,
			'SELECT "id", "userAgent", "createdAt", "updatedAt", "expiresAt", "impersonatedBy" ' +
				'FROM "session" WHERE "userId" = ?',
			userId
		)
	);
	const sessions: AccountSession[] = [];
	for (const row of rows) {
		const expiresAt = toEpoch(row.expiresAt);
		if (expiresAt === null || expiresAt <= now) continue;
		const createdAt = toEpoch(row.createdAt) ?? 0;
		sessions.push({
			id: row.id,
			...parseDevice(row.userAgent),
			createdAt,
			lastActiveAt: Math.max(createdAt, toEpoch(row.updatedAt) ?? 0),
			expiresAt,
			current: row.id === currentSessionId,
			impersonated: typeof row.impersonatedBy === 'string' && row.impersonatedBy !== ''
		});
	}
	return sessions.sort(
		(a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt - a.lastActiveAt
	);
}

export type RevokeResult = 'revoked' | 'not-found' | 'current';

/**
 * Revokes one session of `userId`. The current session is refused here (signing out is the way to
 * end it), and ids of other users' sessions are reported as not found.
 */
export async function revokeAccountSession(
	db: D1Database,
	userId: string,
	sessionId: string,
	currentSessionId: string
): Promise<RevokeResult> {
	if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 128) {
		return 'not-found';
	}
	if (sessionId === currentSessionId) return 'current';
	const meta = await run(
		sql(db, 'DELETE FROM "session" WHERE "id" = ? AND "userId" = ?', sessionId, userId)
	);
	return meta.changes > 0 ? 'revoked' : 'not-found';
}

/** Revokes every session of `userId` except the current one; returns how many ended. */
export async function revokeOtherAccountSessions(
	db: D1Database,
	userId: string,
	currentSessionId: string
): Promise<number> {
	const meta = await run(
		sql(db, 'DELETE FROM "session" WHERE "userId" = ? AND "id" <> ?', userId, currentSessionId)
	);
	return meta.changes;
}
