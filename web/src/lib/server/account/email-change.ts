// Pending e-mail change shown in /conta (table email_change_requests, migration 0009).
// Better Auth's change-email links are signed tokens without a database row, so the account area
// records the request when /change-email accepts it. The flow has two links (current address,
// then the new one), each valid for the verification TTL, so the pending notice lasts for two of
// them. Anti-enumeration: the request is recorded whether or not the new address is taken, like
// Better Auth's own answer.
import type { D1Database } from '@cloudflare/workers-types';
import { first, run, sql } from '../db.ts';
import { LINK_TTL_SECONDS } from '../auth/emails.ts';

export const EMAIL_CHANGE_PENDING_MS = 2 * LINK_TTL_SECONDS.verification * 1000;
export const EMAIL_MAX = 254;

export interface PendingEmailChange {
	newEmail: string;
	requestedAt: number;
	expiresAt: number;
}

export function normalizeEmail(value: string): string {
	return value.normalize('NFKC').trim().toLowerCase();
}

/** Loose shape check before Better Auth's own validation (one @, a dot in the domain). */
export function isPlausibleEmail(value: string): boolean {
	return value.length >= 3 && value.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function recordEmailChangeRequest(
	db: D1Database,
	userId: string,
	newEmail: string,
	now: number
): Promise<PendingEmailChange> {
	const email = normalizeEmail(newEmail);
	const expiresAt = now + EMAIL_CHANGE_PENDING_MS;
	await run(
		sql(
			db,
			'INSERT INTO email_change_requests (user_id, new_email, requested_at, expires_at) ' +
				'VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET new_email = excluded.new_email, ' +
				'requested_at = excluded.requested_at, expires_at = excluded.expires_at',
			userId,
			email,
			now,
			expiresAt
		)
	);
	return { newEmail: email, requestedAt: now, expiresAt };
}

export async function clearEmailChangeRequest(db: D1Database, userId: string): Promise<void> {
	await run(sql(db, 'DELETE FROM email_change_requests WHERE user_id = ?', userId));
}

/**
 * The pending change of `userId`, or null. A request that expired or already happened (the
 * account address is now the new one) is removed and reported as none.
 */
export async function pendingEmailChange(
	db: D1Database,
	userId: string,
	currentEmail: string,
	now: number
): Promise<PendingEmailChange | null> {
	const row = await first<{ new_email: string; requested_at: number; expires_at: number }>(
		sql(
			db,
			'SELECT new_email, requested_at, expires_at FROM email_change_requests WHERE user_id = ?',
			userId
		)
	);
	if (!row) return null;
	if (row.expires_at <= now || row.new_email === normalizeEmail(currentEmail)) {
		await clearEmailChangeRequest(db, userId);
		return null;
	}
	return { newEmail: row.new_email, requestedAt: row.requested_at, expiresAt: row.expires_at };
}
