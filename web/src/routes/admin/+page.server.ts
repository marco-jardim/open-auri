// /admin dashboard: read-only switch (destructive: needs a fresh session) and the latest audit rows.
import { readOnlyAction, reauthAction } from '#lib/server/admin/actions.ts';
import { listAudit } from '#lib/server/admin/audit.ts';
import { requireAdminPage } from '#lib/server/admin/kit.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const admin = await requireAdminPage(event);
	const recent = await listAudit(admin.env.db, { page: 1, pageSize: 10 });
	return { recent: recent.rows };
};

export const actions: Actions = {
	readOnly: (event) => readOnlyAction(event),
	reauth: (event) => reauthAction(event)
};
