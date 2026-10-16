// Pure display helpers of the admin pages (no Svelte, no `$app/*`): unit-tested in
// web/tests/unit/pages/admin/format.test.ts.

/** An audit row as the pages receive it (same shape as server/admin/audit.ts `AuditRow`). */
export interface AuditTableRow {
	id: string;
	actorId: string | null;
	actorKind: 'admin' | 'operator' | 'system';
	action: string;
	targetKind: string | null;
	targetId: string | null;
	detail: Record<string, unknown> | null;
	createdAt: number;
}

export type UserStatus = 'active' | 'banned' | 'banned_until' | 'ban_expired';

/** Ban state as shown in the table; Better Auth lifts expired bans lazily at the next sign-in. */
export function userStatus(
	row: { banned: boolean; banExpires: string | null },
	now: number = Date.now()
): UserStatus {
	if (!row.banned) return 'active';
	if (row.banExpires === null) return 'banned';
	const until = Date.parse(row.banExpires);
	if (!Number.isFinite(until)) return 'banned';
	return until > now ? 'banned_until' : 'ban_expired';
}

/** Date and time in UTC, in the page locale (`16/10/2026 14:05 UTC`). */
export function formatWhen(value: number | string | null, locale: string): string {
	if (value === null) return '-';
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return '-';
	const text = new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
		timeZone: 'UTC'
	}).format(date);
	return `${text} UTC`;
}

/** Compact one-line rendering of an audit `detail` object (rendered as text, never HTML). */
export function detailText(detail: Record<string, unknown> | null): string {
	if (!detail) return '';
	return Object.entries(detail)
		.map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
		.join(' · ');
}

/** Link to page `page` keeping the other query parameters (e.g. the target filter). */
export function pageHref(pathname: string, search: URLSearchParams, page: number): string {
	const params = new URLSearchParams(search);
	if (page <= 1) params.delete('page');
	else params.set('page', String(page));
	const query = params.toString();
	return query ? `${pathname}?${query}` : pathname;
}

/** Minutes (rounded up, ≥ 0) until `until` (ms epoch). */
export function minutesLeft(until: number, now: number = Date.now()): number {
	return Math.max(0, Math.ceil((until - now) / 60_000));
}
