// JSON auth guards of /api/v1: the same rules as auth/guards.ts and admin/guard.ts, thrown as
// ApiError (401 AUTH_REQUIRED, 403 EMAIL_NOT_VERIFIED / BANNED, 404 NOT_FOUND, 403 REAUTH_REQUIRED).
// Bans: `AuthUser` carries only `banned` (no expiry; auth.ts toAuthLocals). Better Auth's admin
// plugin lifts an expired ban itself, so a true flag in locals is treated as an active ban, exactly
// like checkUser does for pages.
import { requireAdmin, type RequireAdminOptions } from '../admin/guard.ts';
import { checkUser, checkVerified, type AccessResult, type AuthLocals } from '../auth/guards.ts';
import type { ServerEnv } from '../env.ts';
import type { AuthSession, AuthUser } from '../types.ts';
import { ApiError } from './errors.ts';

export interface ApiPrincipal {
	user: AuthUser;
	session: AuthSession;
}

function unwrap(result: AccessResult): ApiPrincipal {
	if (result.ok) return { user: result.user, session: result.session };
	if (result.code === 'UNAUTHENTICATED') throw new ApiError(401, 'AUTH_REQUIRED');
	throw new ApiError(403, result.code);
}

/** Signed in and not banned. */
export function apiUser(locals: AuthLocals): ApiPrincipal {
	return unwrap(checkUser(locals));
}

/** Signed in, not banned, verified e-mail (precondition of every social write). */
export function apiVerified(locals: AuthLocals): ApiPrincipal {
	return unwrap(checkVerified(locals));
}

/**
 * Signed in, not banned, and the owner of a resource. Someone else's resource answers 404
 * `NOT_FOUND` (does not reveal that a private resource exists).
 */
export function apiOwner(locals: AuthLocals, ownerId: string | null | undefined): ApiPrincipal {
	const principal = apiUser(locals);
	if (!ownerId || principal.user.id !== ownerId) throw new ApiError(404, 'NOT_FOUND');
	return principal;
}

export type ApiAdminOptions = Pick<RequireAdminOptions, 'destructive' | 'access' | 'now' | 'log'>;

/**
 * Admin check of admin/guard.ts. Not an admin / Access denied → 404 `NOT_FOUND`; destructive
 * action on a stale session → 403 `REAUTH_REQUIRED`.
 */
export async function apiAdmin(
	locals: AuthLocals,
	env: Pick<ServerEnv, 'flags'>,
	request: Request,
	rawEnv: unknown,
	options: ApiAdminOptions = {}
): Promise<ApiPrincipal> {
	const check = await requireAdmin(locals, env, { ...options, request, rawEnv });
	if (check.ok) return { user: check.user, session: check.session };
	if (check.status === 403) throw new ApiError(403, 'REAUTH_REQUIRED');
	throw new ApiError(404, 'NOT_FOUND');
}
