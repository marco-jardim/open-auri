// /admin/usuarios: search and ban/unban (destructive: fresh session required).
// Nickname / id searches use GET `?q=`; exact e-mail searches use the POST `?/searchEmail` action
// so addresses never land in URLs (browser history, edge logs). A `q` containing `@` is ignored.
import { fail } from '@sveltejs/kit';
import { banAction, reauthAction, unbanAction } from '#lib/server/admin/actions.ts';
import { requireAdminPage } from '#lib/server/admin/kit.ts';
import { searchUsers } from '#lib/server/admin/users.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const admin = await requireAdminPage(event);
	const raw = (event.url.searchParams.get('q') ?? '').trim().slice(0, 64);
	const q = raw.includes('@') ? '' : raw;
	const users = await searchUsers(admin.env.db, q);
	return { q, emailInUrl: raw.includes('@'), users, selfId: admin.user.id };
};

export const actions: Actions = {
	searchEmail: async (event) => {
		const admin = await requireAdminPage(event);
		const value = (await event.request.formData()).get('email');
		const email = typeof value === 'string' ? value.trim() : '';
		if (!email.includes('@') || email.length > 254) {
			return fail(400, { emailSearch: true as const, invalid: true as const });
		}
		return { emailSearch: true as const, users: await searchUsers(admin.env.db, email) };
	},
	ban: (event) => banAction(event),
	unban: (event) => unbanAction(event),
	reauth: (event) => reauthAction(event)
};
