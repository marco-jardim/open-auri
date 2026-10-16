// The /conta actions that go through Better Auth (`locals.auth.api.*` with the request headers, so
// the session cookie, the T3.3 guard and Turnstile all apply): change password, change e-mail and
// request account closure. Results are typed codes; the page maps them to messages.
import type { D1Database } from '@cloudflare/workers-types';
import { isAPIError } from 'better-auth/api';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type Auth } from '../auth.ts';
import { first, sql } from '../db.ts';
import { TURNSTILE_HEADER } from '../auth/hooks.ts';
import { verifyPassword } from '../auth/password.ts';
import { isFreshSession } from '../auth/session-policy.ts';
import type { AuthSession } from '../types.ts';
import { recordDeletionRequest, type DeletionMode, isDeletionMode } from './deletion.ts';
import {
	isPlausibleEmail,
	normalizeEmail,
	recordEmailChangeRequest,
	type PendingEmailChange
} from './email-change.ts';

export const PASSWORD_MIN = MIN_PASSWORD_LENGTH;
export const PASSWORD_MAX = MAX_PASSWORD_LENGTH;

/** Where Better Auth sends the browser after the confirmation links. */
export const EMAIL_CHANGE_CALLBACK = '/conta?email=alterado';
export const CLOSURE_CALLBACK = '/conta/encerrada';

export type AccountAuthApi = Pick<Auth['api'], 'changePassword' | 'changeEmail' | 'deleteUser'>;

export interface AuthFailure {
	ok: false;
	/** Our code ('wrong-password', 'reauth-required', ...) or Better Auth's / the guard's code. */
	code: string;
	status: number;
	retryAfter?: number;
}

/** Code, HTTP status and Retry-After of a Better Auth APIError (null for anything else). */
export function readAuthError(error: unknown): Omit<AuthFailure, 'ok'> | null {
	if (!isAPIError(error)) return null;
	const body: unknown = Reflect.get(error, 'body');
	const rawCode = typeof body === 'object' && body !== null ? Reflect.get(body, 'code') : undefined;
	const statusCode: unknown = Reflect.get(error, 'statusCode');
	const headers: unknown = Reflect.get(error, 'headers');
	const retry =
		headers instanceof Headers
			? headers.get('retry-after')
			: typeof headers === 'object' && headers !== null
				? Reflect.get(headers, 'Retry-After')
				: null;
	const retryAfter = Number(retry);
	return {
		code: typeof rawCode === 'string' && rawCode !== '' ? rawCode : 'AUTH_ERROR',
		status: typeof statusCode === 'number' ? statusCode : 400,
		...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {})
	};
}

function failure(error: unknown): AuthFailure {
	const read = readAuthError(error);
	if (!read) throw error;
	if (read.code === 'INVALID_PASSWORD') return { ok: false, code: 'wrong-password', status: 400 };
	return { ok: false, ...read };
}

/** Checks `password` against the credential account of `userId` (scrypt, constant time). */
export async function verifyCurrentPassword(
	db: D1Database,
	userId: string,
	password: string
): Promise<boolean> {
	if (typeof password !== 'string' || password === '' || password.length > PASSWORD_MAX) {
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

export interface ChangePasswordInput {
	currentPassword: string;
	newPassword: string;
	confirmPassword: string;
	revokeOtherSessions: boolean;
}

export async function changeAccountPassword(
	api: AccountAuthApi,
	headers: Headers,
	input: ChangePasswordInput
): Promise<{ ok: true } | AuthFailure> {
	const { currentPassword, newPassword, confirmPassword } = input;
	if (!currentPassword) return { ok: false, code: 'wrong-password', status: 400 };
	if (newPassword.length < PASSWORD_MIN) return { ok: false, code: 'too-short', status: 400 };
	if (newPassword.length > PASSWORD_MAX) return { ok: false, code: 'too-long', status: 400 };
	if (newPassword !== confirmPassword) return { ok: false, code: 'mismatch', status: 400 };
	if (newPassword === currentPassword) return { ok: false, code: 'same-password', status: 400 };
	try {
		await api.changePassword({
			headers,
			body: { currentPassword, newPassword, revokeOtherSessions: input.revokeOtherSessions }
		});
		return { ok: true };
	} catch (error) {
		return failure(error);
	}
}

export interface EmailChangeInput {
	db: D1Database;
	userId: string;
	currentEmail: string;
	session: AuthSession;
	newEmail: string;
	/** Required when the session is older than the freshness window. */
	password: string;
	turnstileToken: string;
	now: number;
}

/**
 * Starts an e-mail change. Sensitive: needs a fresh session (T3.5 `isFreshSession`) or the current
 * password. Better Auth then mails the CURRENT address first; the request is recorded so /conta
 * shows it as pending.
 */
export async function requestEmailChange(
	api: AccountAuthApi,
	headers: Headers,
	input: EmailChangeInput
): Promise<{ ok: true; pending: PendingEmailChange } | AuthFailure> {
	const newEmail = normalizeEmail(input.newEmail);
	if (!isPlausibleEmail(newEmail)) return { ok: false, code: 'invalid-email', status: 400 };
	if (newEmail === normalizeEmail(input.currentEmail)) {
		return { ok: false, code: 'same-email', status: 400 };
	}
	if (!isFreshSession(input.session, undefined, input.now)) {
		if (!input.password) return { ok: false, code: 'reauth-required', status: 403 };
		if (!(await verifyCurrentPassword(input.db, input.userId, input.password))) {
			return { ok: false, code: 'wrong-password', status: 400 };
		}
	}
	const guarded = new Headers(headers);
	guarded.set(TURNSTILE_HEADER, input.turnstileToken);
	try {
		await api.changeEmail({
			headers: guarded,
			body: { newEmail, callbackURL: EMAIL_CHANGE_CALLBACK }
		});
	} catch (error) {
		return failure(error);
	}
	const pending = await recordEmailChangeRequest(input.db, input.userId, newEmail, input.now);
	return { ok: true, pending };
}

export interface ClosureInput {
	db: D1Database;
	userId: string;
	password: string;
	mode: DeletionMode;
	/** The "I understand" checkbox. */
	acknowledged: boolean;
	now: number;
}

/**
 * Requests the account closure: Better Auth checks the password and mails a confirmation link
 * (1 h). The chosen content policy is recorded right after, before the link can be used; the
 * beforeDelete hook (deletion.ts) applies it when the link is opened.
 */
export async function requestAccountClosure(
	api: AccountAuthApi,
	headers: Headers,
	input: ClosureInput
): Promise<{ ok: true } | AuthFailure> {
	if (!isDeletionMode(input.mode)) return { ok: false, code: 'invalid-mode', status: 400 };
	if (!input.acknowledged) return { ok: false, code: 'not-acknowledged', status: 400 };
	if (!input.password) return { ok: false, code: 'wrong-password', status: 400 };
	try {
		await api.deleteUser({
			headers,
			body: { password: input.password, callbackURL: CLOSURE_CALLBACK }
		});
	} catch (error) {
		return failure(error);
	}
	await recordDeletionRequest(input.db, input.userId, input.mode, input.now);
	return { ok: true };
}
