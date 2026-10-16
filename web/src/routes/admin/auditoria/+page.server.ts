// /admin/auditoria: the audit trail, newest first, paginated (?page=), optionally about one target
// (?target=<id>). Read-only view; the table itself rejects UPDATE/DELETE.
import { listAudit, parsePage } from '#lib/server/admin/audit.ts';
import { requireAdminPage } from '#lib/server/admin/kit.ts';
import type { PageServerLoad } from './$types';

const TARGET = /^[A-Za-z0-9_.:-]{1,128}$/;

export const load: PageServerLoad = async (event) => {
	const admin = await requireAdminPage(event);
	const page = parsePage(event.url.searchParams.get('page'));
	const rawTarget = event.url.searchParams.get('target');
	const target = rawTarget && TARGET.test(rawTarget) ? rawTarget : null;
	const result = await listAudit(admin.env.db, { page, targetId: target });
	return { audit: result, target };
};
