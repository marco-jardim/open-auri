// Session-level authorization rules shared by hooks, endpoints and the admin area (T3.8).
//
// 2FA marker: Better Auth's twoFactor plugin records no "second factor passed in this session"
// flag, so the session row carries `twoFactorVerifiedAt` (migration 0001, a session additional
// field with `input: false`, so no client request can set it). The auth hooks set it when
// /two-factor/verify-totp or /two-factor/verify-backup-code succeed (also on the first TOTP
// verification that enables 2FA). It disappears with the session (sign-out, revocation,
// password reset), and sessions created by a plain password sign-in never have it.
//
// No `$app/*` and no SvelteKit imports: tested inside workerd.

export const FRESH_SESSION_MS = 10 * 60 * 1000;

/** The fields these rules need; Better Auth sessions and App.Locals sessions both fit. */
export interface PolicySession {
	createdAt: Date | string | number;
	twoFactorVerifiedAt?: Date | string | number | null;
	impersonatedBy?: string | null;
}

export interface PolicyUser {
	role?: string | null;
	banned?: boolean | null;
	twoFactorEnabled?: boolean | null;
}

function toTime(value: Date | string | number | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isFinite(time) ? time : null;
}

/** Whether the second factor was passed in this session. */
export function hasTwoFactorMarker(session: Pick<PolicySession, 'twoFactorVerifiedAt'>): boolean {
	return toTime(session.twoFactorVerifiedAt) !== null;
}

/**
 * The admin role takes effect only for a non-banned, non-impersonated admin and, when
 * ADMIN_2FA_REQUIRED is on, only with 2FA enabled and verified in this very session.
 */
export function isAdminEffective(
	session: PolicySession | null | undefined,
	user: PolicyUser | null | undefined,
	env: { flags: { admin2faRequired: boolean } }
): boolean {
	if (!session || !user) return false;
	if (user.role !== 'admin' || user.banned === true) return false;
	if (session.impersonatedBy) return false;
	if (!env.flags.admin2faRequired) return true;
	return user.twoFactorEnabled === true && hasTwoFactorMarker(session);
}

/**
 * Freshness for destructive actions: the session was created, or passed the second factor,
 * within `maxAgeMs` (10 minutes by default). Re-verifying TOTP refreshes it without a new login.
 */
export function isFreshSession(
	session: PolicySession | null | undefined,
	maxAgeMs: number = FRESH_SESSION_MS,
	now: number = Date.now()
): boolean {
	if (!session) return false;
	const created = toTime(session.createdAt);
	const verified = toTime(session.twoFactorVerifiedAt);
	const latest = Math.max(
		created ?? Number.NEGATIVE_INFINITY,
		verified ?? Number.NEGATIVE_INFINITY
	);
	if (!Number.isFinite(latest)) return false;
	return now - latest >= 0 && now - latest < maxAgeMs;
}

export class StaleSessionError extends Error {
	readonly code = 'SESSION_NOT_FRESH';
	readonly status = 403;
	constructor() {
		super('Session is not fresh enough for this action');
		this.name = 'StaleSessionError';
	}
}

/** Throws {@link StaleSessionError} unless {@link isFreshSession}. */
export function requireFreshSession(
	session: PolicySession | null | undefined,
	maxAgeMs: number = FRESH_SESSION_MS,
	now: number = Date.now()
): void {
	if (!isFreshSession(session, maxAgeMs, now)) throw new StaleSessionError();
}
