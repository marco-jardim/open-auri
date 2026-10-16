// Users for the admin area: search (nickname prefix, exact e-mail or exact id) and ban/unban
// through the Better Auth admin plugin (`auth.api.banUser` / `unbanUser`, which also revoke the
// banned user's sessions), audit-first. E-mail addresses never leave this module unmasked.
// No `$app/*`: tested inside workerd.
import type { D1Database } from '@cloudflare/workers-types';
import type { Auth } from '../auth.ts';
import { normalizeUsername } from '../auth/username.ts';
import { all, first, sql } from '../db.ts';
import { audited, AUDIT_ACTIONS, type AuditOptions } from './audit.ts';

export const SEARCH_LIMIT = 25;
export const REASON_MIN = 3;
export const REASON_MAX = 500;
/** Ban durations offered by the form, in days; `permanent` = no expiry. */
export const BAN_DURATIONS = ['1', '7', '30', '90', '365', 'permanent'] as const;
export type BanDuration = (typeof BAN_DURATIONS)[number];

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_S = 86_400;

export interface AdminUserRow {
	id: string;
	nickname: string | null;
	emailMasked: string;
	emailVerified: boolean;
	role: 'user' | 'admin';
	banned: boolean;
	banExpires: string | null;
	twoFactorEnabled: boolean;
	createdAt: string | null;
}

interface UserDbRow {
	id: string;
	email: string;
	username: string | null;
	displayUsername: string | null;
	emailVerified: number | null;
	role: string | null;
	banned: number | null;
	banExpires: string | number | null;
	twoFactorEnabled: number | null;
	createdAt: string | number | null;
}

/** `marcos@example.com` → `m***@e***.com`. Never reversible, keeps only the shape. */
export function maskEmail(email: string): string {
	const at = email.lastIndexOf('@');
	if (at <= 0) return '***';
	const local = email.slice(0, at);
	const domain = email.slice(at + 1);
	const dot = domain.lastIndexOf('.');
	const tld = dot > 0 ? domain.slice(dot) : '';
	const head = dot > 0 ? domain.slice(0, dot) : domain;
	return `${local.slice(0, 1)}***@${head.slice(0, 1)}***${tld}`;
}

function toIso(value: string | number | null): string | null {
	if (value === null || value === '') return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toAdminRow(row: UserDbRow): AdminUserRow {
	return {
		id: row.id,
		nickname: row.displayUsername ?? row.username,
		emailMasked: maskEmail(row.email),
		emailVerified: row.emailVerified === 1,
		role: row.role === 'admin' ? 'admin' : 'user',
		banned: row.banned === 1,
		banExpires: toIso(row.banExpires),
		twoFactorEnabled: row.twoFactorEnabled === 1,
		createdAt: toIso(row.createdAt)
	};
}

const COLUMNS =
	'SELECT id, email, username, displayUsername, emailVerified, role, banned, banExpires, twoFactorEnabled, createdAt FROM "user"';

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Searches users. Empty query: newest accounts. Contains `@`: exact e-mail (case-insensitive,
 * no partial match, so the list cannot be used to harvest addresses). Otherwise: nickname prefix
 * (normalized like sign-up) or exact user id.
 */
export async function searchUsers(
	db: D1Database,
	query: string,
	limit: number = SEARCH_LIMIT
): Promise<AdminUserRow[]> {
	const q = query.trim().slice(0, 254);
	const max = Math.min(Math.max(limit, 1), 100);
	let rows: UserDbRow[];
	if (q === '') {
		rows = await all<UserDbRow>(sql(db, `${COLUMNS} ORDER BY createdAt DESC, id LIMIT ?`, max));
	} else if (q.includes('@')) {
		rows = await all<UserDbRow>(
			sql(db, `${COLUMNS} WHERE email = ? LIMIT ?`, q.normalize('NFKC').toLowerCase(), max)
		);
	} else {
		const nickname = normalizeUsername(q);
		rows = await all<UserDbRow>(
			sql(
				db,
				`${COLUMNS} WHERE username LIKE ? ESCAPE '\\' OR id = ? ORDER BY username, id LIMIT ?`,
				`${escapeLike(nickname)}%`,
				q,
				max
			)
		);
	}
	return rows.map(toAdminRow);
}

/** One user by id (null when absent or the id is malformed). */
export async function getAdminUser(db: D1Database, id: string): Promise<AdminUserRow | null> {
	if (!USER_ID.test(id)) return null;
	const row = await first<UserDbRow>(sql(db, `${COLUMNS} WHERE id = ?`, id));
	return row ? toAdminRow(row) : null;
}

export type ModerationError =
	'INVALID_INPUT' | 'NOT_FOUND' | 'SELF' | 'TARGET_IS_ADMIN' | 'NOT_BANNED' | 'FAILED';

export type ModerationResult = { ok: true } | { ok: false; code: ModerationError };

export interface BanInput {
	userId: string;
	reason: string;
	duration: BanDuration;
}

export interface UnbanInput {
	userId: string;
	reason: string;
}

function field(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === 'string' ? value.trim() : '';
}

function validReason(reason: string): boolean {
	if (reason.length < REASON_MIN || reason.length > REASON_MAX) return false;
	for (const char of reason) {
		const code = char.codePointAt(0) ?? 0;
		const control = code < 0x20 && char !== '\n' && char !== '\r' && char !== '\t';
		if (control || code === 0x7f) return false;
	}
	return true;
}

/** Parses the ban form; `null` when invalid. */
export function parseBanForm(form: FormData): BanInput | null {
	const userId = field(form, 'userId');
	const reason = field(form, 'reason');
	const duration = field(form, 'duration');
	if (!USER_ID.test(userId) || !validReason(reason)) return null;
	if (!(BAN_DURATIONS as readonly string[]).includes(duration)) return null;
	return { userId, reason, duration: duration as BanDuration };
}

/** Parses the unban form; `null` when invalid. */
export function parseUnbanForm(form: FormData): UnbanInput | null {
	const userId = field(form, 'userId');
	const reason = field(form, 'reason');
	if (!USER_ID.test(userId) || !validReason(reason)) return null;
	return { userId, reason };
}

export interface ModerationDeps {
	db: D1Database;
	/** The per-request Better Auth instance (`locals.auth`). */
	auth: Pick<Auth, 'api'>;
	/** The admin's request headers (session cookie). */
	headers: Headers;
	actorId: string;
	audit?: AuditOptions;
}

/** Bans a user (not an admin, not oneself) with reason and expiry; audited. */
export async function banUser(deps: ModerationDeps, input: BanInput): Promise<ModerationResult> {
	if (input.userId === deps.actorId) return { ok: false, code: 'SELF' };
	const target = await getAdminUser(deps.db, input.userId);
	if (!target) return { ok: false, code: 'NOT_FOUND' };
	// Admins lose the role through the operator tool, never through the UI.
	if (target.role === 'admin') return { ok: false, code: 'TARGET_IS_ADMIN' };
	const days = input.duration === 'permanent' ? null : Number(input.duration);
	try {
		await audited(
			deps.db,
			{
				actorId: deps.actorId,
				actorKind: 'admin',
				action: AUDIT_ACTIONS.userBan,
				targetKind: 'user',
				targetId: input.userId,
				detail: { reason: input.reason, days }
			},
			() =>
				deps.auth.api.banUser({
					headers: deps.headers,
					body: {
						userId: input.userId,
						banReason: input.reason,
						...(days === null ? {} : { banExpiresIn: days * DAY_S })
					}
				}),
			deps.audit
		);
	} catch {
		return { ok: false, code: 'FAILED' };
	}
	return { ok: true };
}

/** Lifts a ban; audited with the reason. */
export async function unbanUser(
	deps: ModerationDeps,
	input: UnbanInput
): Promise<ModerationResult> {
	const target = await getAdminUser(deps.db, input.userId);
	if (!target) return { ok: false, code: 'NOT_FOUND' };
	if (!target.banned) return { ok: false, code: 'NOT_BANNED' };
	try {
		await audited(
			deps.db,
			{
				actorId: deps.actorId,
				actorKind: 'admin',
				action: AUDIT_ACTIONS.userUnban,
				targetKind: 'user',
				targetId: input.userId,
				detail: { reason: input.reason }
			},
			() => deps.auth.api.unbanUser({ headers: deps.headers, body: { userId: input.userId } }),
			deps.audit
		);
	} catch {
		return { ok: false, code: 'FAILED' };
	}
	return { ok: true };
}
