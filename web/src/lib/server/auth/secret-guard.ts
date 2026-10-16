// Limits on secrets checked for a signed-in user (Q3-1): the current password (change password,
// delete account, 2FA management, change e-mail of a stale session) and the second factor of an
// existing session (TOTP / backup code: admin re-authentication, 2FA freshness). Better Auth's own
// throttle is off (`rateLimit.enabled: false`) and its 2FA lockout only counts sign-in challenges,
// so without this a session holder could guess codes or passwords without bound.
//
// Rules (security/ratelimit.ts SECRET_POLICIES, D1 sliding windows keyed on the user id):
// attempts 5 per 5 min, counted before every check; wrong secrets 20 per day, checked before every
// attempt and counted when the secret was wrong (our lockout). The auth hooks apply them to the
// Better Auth endpoints; admin re-authentication goes through the same hook (it calls
// `auth.api.verifyTOTP`). No `$app/*`: tested inside workerd.
import type { D1Database } from '@cloudflare/workers-types';
import { first, sql } from '../db.ts';
import {
	secretAttemptRules,
	secretFailureRule,
	slidingWindowLimit,
	type SecretKind,
	type WindowRule
} from '../security/ratelimit.ts';
import { MAX_PASSWORD_LENGTH, verifyPassword } from './password.ts';

export type { SecretKind } from '../security/ratelimit.ts';

export type SecretAttempt =
	{ ok: true } | { ok: false; status: 429; retryAfter: number } | { ok: false; status: 503 };

/**
 * Counts one attempt for `userId` and checks the failure budget. Call it before verifying the
 * secret; a refusal means "do not even check". Fails closed (503) when D1 or the key is unusable.
 */
export async function beginSecretAttempt(
	db: D1Database,
	kind: SecretKind,
	userId: string,
	now: Date = new Date()
): Promise<SecretAttempt> {
	let rules: WindowRule[];
	try {
		rules = secretAttemptRules(kind, userId);
	} catch {
		return { ok: false, status: 503 };
	}
	const outcome = await slidingWindowLimit(db, rules, now);
	if (outcome.ok) return { ok: true };
	return outcome.reason === 'limited'
		? { ok: false, status: 429, retryAfter: outcome.retryAfter }
		: { ok: false, status: 503 };
}

/** Counts one wrong secret toward the lockout budget. Never throws. */
export async function recordSecretFailure(
	db: D1Database,
	kind: SecretKind,
	userId: string,
	now: Date = new Date()
): Promise<void> {
	try {
		await slidingWindowLimit(db, [secretFailureRule(kind, userId)], now);
	} catch {
		// A lost failure count only loosens the daily budget; the attempt window still applies.
	}
}

/**
 * Raw check of `password` against the credential account of `userId` (scrypt, constant time).
 * Callers must run {@link beginSecretAttempt} first and {@link recordSecretFailure} on `false`.
 */
export async function verifyUserPassword(
	db: D1Database,
	userId: string,
	password: string
): Promise<boolean> {
	if (typeof password !== 'string' || password === '' || password.length > MAX_PASSWORD_LENGTH) {
		return false;
	}
	const row = await first<{ password: string | null }>(
		sql(
			db,
			'SELECT "password" FROM "account" WHERE "userId" = ? AND "providerId" = ? LIMIT 1',
			userId,
			'credential'
		)
	);
	if (!row?.password) return false;
	return verifyPassword({ hash: row.password, password });
}

export type PasswordCheck = 'ok' | 'wrong' | 'limited' | 'unavailable';

/** {@link beginSecretAttempt} + {@link verifyUserPassword} + {@link recordSecretFailure}. */
export async function checkUserPassword(
	db: D1Database,
	userId: string,
	password: string,
	now: Date = new Date()
): Promise<{ result: PasswordCheck; retryAfter?: number }> {
	const attempt = await beginSecretAttempt(db, 'password', userId, now);
	if (!attempt.ok) {
		return attempt.status === 429
			? { result: 'limited', retryAfter: attempt.retryAfter }
			: { result: 'unavailable' };
	}
	if (await verifyUserPassword(db, userId, password)) return { result: 'ok' };
	await recordSecretFailure(db, 'password', userId, now);
	return { result: 'wrong' };
}
