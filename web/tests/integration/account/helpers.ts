// Fixtures of the account-area tests: users, sessions and credentials written straight to D1
// (fast, no e-mail round trip) and the `locals` shape hooks.server.ts builds. Flows that need
// Better Auth itself (password, e-mail, deletion) use ../auth/harness.ts instead.
import { env } from 'cloudflare:workers';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { usernameSkeleton } from '#lib/server/auth/username.ts';
import { getServerEnv } from '#lib/server/env.ts';
import type { AuthSession, AuthUser } from '#lib/server/types.ts';

export const DAY = 24 * 60 * 60 * 1000;

/** PUBLIC_ORIGIN of the test environment. */
export function origin(): string {
	return getServerEnv({ env }).publicOrigin;
}

export function uid(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

/** Nickname base unique per call: `<prefix>` + 12 hex digits (3 to 24 characters). */
export function nick(prefix = 'n'): string {
	return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export interface SeedUserOptions {
	verified?: boolean;
	username?: string | null;
	banned?: boolean;
	email?: string;
}

export interface SeededUser {
	id: string;
	email: string;
	username: string | null;
}

export async function seedUser(options: SeedUserOptions = {}): Promise<SeededUser> {
	const id = uid('user');
	const email = options.email ?? `${id}@example.com`;
	const username = options.username ?? null;
	const at = new Date().toISOString();
	await env.DB.prepare(
		'INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", ' +
			'"username", "displayUsername", "usernameSkeleton", "role", "banned") ' +
			'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
	)
		.bind(
			id,
			'Private Name',
			email,
			options.verified === false ? 0 : 1,
			at,
			at,
			username,
			username,
			username === null ? null : usernameSkeleton(username),
			'user',
			options.banned ? 1 : 0
		)
		.run();
	return { id, email, username };
}

export interface SeedSessionOptions {
	userAgent?: string | null;
	createdAt?: number;
	updatedAt?: number;
	expiresAt?: number;
}

export async function seedSession(
	userId: string,
	options: SeedSessionOptions = {}
): Promise<{ id: string; token: string }> {
	const id = uid('session');
	const token = uid('secret-session-token');
	const now = Date.now();
	await env.DB.prepare(
		'INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", ' +
			'"userAgent", "userId") VALUES (?, ?, ?, ?, ?, NULL, ?, ?)'
	)
		.bind(
			id,
			new Date(options.expiresAt ?? now + 7 * DAY).toISOString(),
			token,
			new Date(options.createdAt ?? now).toISOString(),
			new Date(options.updatedAt ?? options.createdAt ?? now).toISOString(),
			options.userAgent === undefined ? 'Firefox on Linux' : options.userAgent,
			userId
		)
		.run();
	return { id, token };
}

/** Credential account with a recognisable fake hash, and a 2FA row with a fake secret. */
export async function seedSecrets(userId: string): Promise<{ hash: string; totp: string }> {
	const hash = `scrypt$16384$8$5$${'ab'.repeat(16)}$${'cd'.repeat(64)}`;
	const totp = uid('totp-secret');
	const at = new Date().toISOString();
	await env.DB.prepare(
		'INSERT INTO "account" ("id", "accountId", "providerId", "userId", "password", ' +
			'"accessToken", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
	)
		.bind(uid('account'), userId, 'credential', userId, hash, uid('oauth-token'), at, at)
		.run();
	await env.DB.prepare(
		'INSERT INTO "twoFactor" ("id", "secret", "backupCodes", "userId") VALUES (?, ?, ?, ?)'
	)
		.bind(uid('2fa'), totp, uid('backup-codes'), userId)
		.run();
	return { hash, totp };
}

export function authUser(user: SeededUser, overrides: Partial<AuthUser> = {}): AuthUser {
	return {
		id: user.id,
		email: user.email,
		name: 'Private Name',
		emailVerified: true,
		role: 'user',
		username: user.username,
		displayUsername: user.username,
		banned: false,
		twoFactorEnabled: false,
		...overrides
	};
}

export function authSession(
	userId: string,
	sessionId: string,
	overrides: Partial<AuthSession> = {}
): AuthSession {
	return {
		id: sessionId,
		userId,
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + 7 * DAY),
		twoFactorVerifiedAt: null,
		twoFactorVerified: false,
		impersonatedBy: null,
		...overrides
	};
}

export function locals(user: SeededUser, sessionId: string, overrides: Partial<AuthUser> = {}) {
	return {
		user: authUser(user, overrides),
		session: authSession(user.id, sessionId)
	} satisfies AuthLocals;
}

export const ANONYMOUS: AuthLocals = { user: null, session: null };

export async function count(query: string, ...params: (string | number)[]): Promise<number> {
	const row = await env.DB.prepare(query)
		.bind(...params)
		.first<{ n: number }>();
	return row?.n ?? 0;
}
