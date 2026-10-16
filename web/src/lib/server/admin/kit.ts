// SvelteKit side of the admin guard. Loads use `requireAdminPage` (404 unless admin);
// form actions use `requireAdminAction`, which also returns `fail(403, { reauth: true })` for
// destructive actions on a stale session. Thin on purpose: the logic is in guard.ts.
import { error, fail, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import type { Auth } from '../auth.ts';
import { getServerEnv, type ServerEnv } from '../env.ts';
import type { AuthSession, AuthUser } from '../types.ts';
import { requireAdmin } from './guard.ts';

export interface AdminContext {
	user: AuthUser;
	session: AuthSession;
	env: ServerEnv;
	auth: Auth;
	accessConfigured: boolean;
}

type AdminEvent = Pick<RequestEvent, 'locals' | 'platform' | 'request'>;

export interface ReauthFailure {
	reauth: true;
	code: 'REAUTH_REQUIRED';
}

async function check(
	event: AdminEvent,
	destructive: boolean
): Promise<AdminContext | ActionFailure<ReauthFailure>> {
	const { locals, platform, request } = event;
	const env = getServerEnv(platform);
	const auth = locals.auth;
	if (!auth) error(404);
	const result = await requireAdmin(locals, env, { destructive, request, rawEnv: platform?.env });
	if (!result.ok) {
		if (result.status === 404) error(404);
		return fail(403, { reauth: true as const, code: result.code });
	}
	return {
		user: result.user,
		session: result.session,
		env,
		auth,
		accessConfigured: result.accessConfigured
	};
}

/** For loads and non-destructive actions: 404 unless the admin guard passes. */
export async function requireAdminPage(event: AdminEvent): Promise<AdminContext> {
	const result = await check(event, false);
	// Non-destructive checks never produce the reauth failure.
	if (!('user' in result)) error(404);
	return result;
}

/** For destructive actions: 404 unless admin; `fail(403, { reauth })` when the session is stale. */
export function requireAdminAction(
	event: AdminEvent
): Promise<AdminContext | ActionFailure<ReauthFailure>> {
	return check(event, true);
}

/** Response headers of every admin page: never indexed, never cached. */
export const ADMIN_HEADERS = {
	'x-robots-tag': 'noindex, nofollow',
	'cache-control': 'no-store'
} as const;
