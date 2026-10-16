// Guard of the /admin area (plan T3.8). Order of checks:
//   1. signed in, not banned, admin role effective (`isAdminEffective`: role admin, not an
//      impersonation session, and with ADMIN_2FA_REQUIRED the 2FA marker of this session);
//   2. Cloudflare Access JWT, when ACCESS_AUD + ACCESS_TEAM_DOMAIN are configured (fail closed);
//   3. destructive actions only: a fresh session (`isFreshSession`, 10 minutes since sign-in or
//      since the last second-factor verification).
// Failures of 1 and 2 answer 404 so the area's existence is not revealed; 3 answers 403
// `REAUTH_REQUIRED`, which the pages turn into a re-authentication prompt. Pure result type, no
// SvelteKit imports (kit.ts maps it to `error()` / `fail()`); tested inside workerd.
import type { ServerEnv } from '../env.ts';
import { checkUser, type AuthLocals } from '../auth/guards.ts';
import { FRESH_SESSION_MS, isAdminEffective, isFreshSession } from '../auth/session-policy.ts';
import type { AuthSession, AuthUser } from '../types.ts';
import { checkAccess, type AccessDeps, type AccessFailureReason } from './access.ts';

export const REAUTH_REQUIRED = 'REAUTH_REQUIRED';

export type AdminDenial = 'not_admin' | `access_${AccessFailureReason}`;

export type AdminCheck =
	| { ok: true; user: AuthUser; session: AuthSession; accessConfigured: boolean }
	| { ok: false; status: 404; reason: AdminDenial }
	| { ok: false; status: 403; reason: 'stale'; code: typeof REAUTH_REQUIRED };

export interface RequireAdminOptions {
	/** Destructive actions (ban, unban, read-only toggle) also need a fresh session. */
	destructive?: boolean;
	/** The incoming request (Access JWT header). */
	request: Request;
	/** Raw `platform.env` (optional ACCESS_AUD / ACCESS_TEAM_DOMAIN). */
	rawEnv: unknown;
	access?: AccessDeps;
	now?: number;
	/** Log sink for denials caused by Access (reason codes only). */
	log?: (line: string) => void;
}

export async function requireAdmin(
	locals: AuthLocals,
	env: Pick<ServerEnv, 'flags'>,
	options: RequireAdminOptions
): Promise<AdminCheck> {
	const current = checkUser(locals);
	if (!current.ok || !isAdminEffective(current.session, current.user, env)) {
		return { ok: false, status: 404, reason: 'not_admin' };
	}
	const access = await checkAccess(options.request, options.rawEnv, options.access);
	if (!access.ok) {
		(options.log ?? console.warn)(
			JSON.stringify({ event: 'admin.access_denied', reason: access.reason })
		);
		return { ok: false, status: 404, reason: `access_${access.reason}` };
	}
	if (
		options.destructive === true &&
		!isFreshSession(current.session, FRESH_SESSION_MS, options.now ?? Date.now())
	) {
		return { ok: false, status: 403, reason: 'stale', code: REAUTH_REQUIRED };
	}
	return {
		ok: true,
		user: current.user,
		session: current.session,
		accessConfigured: access.configured
	};
}
