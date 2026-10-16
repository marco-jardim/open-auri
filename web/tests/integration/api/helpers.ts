// Shared fixtures of the /api/v1 kit tests (T4.1b): fake locals, fake RateLimit bindings and
// assertions on ApiError / JSON error responses.
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { ApiError, type ApiErrorCode } from '#lib/server/api/index.ts';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { getServerEnv, type ServerEnv } from '#lib/server/env.ts';
import type { AuthSession, AuthUser } from '#lib/server/types.ts';

export const ORIGIN: string = env.PUBLIC_ORIGIN;
export const HOSTNAME: string = new URL(ORIGIN).hostname;

export function serverEnv(): ServerEnv {
	return getServerEnv({ env });
}

export function fakeUser(overrides: Partial<AuthUser> = {}): AuthUser {
	const id = crypto.randomUUID();
	return {
		id,
		email: `${id}@example.test`,
		name: 'Test',
		emailVerified: true,
		role: 'user',
		username: null,
		displayUsername: null,
		banned: false,
		twoFactorEnabled: false,
		...overrides
	};
}

export function fakeSession(user: AuthUser, overrides: Partial<AuthSession> = {}): AuthSession {
	const now = Date.now();
	return {
		id: crypto.randomUUID(),
		userId: user.id,
		createdAt: new Date(now),
		expiresAt: new Date(now + 86_400_000),
		twoFactorVerifiedAt: null,
		twoFactorVerified: false,
		impersonatedBy: null,
		...overrides
	};
}

export function signedOut(): AuthLocals {
	return { user: null, session: null };
}

export function localsOf(
	userOverrides: Partial<AuthUser> = {},
	sessionOverrides: Partial<AuthSession> = {}
): { user: AuthUser; session: AuthSession } {
	const user = fakeUser(userOverrides);
	return { user, session: fakeSession(user, sessionOverrides) };
}

/** Admin with 2FA verified in this session (passes ADMIN_2FA_REQUIRED). */
export function adminLocals(sessionOverrides: Partial<AuthSession> = {}): {
	user: AuthUser;
	session: AuthSession;
} {
	const now = new Date();
	return localsOf(
		{ role: 'admin', twoFactorEnabled: true },
		{ twoFactorVerified: true, twoFactorVerifiedAt: now, ...sessionOverrides }
	);
}

/** A session last confirmed one hour ago (stale for destructive admin actions). */
export function staleSession(): Partial<AuthSession> {
	const hourAgo = new Date(Date.now() - 3_600_000);
	return { createdAt: hourAgo, twoFactorVerifiedAt: hourAgo };
}

export interface FakeBinding {
	keys: string[];
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** RateLimit binding stand-in: `allow`, `deny` or `throw`; records the keys it saw. */
export function fakeBinding(mode: 'allow' | 'deny' | 'throw'): FakeBinding {
	const keys: string[] = [];
	return {
		keys,
		async limit({ key }) {
			keys.push(key);
			if (mode === 'throw') throw new Error('binding down');
			return { success: mode === 'allow' };
		}
	};
}

export function randomIp(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(3));
	return `10.${bytes[0] ?? 0}.${bytes[1] ?? 0}.${bytes[2] ?? 1}`;
}

/** Asserts that `run` throws (or rejects with) an ApiError with this status and code. */
export async function expectApiError(
	run: () => unknown,
	status: number,
	code: ApiErrorCode
): Promise<ApiError> {
	let caught: unknown = null;
	try {
		await run();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(ApiError);
	const apiErr = caught as ApiError;
	expect({ status: apiErr.status, code: apiErr.code }).toEqual({ status, code });
	return apiErr;
}

/** Asserts a JSON error response of the kit and returns its body. */
export async function expectErrorResponse(
	response: Response,
	status: number,
	code: ApiErrorCode
): Promise<{ error: { code: string; details?: unknown } }> {
	expect(response.status).toBe(status);
	expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
	expect(response.headers.get('cache-control')).toBe('no-store');
	const body = (await response.json()) as { error: { code: string; details?: unknown } };
	expect(body.error.code).toBe(code);
	return body;
}
