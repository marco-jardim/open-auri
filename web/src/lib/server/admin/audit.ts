// Append-only audit trail (migration 0003). Every administrative mutation writes one row here;
// the table rejects UPDATE and DELETE, so nothing written can be rewritten from the app.
//
// `detail` must never hold personal data beyond ids (no e-mail, IP, token, user agent): the
// helper accepts only flat JSON values and drops keys that look like personal fields.
// No `$app/*` and no SvelteKit imports: tested inside workerd.
import type { D1Database } from '@cloudflare/workers-types';
import { all, first, run, sql, type BoundStatement } from '../db.ts';

export type ActorKind = 'admin' | 'operator' | 'system';

/** Stable action codes written by the app (tools add their own, see the admin README). */
export const AUDIT_ACTIONS = {
	userBan: 'user.ban',
	userUnban: 'user.unban',
	readOnlyOn: 'mode.read_only.on',
	readOnlyOff: 'mode.read_only.off',
	reauth: 'admin.reauth',
	grantAdmin: 'user.grant_admin',
	accessLogQuery: 'access_log.query'
} as const;

export type DetailValue = string | number | boolean | null;

export interface AuditEntry {
	actorId: string | null;
	actorKind: ActorKind;
	action: string;
	targetKind?: string | null;
	targetId?: string | null;
	detail?: Record<string, DetailValue> | null;
}

export interface AuditRow {
	id: string;
	actorId: string | null;
	actorKind: ActorKind;
	action: string;
	targetKind: string | null;
	targetId: string | null;
	detail: Record<string, unknown> | null;
	createdAt: number;
}

export interface AuditOptions {
	now?: () => number;
	id?: () => string;
}

const ACTION = /^[a-z][a-z0-9_.-]{0,63}$/;
// Keys that would carry personal data; ids (`*Id`) are fine.
const FORBIDDEN_KEY = /e-?mail|address|token|password|secret|agent|cookie|^ip(?:[A-Z_]|$)/i;
const MAX_DETAIL_STRING = 500;

export class AuditEntryError extends Error {
	constructor(reason: string) {
		super(`Invalid audit entry: ${reason}`);
		this.name = 'AuditEntryError';
	}
}

/** Validates the entry and serializes `detail`; throws {@link AuditEntryError}. */
export function serializeDetail(detail: AuditEntry['detail']): string | null {
	if (detail === null || detail === undefined) return null;
	const clean: Record<string, DetailValue> = {};
	for (const [key, value] of Object.entries(detail)) {
		if (FORBIDDEN_KEY.test(key)) throw new AuditEntryError(`detail key "${key}" is not allowed`);
		if (typeof value === 'string') clean[key] = value.slice(0, MAX_DETAIL_STRING);
		else if (typeof value === 'number' && !Number.isFinite(value)) clean[key] = null;
		else clean[key] = value;
	}
	return JSON.stringify(clean);
}

/** The INSERT for `entry`, to run alone or inside a `batch`. */
export function auditStatement(
	db: D1Database,
	entry: AuditEntry,
	options: AuditOptions = {}
): BoundStatement {
	if (!ACTION.test(entry.action)) throw new AuditEntryError('action');
	if (!['admin', 'operator', 'system'].includes(entry.actorKind)) {
		throw new AuditEntryError('actor kind');
	}
	const id = (options.id ?? (() => crypto.randomUUID()))();
	const now = (options.now ?? Date.now)();
	return sql(
		db,
		'INSERT INTO audit_log (id, actor_id, actor_kind, action, target_kind, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
		id,
		entry.actorId,
		entry.actorKind,
		entry.action,
		entry.targetKind ?? null,
		entry.targetId ?? null,
		serializeDetail(entry.detail),
		now
	);
}

/** Writes one audit row. */
export async function audit(
	db: D1Database,
	entry: AuditEntry,
	options: AuditOptions = {}
): Promise<void> {
	await run(auditStatement(db, entry, options));
}

/**
 * Audit-first mutation: the intent row is written before `mutate` runs, so a mutation can never
 * happen without a trail (if the audit write fails, nothing is changed). When `mutate` throws, a
 * second row `<action>.failed` with the error name/code is appended and the error is rethrown
 * (rows are immutable, so the failure is recorded instead of the intent being edited).
 */
export async function audited<T>(
	db: D1Database,
	entry: AuditEntry,
	mutate: () => Promise<T>,
	options: AuditOptions = {}
): Promise<T> {
	await audit(db, entry, options);
	try {
		return await mutate();
	} catch (error) {
		const code =
			typeof error === 'object' && error !== null && 'body' in error
				? errorCode((error as { body?: unknown }).body)
				: null;
		await audit(
			db,
			{
				...entry,
				action: `${entry.action}.failed`.slice(0, 64),
				detail: { reason: code ?? (error instanceof Error ? error.name : 'unknown') }
			},
			options
		).catch(() => undefined);
		throw error;
	}
}

function errorCode(body: unknown): string | null {
	if (typeof body !== 'object' || body === null) return null;
	const code = (body as { code?: unknown }).code;
	return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
}

interface AuditDbRow {
	id: string;
	actor_id: string | null;
	actor_kind: ActorKind;
	action: string;
	target_kind: string | null;
	target_id: string | null;
	detail: string | null;
	created_at: number;
}

function parseDetail(text: string | null): Record<string, unknown> | null {
	if (text === null) return null;
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function toRow(row: AuditDbRow): AuditRow {
	return {
		id: row.id,
		actorId: row.actor_id,
		actorKind: row.actor_kind,
		action: row.action,
		targetKind: row.target_kind,
		targetId: row.target_id,
		detail: parseDetail(row.detail),
		createdAt: Number(row.created_at)
	};
}

export const AUDIT_PAGE_SIZE = 50;
const MAX_PAGE = 10_000;

/** Parses a 1-based page number from a query string value (invalid → 1). */
export function parsePage(value: string | null): number {
	if (!value || !/^\d{1,5}$/.test(value)) return 1;
	return Math.min(Math.max(Number(value), 1), MAX_PAGE);
}

export interface AuditPage {
	rows: AuditRow[];
	page: number;
	pageSize: number;
	total: number;
	pages: number;
}

/** Newest first, `pageSize` rows per page; optionally only rows about one target. */
export async function listAudit(
	db: D1Database,
	options: { page?: number; pageSize?: number; targetId?: string | null } = {}
): Promise<AuditPage> {
	const pageSize = Math.min(Math.max(options.pageSize ?? AUDIT_PAGE_SIZE, 1), 200);
	const page = Math.min(Math.max(options.page ?? 1, 1), MAX_PAGE);
	const offset = (page - 1) * pageSize;
	const targetId = options.targetId ?? null;
	const columns =
		'SELECT id, actor_id, actor_kind, action, target_kind, target_id, detail, created_at FROM audit_log';
	const [rows, count] = await Promise.all([
		targetId
			? all<AuditDbRow>(
					sql(
						db,
						`${columns} WHERE target_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
						targetId,
						pageSize,
						offset
					)
				)
			: all<AuditDbRow>(
					sql(db, `${columns} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, pageSize, offset)
				),
		targetId
			? first<{ n: number }>(
					sql(db, 'SELECT COUNT(*) AS n FROM audit_log WHERE target_id = ?', targetId)
				)
			: first<{ n: number }>(sql(db, 'SELECT COUNT(*) AS n FROM audit_log'))
	]);
	const total = Number(count?.n ?? 0);
	return {
		rows: rows.map(toRow),
		page,
		pageSize,
		total,
		pages: Math.max(1, Math.ceil(total / pageSize))
	};
}
