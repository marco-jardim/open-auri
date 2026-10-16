// Two-step verification (TOTP) of the account area (/conta, FX3.4). Every call goes through
// `auth.api.*` with the request headers, so the session cookie, the origin check and the auth
// hooks apply: the per-user limits on password and code attempts (auth/secret-guard.ts) and, for
// an admin with 2FA on, the session's 2FA marker (403 TWO_FACTOR_REQUIRED).
//
// Better Auth semantics (better-auth 1.7.10, plugins/two-factor, `skipVerificationOnEnable` off):
//   - `/two-factor/enable` checks the password, stores a NEW encrypted secret and encrypted backup
//     codes in `twoFactor` with `verified = false` and returns the otpauth URI and the backup codes
//     in clear. `user.twoFactorEnabled` stays false; starting again replaces a pending enrolment.
//   - `/two-factor/verify-totp` with the session's code marks the row verified, sets
//     `twoFactorEnabled = true` and rotates the session (the auth after-hook sets the 2FA marker on
//     the new one). A wrong code is 401 INVALID_CODE (mapped here to 400 'invalid-code').
//   - `/two-factor/disable` checks the password, sets `twoFactorEnabled = false`, deletes the row
//     and rotates the session. It also cancels a pending enrolment.
//
// The URI and the backup codes are secrets: they go back to the caller once and are never stored,
// logged or put in a cookie or URL by this module.
import type { D1Database } from '@cloudflare/workers-types';
import type { Auth } from '../auth.ts';
import { first, sql } from '../db.ts';
import { readAuthError } from './auth-actions.ts';

export type TwoFactorAuthApi = Pick<
	Auth['api'],
	'enableTwoFactor' | 'verifyTOTP' | 'disableTwoFactor'
>;

/** `locals.auth` (or a test harness's instance): only the 2FA endpoints are used. */
export interface TwoFactorAuth {
	api: TwoFactorAuthApi;
}

export type TwoFactorErrorCode =
	/** Missing or wrong current password. */
	| 'wrong-password'
	/** Malformed or wrong 6-digit code. */
	| 'invalid-code'
	/** Admin with 2FA on whose session has no 2FA marker: verify the second factor first. */
	| 'two-factor-required'
	/** Start while 2FA is already on. */
	| 'already-enabled'
	/** Confirm without a pending enrolment. */
	| 'not-enrolling'
	/** Per-user attempt limit of the auth hooks (429 + Retry-After). */
	| 'RATE_LIMITED'
	| 'RATE_LIMIT_UNAVAILABLE'
	/** No session (signed out meanwhile). */
	| 'unauthenticated'
	| 'failed';

export interface TwoFactorFailure {
	ok: false;
	code: TwoFactorErrorCode;
	status: number;
	retryAfter?: number;
}

export interface TwoFactorEnrolment {
	ok: true;
	/** otpauth://totp/... with the base32 secret: shown once (QR + text), never stored by us. */
	totpURI: string;
	/** One-time recovery codes: shown once, never stored by us (Better Auth keeps them encrypted). */
	backupCodes: string[];
}

export type TwoFactorStatus = 'off' | 'pending' | 'on';

export const TOTP_DIGITS = 6;

/** "123 456" / "123-456" → "123456"; null unless exactly six digits remain. */
export function normalizeTotpCode(value: string): string | null {
	const code = value.replace(/[\s-]/g, '');
	return code.length === TOTP_DIGITS && /^\d+$/.test(code) ? code : null;
}

function failure(error: unknown): TwoFactorFailure {
	const read = readAuthError(error);
	if (!read) throw error;
	switch (read.code) {
		case 'INVALID_PASSWORD':
			return { ok: false, code: 'wrong-password', status: 400 };
		case 'INVALID_CODE':
			return { ok: false, code: 'invalid-code', status: 400 };
		case 'TWO_FACTOR_REQUIRED':
			return { ok: false, code: 'two-factor-required', status: 403 };
		case 'TOTP_ALREADY_ENABLED':
			return { ok: false, code: 'already-enabled', status: 400 };
		case 'TOTP_NOT_ENABLED':
		case 'TWO_FACTOR_NOT_ENABLED':
			return { ok: false, code: 'not-enrolling', status: 400 };
		case 'RATE_LIMITED':
			return {
				ok: false,
				code: 'RATE_LIMITED',
				status: 429,
				...(read.retryAfter === undefined ? {} : { retryAfter: read.retryAfter })
			};
		case 'RATE_LIMIT_UNAVAILABLE':
			return { ok: false, code: 'RATE_LIMIT_UNAVAILABLE', status: 503 };
		default:
			if (read.status === 401) return { ok: false, code: 'unauthenticated', status: 401 };
			return { ok: false, code: 'failed', status: read.status >= 500 ? read.status : 400 };
	}
}

function enrolmentOf(value: unknown): Omit<TwoFactorEnrolment, 'ok'> | null {
	if (typeof value !== 'object' || value === null) return null;
	const totpURI: unknown = Reflect.get(value, 'totpURI');
	const backupCodes: unknown = Reflect.get(value, 'backupCodes');
	if (typeof totpURI !== 'string' || !totpURI.startsWith('otpauth://totp/')) return null;
	if (!Array.isArray(backupCodes) || !backupCodes.every((code) => typeof code === 'string')) {
		return null;
	}
	return { totpURI, backupCodes: [...(backupCodes as string[])] };
}

/**
 * Step 1: checks the password and creates a pending enrolment (new secret and backup codes; 2FA
 * stays off until {@link confirmEnrolment}). Returns the URI and the codes for this response only.
 */
export async function startEnrolment(
	auth: TwoFactorAuth,
	headers: Headers,
	password: string
): Promise<TwoFactorEnrolment | TwoFactorFailure> {
	if (!password) return { ok: false, code: 'wrong-password', status: 400 };
	let result: unknown;
	try {
		result = await auth.api.enableTwoFactor({ headers, body: { password, method: 'totp' } });
	} catch (error) {
		return failure(error);
	}
	const enrolment = enrolmentOf(result);
	if (!enrolment) return { ok: false, code: 'failed', status: 500 };
	return { ok: true, ...enrolment };
}

/**
 * Step 2: the first code from the authenticator app turns 2FA on (and rotates the session, which
 * gets the 2FA marker). A malformed code is refused before Better Auth (no attempt counted).
 */
export async function confirmEnrolment(
	auth: TwoFactorAuth,
	headers: Headers,
	code: string
): Promise<{ ok: true } | TwoFactorFailure> {
	const normalized = normalizeTotpCode(code);
	if (!normalized) return { ok: false, code: 'invalid-code', status: 400 };
	try {
		await auth.api.verifyTOTP({ headers, body: { code: normalized } });
		return { ok: true };
	} catch (error) {
		return failure(error);
	}
}

/** Turns 2FA off (or cancels a pending enrolment); needs the password. */
export async function disableTwoFactor(
	auth: TwoFactorAuth,
	headers: Headers,
	password: string
): Promise<{ ok: true } | TwoFactorFailure> {
	if (!password) return { ok: false, code: 'wrong-password', status: 400 };
	try {
		await auth.api.disableTwoFactor({ headers, body: { password } });
		return { ok: true };
	} catch (error) {
		return failure(error);
	}
}

/**
 * Current state, read from D1 (not from `locals.user`, which predates an action of the same
 * request): 'on' (enabled), 'pending' (enrolment started, not confirmed) or 'off'. Reads no
 * secret column.
 */
export async function readTwoFactorStatus(
	db: D1Database,
	userId: string
): Promise<TwoFactorStatus> {
	const row = await first<{ enabled: unknown; pending: unknown }>(
		sql(
			db,
			'SELECT u."twoFactorEnabled" AS enabled, ' +
				'EXISTS (SELECT 1 FROM "twoFactor" t WHERE t."userId" = u.id ' +
				"AND (t.verified = 0 OR t.verified = 'false')) AS pending " +
				'FROM "user" u WHERE u.id = ?',
			userId
		)
	);
	if (!row) return 'off';
	// Better Auth writes booleans to SQLite as 1/0; 'true' is accepted defensively.
	if (row.enabled === 1 || row.enabled === 'true' || row.enabled === true) return 'on';
	return Number(row.pending) === 1 ? 'pending' : 'off';
}
