// /admin: rendered on demand (never prerendered), never indexed or cached. The guard answers 404
// to everyone who is not an effective admin (and, when configured, without a valid Cloudflare
// Access JWT). Page loads and actions repeat the guard: SvelteKit runs them without waiting for
// this load.
import { ADMIN_HEADERS, requireAdminPage } from '#lib/server/admin/kit.ts';
import { isReadOnly } from '#lib/server/admin/read-only.ts';
import { FRESH_SESSION_MS } from '#lib/server/auth/session-policy.ts';
import type { LayoutServerLoad } from './$types';

export const prerender = false;
export const ssr = true;

export const load: LayoutServerLoad = async (event) => {
	event.setHeaders(ADMIN_HEADERS);
	const admin = await requireAdminPage(event);
	const lastAuth = Math.max(
		admin.session.createdAt.getTime(),
		admin.session.twoFactorVerifiedAt?.getTime() ?? 0
	);
	return {
		admin: {
			id: admin.user.id,
			nickname: admin.user.displayUsername ?? admin.user.username,
			twoFactorEnabled: admin.user.twoFactorEnabled,
			freshUntil: lastAuth + FRESH_SESSION_MS
		},
		readOnly: await isReadOnly(admin.env),
		accessConfigured: admin.accessConfigured
	};
};
