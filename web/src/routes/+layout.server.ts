// Minimal, non-sensitive session summary for the chrome (header account entry, policy banner).
// Never the e-mail, roles or other users' ids; only the user's own id, which ties per-account
// local data (the social activity outbox) to the person who acted. While prerendering there is no session: `sessionResolved` is
// false and the client asks /api/auth/get-session itself (see chrome/account.svelte.ts).
// `admin` (FUX.1, user menu) is a single boolean: whether the admin role is EFFECTIVE in this
// session (`isAdminEffective`: role, not banned, not impersonated, 2FA when required). It only
// decides whether the menu links to /admin; the /admin guard still checks everything itself.
import { building } from '$app/env';
import type { AccountSummary } from '#lib/components/chrome/account.ts';
import { isAdminEffective } from '#lib/server/auth/session-policy.ts';
import { getServerEnv } from '#lib/server/env.ts';
import { latestAcceptedVersion } from '#lib/server/legal/acceptance.ts';
import type { LayoutServerLoad } from './$types';

/** `seen`: latest policy version the signed-in user acknowledged; null data = unknown. */
type PolicyState = { seen: string | null } | null;

async function signedInPolicy(
	platform: App.Platform | undefined,
	userId: string
): Promise<PolicyState> {
	try {
		return { seen: await latestAcceptedVersion(getServerEnv(platform).db, userId) };
	} catch (error) {
		// Unknown state: the banner stays hidden rather than nagging on a lookup failure.
		console.warn(
			JSON.stringify({
				event: 'layout.policy_lookup_failed',
				reason: error instanceof Error ? error.name : 'unknown'
			})
		);
		return null;
	}
}

/** Effective admin for this session; any failure reads as "not admin" (the menu hides /admin). */
function effectiveAdmin(
	platform: App.Platform | undefined,
	session: App.Locals['session'],
	user: App.Locals['user']
): boolean {
	if (!session || !user) return false;
	try {
		return isAdminEffective(session, user, getServerEnv(platform));
	} catch (error) {
		console.warn(
			JSON.stringify({
				event: 'layout.admin_flag_failed',
				reason: error instanceof Error ? error.name : 'unknown'
			})
		);
		return false;
	}
}

interface LayoutAccount {
	user: AccountSummary | null;
	/** False on prerendered pages: the session is unknown at build time. */
	sessionResolved: boolean;
	policy: PolicyState;
	/** Admin role effective in this session (only a boolean reaches the client). */
	admin: boolean;
}

export const load: LayoutServerLoad = async ({ locals, platform }): Promise<LayoutAccount> => {
	const user = locals.user;
	if (building || !user) {
		return { user: null, sessionResolved: !building, policy: null, admin: false };
	}
	return {
		user: {
			id: user.id,
			username: user.displayUsername ?? user.username,
			emailVerified: user.emailVerified
		},
		sessionResolved: true,
		policy: await signedInPolicy(platform, user.id),
		admin: effectiveAdmin(platform, locals.session, user)
	};
};
