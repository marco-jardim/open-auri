// Social repository (T4.1): the ONLY data-access point for the social tables of migrations
// 0004-0006. Every query is parametrized through `sql()`; multi-statement writes go through
// `batch()` (atomic). Visibility is applied in every read:
//   - lists (feed, rankings, profiles, packs of others, counts) only return PUBLICLY LISTABLE
//     lineages (publicLineageSql): public, active, not moderated, head curve passed the gate,
//     owner not banned. Private lineages never appear in a list; unlisted ones neither.
//   - reads by id use readableLineageSql: public or unlisted (same other rules), or the viewer's
//     own lineage (any state), or anything for an explicit admin viewer.
//   - the only owner-scoped lists (listOwnLineages, listOwnPacks, listOwnShares, listOwnTrades,
//     listOwnActivity) filter by the caller's user id, which services take from the session.
// W4.2 services must not query social tables directly: new queries go in social/queries/*.ts and
// reuse the predicates exported here (see README.md).
import type { D1Database, D1Result } from '@cloudflare/workers-types';
import { LABEL_COUNT, LABEL_MAX } from 'open-auri/share';
import { all, batch, first, run, sql, type BoundStatement, type SqlParam } from '#lib/server/db.ts';
import {
	ACTIVITY_KINDS,
	AUDIENCE_NAMES_MAX,
	DESCRIPTION_MAX,
	LABELS_JSON_MAX,
	LANGS,
	LICENSES,
	LINEAGE_VISIBILITIES,
	LOOKUP_IDS_MAX,
	MODERATION_STATES,
	NAME_MAX,
	NOTE_MAX,
	PACK_ITEMS_MAX,
	PAGE_SIZE_DEFAULT,
	PAGE_SIZE_MAX,
	RANKING_MAX_ROWS,
	RANKING_METRICS,
	RANKING_WINDOW_MS,
	RANKING_WINDOWS,
	RECIPE_MAX,
	REPORT_REASONS,
	REPORT_RESOLUTIONS,
	REPORT_TARGET_KINDS,
	S6_CHOICES,
	S6_PAIRS_MAX,
	SHARE_EVENT_KINDS,
	SHARE_USER_EVENT_KINDS,
	SocialRepoError,
	TRADE_TTL_MS,
	isOneOf,
	type ActivityKind,
	type ActivityRecord,
	type AppendVersionInput,
	type Audience,
	type AudienceGroup,
	type AuthorCredit,
	type CurveInput,
	type CurveRecord,
	type Lang,
	type LibraryEntry,
	type License,
	type LineageListFilter,
	type LineageRecord,
	type LineageStatus,
	type LineageSummary,
	type LineageVisibility,
	type ModerationState,
	type Page,
	type PageRequest,
	type PackInput,
	type PackItem,
	type PackRecord,
	type PackView,
	type PackVisibility,
	type PairResult,
	type PublicCounts,
	type PublicProfile,
	type PublishInput,
	type RankingEntry,
	type RankingMetric,
	type RankingWindow,
	type ReportInput,
	type ReportQueueEntry,
	type ReportRecord,
	type ReportResolution,
	type ReportTargetKind,
	type RepoResult,
	type S6BatchInput,
	type S6PairRecord,
	type ShareEventKind,
	type ShareRecord,
	type ShareStats,
	type SocialErrorCode,
	type TradeRecord,
	type TradeStatus,
	type TradeView,
	type VersionInput,
	type VersionLabels,
	type VersionRecord,
	type Viewer
} from '#lib/server/social/types.ts';

// ---- Visibility predicates ------------------------------------------------------------------

/** A piece of SQL with its own positional parameters, in order. */
export interface SqlFragment {
	readonly text: string;
	readonly params: readonly SqlParam[];
}

const ALIAS = /^[a-z][a-z0-9_]{0,15}$/;

/** Aliases are interpolated into SQL text, so they are checked against a strict pattern. */
function alias(name: string): string {
	if (!ALIAS.test(name)) throw new Error(`Invalid SQL alias: ${name}`);
	return name;
}

/** A "user" row counted in public numbers: verified e-mail and not banned. */
export function countedUserSql(userAlias: string): string {
	const u = alias(userAlias);
	return `(${u}."emailVerified" = 1 AND COALESCE(${u}."banned", 0) = 0)`;
}

/** The owner (column owner_user_id of a lineage or pack) is not banned, or was anonymized. */
export function ownerNotBannedSql(rowAlias: string): string {
	const a = alias(rowAlias);
	return (
		`(${a}.owner_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM "user" ${a}_ou ` +
		`WHERE ${a}_ou."id" = ${a}.owner_user_id AND COALESCE(${a}_ou."banned", 0) = 1))`
	);
}

/** The head version of the lineage references a curve that passed the gate. */
export function headGateOkSql(lineageAlias: string): string {
	const a = alias(lineageAlias);
	return (
		`EXISTS (SELECT 1 FROM versions ${a}_hv JOIN curves ${a}_hc ON ${a}_hc.id = ${a}_hv.curve_id ` +
		`WHERE ${a}_hv.id = ${a}.head_version AND ${a}_hc.gate_ok = 1)`
	);
}

/** Publicly LISTABLE lineage: the only lineages any list (feed, ranking, profile, pack) shows. */
export function publicLineageSql(lineageAlias: string): string {
	const a = alias(lineageAlias);
	return (
		`(${a}.visibility = 'public' AND ${a}.status = 'active' AND ${a}.moderation = 'visible' ` +
		`AND ${headGateOkSql(a)} AND ${ownerNotBannedSql(a)})`
	);
}

/** Readable by anyone who has the id: public or unlisted, with the other public rules. */
export function linkableLineageSql(lineageAlias: string): string {
	const a = alias(lineageAlias);
	return (
		`(${a}.visibility IN ('public', 'unlisted') AND ${a}.status = 'active' ` +
		`AND ${a}.moderation = 'visible' AND ${headGateOkSql(a)} AND ${ownerNotBannedSql(a)})`
	);
}

/**
 * Every rule of publicLineageSql (`listing`) or linkableLineageSql except the head gate verdict.
 * Only for the gate-cache helpers (re-gate decisions, #27); never to serve a lineage.
 */
function openExceptHeadGateSql(lineageAlias: string, listing: boolean): string {
	const a = alias(lineageAlias);
	const visibility = listing
		? `${a}.visibility = 'public'`
		: `${a}.visibility IN ('public', 'unlisted')`;
	return (
		`(${visibility} AND ${a}.status = 'active' AND ${a}.moderation = 'visible' ` +
		`AND ${ownerNotBannedSql(a)})`
	);
}

/** The viewer owns the row (lineage or pack), or is an explicit admin. */
export function ownerOrAdminSql(rowAlias: string, viewer: Viewer): SqlFragment {
	const a = alias(rowAlias);
	if (viewer.admin === true) return { text: '1 = 1', params: [] };
	if (typeof viewer.userId === 'string' && viewer.userId !== '') {
		return { text: `${a}.owner_user_id = ?`, params: [viewer.userId] };
	}
	return { text: '0 = 1', params: [] };
}

/** Readable by id for `viewer`: linkable, or the viewer's own (any state), or admin. */
export function readableLineageSql(lineageAlias: string, viewer: Viewer): SqlFragment {
	const own = ownerOrAdminSql(lineageAlias, viewer);
	return { text: `(${linkableLineageSql(lineageAlias)} OR ${own.text})`, params: own.params };
}

export function publicPackSql(packAlias: string): string {
	const a = alias(packAlias);
	return `(${a}.visibility = 'public' AND ${a}.moderation = 'visible' AND ${ownerNotBannedSql(a)})`;
}

export function readablePackSql(packAlias: string, viewer: Viewer): SqlFragment {
	const a = alias(packAlias);
	const own = ownerOrAdminSql(a, viewer);
	return {
		text:
			`((${a}.visibility IN ('public', 'unlisted') AND ${a}.moderation = 'visible' ` +
			`AND ${ownerNotBannedSql(a)}) OR ${own.text})`,
		params: own.params
	};
}

/** Facts about a lineage needed to decide visibility outside SQL. */
export interface VisibilityFacts {
	ownerUserId: string | null;
	visibility: LineageVisibility;
	status: LineageStatus;
	moderation: ModerationState;
	headGateOk: boolean;
	ownerBanned: boolean;
}

/** Same rules as readableLineageSql (and publicLineageSql when `listing` is true). */
export function canViewLineage(facts: VisibilityFacts, viewer: Viewer, listing = false): boolean {
	const open =
		facts.status === 'active' &&
		facts.moderation === 'visible' &&
		facts.headGateOk &&
		!facts.ownerBanned &&
		(listing ? facts.visibility === 'public' : facts.visibility !== 'private');
	if (listing) return open;
	if (open || viewer.admin === true) return true;
	return viewer.userId !== null && viewer.userId !== '' && facts.ownerUserId === viewer.userId;
}

// ---- Keyset pagination ----------------------------------------------------------------------

export type CursorPart = string | number;
export type CursorShape = readonly ('string' | 'number')[];
/** One decoded part per shape entry (a tuple when the shape is a literal). */
export type CursorParts<S extends CursorShape> = { -readonly [K in keyof S]: CursorPart };

const CURSOR_MAX = 512;

/** Opaque cursor: base64url (no padding) of the JSON array of the last row's sort key. */
export function encodeCursor(parts: readonly CursorPart[]): string {
	let binary = '';
	for (const byte of new TextEncoder().encode(JSON.stringify(parts))) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes and validates a cursor against `shape`; null for no cursor, throws 'invalid-cursor'. */
export function decodeCursor<const S extends CursorShape>(
	cursor: string | null | undefined,
	shape: S
): CursorParts<S> | null {
	if (cursor === null || cursor === undefined || cursor === '') return null;
	if (cursor.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
		throw new SocialRepoError('invalid-cursor');
	}
	let parsed: unknown;
	try {
		const binary = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		throw new SocialRepoError('invalid-cursor');
	}
	if (!Array.isArray(parsed) || parsed.length !== shape.length) {
		throw new SocialRepoError('invalid-cursor');
	}
	const values: unknown[] = parsed;
	const parts: CursorPart[] = [];
	shape.forEach((kind, index) => {
		const value = values[index];
		if (kind === 'number' && typeof value === 'number' && Number.isSafeInteger(value)) {
			parts.push(value);
		} else if (kind === 'string' && typeof value === 'string' && value.length <= 128) {
			parts.push(value);
		} else {
			throw new SocialRepoError('invalid-cursor');
		}
	});
	return parts as CursorParts<S>;
}

/** Page size within [1, PAGE_SIZE_MAX]; anything invalid gives PAGE_SIZE_DEFAULT. */
export function clampPageSize(limit: number | undefined | null): number {
	if (typeof limit !== 'number' || !Number.isFinite(limit)) return PAGE_SIZE_DEFAULT;
	return Math.min(Math.max(Math.trunc(limit), 1), PAGE_SIZE_MAX);
}

function toPage<R, T>(
	rows: R[],
	size: number,
	map: (row: R) => T,
	key: (row: R) => CursorPart[]
): Page<T> {
	const more = rows.length > size;
	const kept = more ? rows.slice(0, size) : rows;
	const last = kept[kept.length - 1];
	return {
		items: kept.map(map),
		nextCursor: more && last !== undefined ? encodeCursor(key(last)) : null
	};
}

const NO_FILTER: SqlFragment = { text: '1 = 1', params: [] };

/** Keyset for ORDER BY first DESC, second DESC. Columns are internal constants. */
function before2(
	first: string,
	second: string,
	cursor: readonly [CursorPart, CursorPart] | null
): SqlFragment {
	if (!cursor) return NO_FILTER;
	return {
		text: `(${first} < ? OR (${first} = ? AND ${second} < ?))`,
		params: [cursor[0], cursor[0], cursor[1]]
	};
}

// ---- Rows and mapping -----------------------------------------------------------------------

interface LineageCols {
	l_id: string;
	l_owner: string | null;
	l_forked: string | null;
	l_head: string | null;
	l_visibility: string;
	l_status: string;
	l_moderation: string;
	l_curated: number;
	l_created: number;
	l_updated: number;
}

interface VersionCols {
	v_id: string;
	v_lineage: string;
	v_parent: string | null;
	v_curve: string;
	v_name: string;
	v_description: string;
	v_license: string;
	v_recipe: string | null;
	v_lang: string;
	v_labels: string | null;
	v_created: number;
}

interface CurveCols {
	c_id: string;
	c_s1: string;
	c_canon: string;
	c_gate_ver: string;
	c_gate_ok: number;
	c_gate_reasons: string;
	c_level: number | null;
	c_created: number;
}

interface AuthorCols {
	u_username: string | null;
	u_display: string | null;
}

type SummaryRow = LineageCols & VersionCols & CurveCols & AuthorCols;

const LINEAGE_COLUMNS =
	'l.id AS l_id, l.owner_user_id AS l_owner, l.forked_from_version AS l_forked, ' +
	'l.head_version AS l_head, l.visibility AS l_visibility, l.status AS l_status, ' +
	'l.moderation AS l_moderation, l.curated AS l_curated, l.created_at AS l_created, ' +
	'l.updated_at AS l_updated';
const VERSION_COLUMNS =
	'v.id AS v_id, v.lineage_id AS v_lineage, v.parent_id AS v_parent, v.curve_id AS v_curve, ' +
	'v.name AS v_name, v.description AS v_description, v.license AS v_license, ' +
	'v.recipe AS v_recipe, v.lang AS v_lang, v.labels AS v_labels, v.created_at AS v_created';
const CURVE_COLUMNS =
	'c.id AS c_id, c.s1 AS c_s1, c.canon_key AS c_canon, c.gate_ver AS c_gate_ver, ' +
	'c.gate_ok AS c_gate_ok, c.gate_reasons AS c_gate_reasons, c.level_db AS c_level, ' +
	'c.created_at AS c_created';
const SUMMARY_COLUMNS = `${LINEAGE_COLUMNS}, ${VERSION_COLUMNS}, ${CURVE_COLUMNS}, u."username" AS u_username, u."displayUsername" AS u_display`;
/** Joins from `lineages l` to its head version, head curve and author. */
const SUMMARY_JOINS =
	'JOIN versions v ON v.id = l.head_version JOIN curves c ON c.id = v.curve_id ' +
	'LEFT JOIN "user" u ON u."id" = l.owner_user_id';

function parseReasons(text: string): string[] {
	try {
		const value: unknown = JSON.parse(text);
		return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

function toLineage(row: LineageCols): LineageRecord {
	return {
		id: row.l_id,
		ownerUserId: row.l_owner,
		forkedFromVersion: row.l_forked,
		headVersion: row.l_head,
		visibility: row.l_visibility as LineageVisibility,
		status: row.l_status as LineageStatus,
		moderation: row.l_moderation as ModerationState,
		curated: row.l_curated === 1,
		createdAt: row.l_created,
		updatedAt: row.l_updated
	};
}

/** Ten entries, each null or a string of 1–LABEL_MAX code points. */
function isLabelList(value: unknown): value is VersionLabels {
	return (
		Array.isArray(value) &&
		value.length === LABEL_COUNT &&
		value.every(
			(label) =>
				label === null ||
				(typeof label === 'string' && textLength(label) >= 1 && textLength(label) <= LABEL_MAX)
		)
	);
}

/** `versions.labels` → labels; anything unreadable (or all null) reads as no labels. */
function parseLabels(text: string | null): VersionLabels | null {
	if (text === null) return null;
	try {
		const value: unknown = JSON.parse(text);
		return isLabelList(value) && value.some((label) => label !== null) ? value : null;
	} catch {
		return null;
	}
}

/** Labels → `versions.labels` JSON; null when there is none (an all-null list included). */
function labelsText(labels: VersionLabels | null | undefined): string | null {
	return labels && labels.some((label) => label !== null) ? JSON.stringify(labels) : null;
}

function toVersion(row: VersionCols): VersionRecord {
	return {
		id: row.v_id,
		lineageId: row.v_lineage,
		parentId: row.v_parent,
		curveId: row.v_curve,
		name: row.v_name,
		description: row.v_description,
		license: row.v_license as License,
		recipe: row.v_recipe,
		lang: row.v_lang as Lang,
		labels: parseLabels(row.v_labels),
		createdAt: row.v_created
	};
}

function toCurve(row: CurveCols): CurveRecord {
	return {
		id: row.c_id,
		s1: row.c_s1,
		canonKey: row.c_canon,
		gateVer: row.c_gate_ver,
		gateOk: row.c_gate_ok === 1,
		gateReasons: parseReasons(row.c_gate_reasons),
		levelDb: row.c_level,
		createdAt: row.c_created
	};
}

function toAuthor(row: AuthorCols): AuthorCredit | null {
	if (row.u_username === null) return null;
	return { username: row.u_username, displayUsername: row.u_display ?? row.u_username };
}

function toSummary(row: SummaryRow): LineageSummary {
	return { ...toLineage(row), author: toAuthor(row), head: toVersion(row), curve: toCurve(row) };
}

// ---- Validation and error mapping -----------------------------------------------------------

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const CURVE_ID = /^[a-z2-7]{12}$/;
const DAY = /^\d{4}-[01]\d-[0-3]\d$/;
const RECEIPT = /^[0-9a-f]{64}$/;
const S6_ITEM = /^[a-z0-9._-]{1,64}$/;
const CHANNEL = /^[a-z0-9-]{1,24}$/;

export function isSocialId(value: unknown): value is string {
	return typeof value === 'string' && ID.test(value);
}

/** Length as SQLite's length() counts it (code points). */
function textLength(value: string): number {
	return [...value].length;
}

function validName(value: unknown): value is string {
	return typeof value === 'string' && textLength(value) >= 1 && textLength(value) <= NAME_MAX;
}

function validDescription(value: unknown): value is string {
	return typeof value === 'string' && textLength(value) <= DESCRIPTION_MAX;
}

function validCurve(curve: CurveInput): boolean {
	return (
		CURVE_ID.test(curve.id) &&
		typeof curve.s1 === 'string' &&
		curve.s1.length === 68 &&
		typeof curve.canonKey === 'string' &&
		curve.canonKey.length >= 1 &&
		curve.canonKey.length <= 512 &&
		typeof curve.gateVer === 'string' &&
		curve.gateVer.length >= 1 &&
		curve.gateVer.length <= 64 &&
		typeof curve.gateOk === 'boolean' &&
		Array.isArray(curve.gateReasons) &&
		curve.gateReasons.every((reason) => typeof reason === 'string') &&
		(curve.levelDb === null || Number.isFinite(curve.levelDb))
	);
}

function validVersion(version: VersionInput): boolean {
	return (
		isSocialId(version.id) &&
		validName(version.name) &&
		validDescription(version.description) &&
		isOneOf(LICENSES, version.license) &&
		isOneOf(LANGS, version.lang) &&
		(version.recipe === null ||
			(typeof version.recipe === 'string' && version.recipe.length <= RECIPE_MAX)) &&
		validLabels(version.labels)
	);
}

/**
 * Absent, null or ten valid entries whose JSON fits the 0012 CHECK (length <= 1024). Exported so
 * the library merge refuses a list the insert would refuse before it spends any quota.
 */
export function validLabels(labels: unknown): boolean {
	if (labels === undefined || labels === null) return true;
	if (!isLabelList(labels)) return false;
	return textLength(JSON.stringify(labels)) <= LABELS_JSON_MAX;
}

/** Maps a constraint failure raised by D1 to a stable code; null for anything else. */
export function constraintCode(error: unknown): SocialErrorCode | null {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes('gate_rejected')) return 'gate-rejected';
	if (message.includes('head_not_child')) return 'head-moved';
	if (message.includes('UNIQUE constraint failed: versions.id')) return 'duplicate';
	if (message.includes('UNIQUE constraint failed: versions.')) return 'head-moved';
	if (message.includes('UNIQUE constraint failed: trades.user_id')) return 'already-active';
	if (message.includes('UNIQUE constraint failed')) return 'duplicate';
	if (message.includes('FOREIGN KEY constraint failed')) return 'not-found';
	if (message.includes('CHECK constraint failed')) return 'invalid-input';
	return null;
}

async function guarded<T = Record<string, unknown>>(
	db: D1Database,
	statements: BoundStatement[]
): Promise<{ ok: true; results: D1Result<T>[] } | { ok: false; code: SocialErrorCode }> {
	try {
		return { ok: true, results: await batch<T>(db, statements) };
	} catch (error) {
		const code = constraintCode(error);
		if (code === null) throw error;
		return { ok: false, code };
	}
}

function changes(result: { readonly meta: { readonly changes: number } } | undefined): number {
	return result?.meta.changes ?? 0;
}

function idList(ids: readonly string[]): string {
	if (ids.length > LOOKUP_IDS_MAX) throw new SocialRepoError('limit');
	return JSON.stringify(ids.filter((id) => typeof id === 'string'));
}

// ---- Curves ---------------------------------------------------------------------------------

const GATE_VER_COLUMN = /^[a-z][a-z0-9_]{0,15}\.gate_ver$/;

/**
 * SQL expression of the GATE_IMPL ordinal stored in a gate_ver column (`<alias>.gate_ver`):
 * N for `v2.N:<hash>`, 0 for anything else (legacy `v2:<hash>`). Same rule as `gateImplOf` in
 * gate.ts.
 */
export function gateImplSql(column: string): string {
	if (!GATE_VER_COLUMN.test(column)) throw new Error(`Invalid gate_ver column: ${column}`);
	return (
		`(CASE WHEN ${column} LIKE 'v2.%:%' ` +
		`THEN CAST(substr(${column}, 4, instr(${column}, ':') - 4) AS INTEGER) ELSE 0 END)`
	);
}

/**
 * Inserts the curve or refreshes its gate cache when it was computed by another gate version
 * (same gate_ver: the stored result stands). Monotonic: a row cached by a newer gate
 * implementation (greater GATE_IMPL ordinal) is never overwritten by an older writer, so an older
 * isolate during a deploy cannot flip a curve back to a stale verdict.
 */
export function upsertCurveStatement(
	db: D1Database,
	curve: CurveInput,
	now: number
): BoundStatement {
	return sql(
		db,
		'INSERT INTO curves (id, s1, canon_key, gate_ver, gate_ok, gate_reasons, level_db, created_at) ' +
			'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET gate_ver = excluded.gate_ver, ' +
			'gate_ok = excluded.gate_ok, gate_reasons = excluded.gate_reasons, level_db = excluded.level_db ' +
			'WHERE curves.gate_ver IS NOT excluded.gate_ver ' +
			`AND ${gateImplSql('curves.gate_ver')} <= ${gateImplSql('excluded.gate_ver')}`,
		curve.id,
		curve.s1,
		curve.canonKey,
		curve.gateVer,
		curve.gateOk ? 1 : 0,
		JSON.stringify(curve.gateReasons),
		curve.levelDb,
		now
	);
}

export async function saveCurveGate(
	db: D1Database,
	curve: CurveInput,
	now: number
): Promise<RepoResult<CurveRecord>> {
	if (!validCurve(curve)) return { ok: false, code: 'invalid-input' };
	const saved = await guarded(db, [upsertCurveStatement(db, curve, now)]);
	if (!saved.ok) return saved;
	const stored = await getCurve(db, curve.id);
	return stored ? { ok: true, value: stored } : { ok: false, code: 'not-found' };
}

export async function getCurve(db: D1Database, curveId: string): Promise<CurveRecord | null> {
	const row = await first<CurveCols>(
		sql(db, `SELECT ${CURVE_COLUMNS} FROM curves c WHERE c.id = ?`, curveId)
	);
	return row ? toCurve(row) : null;
}

/** Curves whose cached gate result comes from another gate version, oldest first. */
export async function listCurvesWithStaleGate(
	db: D1Database,
	gateVer: string,
	limit = 100
): Promise<CurveRecord[]> {
	const rows = await all<CurveCols>(
		sql(
			db,
			`SELECT ${CURVE_COLUMNS} FROM curves c WHERE c.gate_ver <> ? ORDER BY c.created_at, c.id LIMIT ?`,
			gateVer,
			Math.min(Math.max(Math.trunc(limit), 1), 1000)
		)
	);
	return rows.map(toCurve);
}

/**
 * Stale curves for the re-gate job: cached under another gate version by a GATE_IMPL ordinal not
 * greater than `gateImpl` (rows of a newer implementation are current for a newer isolate), in
 * priority order: (0) accepted heads of linkable lineages (served by link and in lists: a head
 * the current gate rejects must stop being served first), (1) rejected heads of lineages publicly
 * listable apart from that verdict (a relaxed gate brings them back to the lists; by-id reads
 * re-gate them on their own, #27), (2) everything else. Oldest first within a tier. At most 1000.
 */
export async function listStaleCurvesForRegate(
	db: D1Database,
	gateVer: string,
	limit: number,
	gateImpl: number
): Promise<CurveRecord[]> {
	const headOf = (rule: (lineageAlias: string) => string, l: string, v: string): string =>
		`EXISTS (SELECT 1 FROM lineages ${alias(l)} JOIN versions ${alias(v)} ` +
		`ON ${v}.id = ${l}.head_version WHERE ${v}.curve_id = c.id AND ${rule(l)})`;
	const rows = await all<CurveCols>(
		sql(
			db,
			`SELECT ${CURVE_COLUMNS} FROM curves c ` +
				`WHERE c.gate_ver <> ? AND ${gateImplSql('c.gate_ver')} <= ? ORDER BY CASE ` +
				`WHEN c.gate_ok = 1 AND ${headOf(linkableLineageSql, 'pl', 'pv')} THEN 0 ` +
				`WHEN c.gate_ok = 0 AND ${headOf((l) => openExceptHeadGateSql(l, true), 'rl', 'rv')} ` +
				'THEN 1 ELSE 2 END, c.created_at, c.id LIMIT ?',
			gateVer,
			gateImpl,
			Math.min(Math.max(Math.trunc(limit), 1), 1000)
		)
	);
	return rows.map(toCurve);
}

/** Cached gate verdict of one curve, without its content (see getHeadGateState). */
export interface GateState {
	curveId: string;
	gateVer: string;
	gateOk: boolean;
}

/** Gate states of a version's own curve and of its lineage's head (see getVersionGateState). */
export interface VersionGateState {
	curve: GateState;
	head: GateState;
}

/**
 * Cached gate state (gate_ver, gate_ok) of the head curve of `lineageId`, read WHATEVER its
 * gate_ok, when the lineage is linkable apart from the head verdict (public or unlisted, active,
 * not moderated, owner not banned); null otherwise (unknown, private, retracted, moderated,
 * banned owner). The readable rows hide a head cached as rejected, so the by-id reads use this,
 * and only this, to decide whether such a head is re-gated (#27). It carries no content and must
 * never be used to serve one.
 */
export async function getHeadGateState(
	db: D1Database,
	lineageId: string
): Promise<GateState | null> {
	if (!isSocialId(lineageId)) return null;
	const row = await first<{ curve_id: string; gate_ver: string; gate_ok: number }>(
		sql(
			db,
			'SELECT c.id AS curve_id, c.gate_ver AS gate_ver, c.gate_ok AS gate_ok FROM lineages l ' +
				'JOIN versions v ON v.id = l.head_version JOIN curves c ON c.id = v.curve_id ' +
				`WHERE l.id = ? AND ${openExceptHeadGateSql('l', false)}`,
			lineageId
		)
	);
	return row ? { curveId: row.curve_id, gateVer: row.gate_ver, gateOk: row.gate_ok === 1 } : null;
}

/**
 * Same as getHeadGateState for a version id: the cached gate states of the version's own curve
 * and of its lineage's head, under the same lineage rule (null otherwise). Re-gate decisions only.
 */
export async function getVersionGateState(
	db: D1Database,
	versionId: string
): Promise<VersionGateState | null> {
	if (!isSocialId(versionId)) return null;
	const row = await first<{
		c_id: string;
		c_ver: string;
		c_ok: number;
		h_id: string;
		h_ver: string;
		h_ok: number;
	}>(
		sql(
			db,
			'SELECT c.id AS c_id, c.gate_ver AS c_ver, c.gate_ok AS c_ok, hc.id AS h_id, ' +
				'hc.gate_ver AS h_ver, hc.gate_ok AS h_ok FROM versions v ' +
				'JOIN lineages l ON l.id = v.lineage_id JOIN curves c ON c.id = v.curve_id ' +
				'JOIN versions hv ON hv.id = l.head_version JOIN curves hc ON hc.id = hv.curve_id ' +
				`WHERE v.id = ? AND ${openExceptHeadGateSql('l', false)}`,
			versionId
		)
	);
	if (!row) return null;
	return {
		curve: { curveId: row.c_id, gateVer: row.c_ver, gateOk: row.c_ok === 1 },
		head: { curveId: row.h_id, gateVer: row.h_ver, gateOk: row.h_ok === 1 }
	};
}

// ---- Lineages and versions: writes ----------------------------------------------------------

function insertVersionStatement(
	db: D1Database,
	lineageId: string,
	curveId: string,
	version: VersionInput,
	now: number
): BoundStatement {
	return sql(
		db,
		'INSERT INTO versions (id, lineage_id, parent_id, curve_id, name, description, license, ' +
			'recipe, lang, labels, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
		version.id,
		lineageId,
		curveId,
		version.name,
		version.description,
		version.license,
		version.recipe,
		version.lang,
		labelsText(version.labels),
		now
	);
}

/**
 * Publishes a new lineage with its root version (and caches the curve) in one batch. A curve
 * rejected by the gate is cached and refused with 'gate-rejected'; the database trigger refuses it
 * too. `forkedFromVersion` is set by forkLineage only.
 */
export async function publishLineage(
	db: D1Database,
	input: PublishInput
): Promise<RepoResult<{ lineageId: string; versionId: string }>> {
	if (
		!isSocialId(input.lineageId) ||
		!isSocialId(input.ownerUserId) ||
		!isOneOf(LINEAGE_VISIBILITIES, input.visibility) ||
		!validCurve(input.curve) ||
		!validVersion(input.version)
	) {
		return { ok: false, code: 'invalid-input' };
	}
	if (!input.curve.gateOk) {
		await run(upsertCurveStatement(db, input.curve, input.now));
		return { ok: false, code: 'gate-rejected' };
	}
	const done = await guarded(db, [
		upsertCurveStatement(db, input.curve, input.now),
		sql(
			db,
			'INSERT INTO lineages (id, owner_user_id, forked_from_version, head_version, visibility, ' +
				"status, moderation, curated, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 'active', " +
				"'visible', 0, ?, ?)",
			input.lineageId,
			input.ownerUserId,
			input.forkedFromVersion ?? null,
			input.visibility,
			input.now,
			input.now
		),
		insertVersionStatement(db, input.lineageId, input.curve.id, input.version, input.now),
		sql(db, 'UPDATE lineages SET head_version = ? WHERE id = ?', input.version.id, input.lineageId)
	]);
	if (!done.ok) return done;
	return { ok: true, value: { lineageId: input.lineageId, versionId: input.version.id } };
}

/** Forks a version the new owner can read (same publication path, so the same gate rules). */
export async function forkLineage(
	db: D1Database,
	sourceVersionId: string,
	input: Omit<PublishInput, 'forkedFromVersion'>
): Promise<RepoResult<{ lineageId: string; versionId: string }>> {
	const source = await getVersionForViewer(db, sourceVersionId, { userId: input.ownerUserId });
	if (!source) return { ok: false, code: 'not-found' };
	return publishLineage(db, { ...input, forkedFromVersion: sourceVersionId });
}

/**
 * Appends a version to the owner's active lineage. The new version's parent is the current head,
 * which must equal `expectedHead`: otherwise 'head-moved' (two concurrent appends: one wins, the
 * other fails atomically on UNIQUE (lineage_id, parent_id)).
 */
export async function appendVersion(
	db: D1Database,
	input: AppendVersionInput
): Promise<RepoResult<{ versionId: string }>> {
	if (
		!isSocialId(input.lineageId) ||
		!isSocialId(input.expectedHead) ||
		!validCurve(input.curve) ||
		!validVersion(input.version)
	) {
		return { ok: false, code: 'invalid-input' };
	}
	if (!input.curve.gateOk) {
		await run(upsertCurveStatement(db, input.curve, input.now));
		return { ok: false, code: 'gate-rejected' };
	}
	const { version } = input;
	const done = await guarded(db, [
		upsertCurveStatement(db, input.curve, input.now),
		sql(
			db,
			'INSERT INTO versions (id, lineage_id, parent_id, curve_id, name, description, license, ' +
				'recipe, lang, labels, created_at) SELECT ?, l.id, l.head_version, ?, ?, ?, ?, ?, ?, ?, ? ' +
				"FROM lineages l WHERE l.id = ? AND l.owner_user_id = ? AND l.head_version = ? AND l.status = 'active'",
			version.id,
			input.curve.id,
			version.name,
			version.description,
			version.license,
			version.recipe,
			version.lang,
			labelsText(version.labels),
			input.now,
			input.lineageId,
			input.ownerUserId,
			input.expectedHead
		),
		sql(
			db,
			'UPDATE lineages SET head_version = ?, updated_at = ? WHERE id = ? AND head_version = ? ' +
				'AND EXISTS (SELECT 1 FROM versions WHERE id = ? AND lineage_id = ?)',
			version.id,
			input.now,
			input.lineageId,
			input.expectedHead,
			version.id,
			input.lineageId
		)
	]);
	if (!done.ok) return done;
	if (changes(done.results[2]) === 1) return { ok: true, value: { versionId: version.id } };
	const lineage = await first<{
		owner_user_id: string | null;
		head_version: string;
		status: string;
	}>(
		sql(
			db,
			'SELECT owner_user_id, head_version, status FROM lineages WHERE id = ?',
			input.lineageId
		)
	);
	if (!lineage || lineage.owner_user_id !== input.ownerUserId)
		return { ok: false, code: 'not-found' };
	if (lineage.status !== 'active') return { ok: false, code: 'retracted' };
	return { ok: false, code: 'head-moved' };
}

async function updateOwnedLineage(
	db: D1Database,
	statement: BoundStatement
): Promise<RepoResult<{ changed: true }>> {
	const meta = await run(statement);
	return meta.changes > 0
		? { ok: true, value: { changed: true } }
		: { ok: false, code: 'not-found' };
}

/** Owner tombstone. Idempotent; 'not-found' when the lineage is not the owner's. */
export async function retractLineage(
	db: D1Database,
	lineageId: string,
	ownerUserId: string,
	now: number
): Promise<RepoResult<{ changed: true }>> {
	return updateOwnedLineage(
		db,
		sql(
			db,
			"UPDATE lineages SET status = 'retracted', updated_at = ? WHERE id = ? AND owner_user_id = ?",
			now,
			lineageId,
			ownerUserId
		)
	);
}

/** Undoes the owner's tombstone (never a moderation action). */
export async function restoreLineage(
	db: D1Database,
	lineageId: string,
	ownerUserId: string,
	now: number
): Promise<RepoResult<{ changed: true }>> {
	return updateOwnedLineage(
		db,
		sql(
			db,
			"UPDATE lineages SET status = 'active', updated_at = ? WHERE id = ? AND owner_user_id = ?",
			now,
			lineageId,
			ownerUserId
		)
	);
}

export async function setLineageVisibility(
	db: D1Database,
	lineageId: string,
	ownerUserId: string,
	visibility: LineageVisibility,
	now: number
): Promise<RepoResult<{ changed: true }>> {
	if (!isOneOf(LINEAGE_VISIBILITIES, visibility)) return { ok: false, code: 'invalid-input' };
	return updateOwnedLineage(
		db,
		sql(
			db,
			'UPDATE lineages SET visibility = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?',
			visibility,
			now,
			lineageId,
			ownerUserId
		)
	);
}

/**
 * Moderation state of a lineage or pack (admin and auto-hide). With `expected`, only changes a row
 * currently in that state (auto-hide passes 'visible' so it never overrides an admin decision).
 */
export async function setModeration(
	db: D1Database,
	target: 'lineage' | 'pack',
	id: string,
	moderation: ModerationState,
	now: number,
	expected: ModerationState | null = null
): Promise<boolean> {
	if (!isOneOf(MODERATION_STATES, moderation)) throw new SocialRepoError('invalid-input');
	const statement =
		target === 'lineage'
			? sql(
					db,
					'UPDATE lineages SET moderation = ?, updated_at = ? WHERE id = ? AND (? IS NULL OR moderation = ?)',
					moderation,
					now,
					id,
					expected,
					expected
				)
			: sql(
					db,
					'UPDATE packs SET moderation = ?, updated_at = ? WHERE id = ? AND (? IS NULL OR moderation = ?)',
					moderation,
					now,
					id,
					expected,
					expected
				);
	return (await run(statement)).changes > 0;
}

export async function setCurated(
	db: D1Database,
	lineageId: string,
	curated: boolean,
	now: number
): Promise<boolean> {
	const meta = await run(
		sql(
			db,
			'UPDATE lineages SET curated = ?, updated_at = ? WHERE id = ?',
			curated ? 1 : 0,
			now,
			lineageId
		)
	);
	return meta.changes > 0;
}

/** Versions created in the owner's lineages since `since` (daily publication quota). */
export async function countVersionsSince(
	db: D1Database,
	ownerUserId: string,
	since: number
): Promise<number> {
	const row = await first<{ n: number }>(
		sql(
			db,
			'SELECT count(*) AS n FROM versions v JOIN lineages l ON l.id = v.lineage_id ' +
				'WHERE l.owner_user_id = ? AND v.created_at >= ?',
			ownerUserId,
			since
		)
	);
	return row?.n ?? 0;
}

// ---- Lineages and versions: reads -----------------------------------------------------------

export async function getLineageForViewer(
	db: D1Database,
	lineageId: string,
	viewer: Viewer
): Promise<LineageSummary | null> {
	const readable = readableLineageSql('l', viewer);
	const row = await first<SummaryRow>(
		sql(
			db,
			`SELECT ${SUMMARY_COLUMNS} FROM lineages l ${SUMMARY_JOINS} WHERE l.id = ? AND ${readable.text}`,
			lineageId,
			...readable.params
		)
	);
	return row ? toSummary(row) : null;
}

export interface VersionView {
	version: VersionRecord;
	curve: CurveRecord;
	lineage: LineageRecord;
}

/**
 * A version (any, not only the head) if its lineage is readable by `viewer`; for anyone but the
 * owner or an admin its own curve must also have passed the gate.
 */
export async function getVersionForViewer(
	db: D1Database,
	versionId: string,
	viewer: Viewer
): Promise<VersionView | null> {
	const readable = readableLineageSql('l', viewer);
	const own = ownerOrAdminSql('l', viewer);
	const row = await first<LineageCols & VersionCols & CurveCols>(
		sql(
			db,
			`SELECT ${LINEAGE_COLUMNS}, ${VERSION_COLUMNS}, ${CURVE_COLUMNS} FROM versions v ` +
				'JOIN lineages l ON l.id = v.lineage_id JOIN curves c ON c.id = v.curve_id ' +
				`WHERE v.id = ? AND ${readable.text} AND (c.gate_ok = 1 OR ${own.text})`,
			versionId,
			...readable.params,
			...own.params
		)
	);
	return row ? { version: toVersion(row), curve: toCurve(row), lineage: toLineage(row) } : null;
}

/** History of a readable lineage, newest first. */
export async function listVersions(
	db: D1Database,
	lineageId: string,
	viewer: Viewer,
	page: PageRequest = {}
): Promise<Page<VersionRecord> | null> {
	const lineage = await getLineageForViewer(db, lineageId, viewer);
	if (!lineage) return null;
	const size = clampPageSize(page.limit);
	const keyset = before2('v.created_at', 'v.id', decodeCursor(page.cursor, ['number', 'string']));
	const rows = await all<VersionCols>(
		sql(
			db,
			`SELECT ${VERSION_COLUMNS} FROM versions v WHERE v.lineage_id = ? AND ${keyset.text} ` +
				'ORDER BY v.created_at DESC, v.id DESC LIMIT ?',
			lineageId,
			...keyset.params,
			size + 1
		)
	);
	return toPage(rows, size, toVersion, (row) => [row.v_created, row.v_id]);
}

/** Public feed, newest first (sort 'new'; the ranked sorts read listRankings). */
export async function listPublicFeed(
	db: D1Database,
	page: PageRequest = {}
): Promise<Page<LineageSummary>> {
	const size = clampPageSize(page.limit);
	const keyset = before2('l.created_at', 'l.id', decodeCursor(page.cursor, ['number', 'string']));
	const rows = await all<SummaryRow>(
		sql(
			db,
			`SELECT ${SUMMARY_COLUMNS} FROM lineages l ${SUMMARY_JOINS} ` +
				`WHERE ${publicLineageSql('l')} AND ${keyset.text} ` +
				'ORDER BY l.created_at DESC, l.id DESC LIMIT ?',
			...keyset.params,
			size + 1
		)
	);
	return toPage(rows, size, toSummary, (row) => [row.l_created, row.l_id]);
}

/**
 * The caller's own creations, every visibility and state (the owner-scoped exception to "lists
 * never show private lineages"). `ownerUserId` must come from the session.
 */
export async function listOwnLineages(
	db: D1Database,
	ownerUserId: string,
	page: PageRequest & LineageListFilter = {}
): Promise<Page<LineageSummary>> {
	const size = clampPageSize(page.limit);
	const visibility = page.visibility ?? null;
	if (visibility !== null && !isOneOf(LINEAGE_VISIBILITIES, visibility)) {
		throw new SocialRepoError('invalid-input');
	}
	const keyset = before2('l.created_at', 'l.id', decodeCursor(page.cursor, ['number', 'string']));
	const rows = await all<SummaryRow>(
		sql(
			db,
			`SELECT ${SUMMARY_COLUMNS} FROM lineages l ${SUMMARY_JOINS} ` +
				`WHERE l.owner_user_id = ? AND (? IS NULL OR l.visibility = ?) AND ${keyset.text} ` +
				'ORDER BY l.created_at DESC, l.id DESC LIMIT ?',
			ownerUserId,
			visibility,
			visibility,
			...keyset.params,
			size + 1
		)
	);
	return toPage(rows, size, toSummary, (row) => [row.l_created, row.l_id]);
}

/** Lineages whose head is `curveId`: publicly listable ones plus the viewer's own. */
export async function listLineagesByCurve(
	db: D1Database,
	curveId: string,
	viewer: Viewer,
	limit = PAGE_SIZE_DEFAULT
): Promise<LineageSummary[]> {
	const own = ownerOrAdminSql('l', viewer);
	const rows = await all<SummaryRow>(
		sql(
			db,
			`SELECT ${SUMMARY_COLUMNS} FROM lineages l ${SUMMARY_JOINS} ` +
				`WHERE v.curve_id = ? AND (${publicLineageSql('l')} OR ${own.text}) ` +
				'ORDER BY l.created_at DESC, l.id DESC LIMIT ?',
			curveId,
			...own.params,
			clampPageSize(limit)
		)
	);
	return rows.map(toSummary);
}

/** The owner's lineages having a version with one of these curve ids or canonical keys. */
export async function findOwnLineagesByCurves(
	db: D1Database,
	ownerUserId: string,
	match: { curveIds: readonly string[]; canonKeys: readonly string[] }
): Promise<{ lineageId: string; curveId: string; canonKey: string }[]> {
	const rows = await all<{ lineage_id: string; curve_id: string; canon_key: string }>(
		sql(
			db,
			'SELECT DISTINCT l.id AS lineage_id, c.id AS curve_id, c.canon_key AS canon_key ' +
				'FROM lineages l JOIN versions v ON v.lineage_id = l.id JOIN curves c ON c.id = v.curve_id ' +
				'WHERE l.owner_user_id = ? AND (c.id IN (SELECT value FROM json_each(?)) ' +
				'OR c.canon_key IN (SELECT value FROM json_each(?))) ORDER BY l.id, c.id',
			ownerUserId,
			idList(match.curveIds),
			idList(match.canonKeys)
		)
	);
	return rows.map((row) => ({
		lineageId: row.lineage_id,
		curveId: row.curve_id,
		canonKey: row.canon_key
	}));
}

/**
 * Filter labels of the head version of each of the owner's lineages among `lineageIds` (others
 * are absent; a head without labels, or with unreadable ones, maps to null). Owner-scoped: the
 * user id must come from the session.
 */
export async function ownHeadLabels(
	db: D1Database,
	ownerUserId: string,
	lineageIds: readonly string[]
): Promise<Map<string, VersionLabels | null>> {
	const labels = new Map<string, VersionLabels | null>();
	if (lineageIds.length === 0) return labels;
	const rows = await all<{ id: string; labels: string | null }>(
		sql(
			db,
			'SELECT l.id AS id, v.labels AS labels FROM lineages l JOIN versions v ON v.id = l.head_version ' +
				'WHERE l.owner_user_id = ? AND l.id IN (SELECT value FROM json_each(?))',
			ownerUserId,
			idList(lineageIds)
		)
	);
	for (const row of rows) labels.set(row.id, parseLabels(row.labels));
	return labels;
}

// ---- Favorites ------------------------------------------------------------------------------

/** Idempotent. 'not-found' when the lineage is not readable by the user. */
export async function addFavorite(
	db: D1Database,
	userId: string,
	lineageId: string,
	now: number
): Promise<RepoResult<{ created: boolean }>> {
	const readable = readableLineageSql('l', { userId });
	const meta = await run(
		sql(
			db,
			'INSERT INTO favorites (user_id, lineage_id, created_at) SELECT ?, l.id, ? FROM lineages l ' +
				`WHERE l.id = ? AND ${readable.text} ON CONFLICT (user_id, lineage_id) DO NOTHING`,
			userId,
			now,
			lineageId,
			...readable.params
		)
	);
	if (meta.changes > 0) return { ok: true, value: { created: true } };
	const exists = await first<{ n: number }>(
		sql(
			db,
			'SELECT count(*) AS n FROM favorites WHERE user_id = ? AND lineage_id = ?',
			userId,
			lineageId
		)
	);
	return (exists?.n ?? 0) > 0
		? { ok: true, value: { created: false } }
		: { ok: false, code: 'not-found' };
}

/** Idempotent; true when a favorite was removed. */
export async function removeFavorite(
	db: D1Database,
	userId: string,
	lineageId: string
): Promise<boolean> {
	const meta = await run(
		sql(db, 'DELETE FROM favorites WHERE user_id = ? AND lineage_id = ?', userId, lineageId)
	);
	return meta.changes > 0;
}

/** The user's favorites still readable by the user, newest first. */
export async function listFavorites(
	db: D1Database,
	userId: string,
	page: PageRequest = {}
): Promise<Page<LibraryEntry>> {
	const size = clampPageSize(page.limit);
	const readable = readableLineageSql('l', { userId });
	const keyset = before2('f.created_at', 'l.id', decodeCursor(page.cursor, ['number', 'string']));
	const rows = await all<SummaryRow & { at: number }>(
		sql(
			db,
			`SELECT ${SUMMARY_COLUMNS}, f.created_at AS at FROM favorites f ` +
				`JOIN lineages l ON l.id = f.lineage_id ${SUMMARY_JOINS} ` +
				`WHERE f.user_id = ? AND ${readable.text} AND ${keyset.text} ` +
				'ORDER BY f.created_at DESC, l.id DESC LIMIT ?',
			userId,
			...readable.params,
			...keyset.params,
			size + 1
		)
	);
	return toPage(
		rows,
		size,
		(row) => ({ lineage: toSummary(row), at: row.at }),
		(row) => [row.at, row.l_id]
	);
}

// ---- Activity -------------------------------------------------------------------------------

interface ActivityRow {
	lineage_id: string;
	kind: string;
	first_at: number;
	last_at: number;
	count: number;
}

function toActivity(row: ActivityRow): ActivityRecord {
	return {
		lineageId: row.lineage_id,
		kind: row.kind as ActivityKind,
		firstAt: row.first_at,
		lastAt: row.last_at,
		count: row.count
	};
}

/**
 * Records a 'previewed' or 'installed' event: one row per user, lineage and kind, keeping the
 * first and last time and a count. 'not-found' when the lineage is not readable by the user.
 */
export async function recordActivity(
	db: D1Database,
	userId: string,
	lineageId: string,
	kind: ActivityKind,
	at: number
): Promise<RepoResult<ActivityRecord>> {
	if (!isOneOf(ACTIVITY_KINDS, kind) || !Number.isSafeInteger(at)) {
		return { ok: false, code: 'invalid-input' };
	}
	const readable = readableLineageSql('l', { userId });
	const meta = await run(
		sql(
			db,
			'INSERT INTO activity (user_id, lineage_id, kind, first_at, last_at, count) ' +
				`SELECT ?, l.id, ?, ?, ?, 1 FROM lineages l WHERE l.id = ? AND ${readable.text} ` +
				'ON CONFLICT (user_id, lineage_id, kind) DO UPDATE SET ' +
				'first_at = min(activity.first_at, excluded.first_at), ' +
				'last_at = max(activity.last_at, excluded.last_at), count = activity.count + 1',
			userId,
			kind,
			at,
			at,
			lineageId,
			...readable.params
		)
	);
	if (meta.changes === 0) return { ok: false, code: 'not-found' };
	const row = await first<ActivityRow>(
		sql(
			db,
			'SELECT lineage_id, kind, first_at, last_at, count FROM activity ' +
				'WHERE user_id = ? AND lineage_id = ? AND kind = ?',
			userId,
			lineageId,
			kind
		)
	);
	return row ? { ok: true, value: toActivity(row) } : { ok: false, code: 'not-found' };
}

/** The user's own activity history, most recent first. */
export async function listOwnActivity(
	db: D1Database,
	userId: string,
	page: PageRequest = {}
): Promise<Page<ActivityRecord>> {
	const size = clampPageSize(page.limit);
	const cursor = decodeCursor(page.cursor, ['number', 'string', 'string']);
	const keyset: SqlFragment = cursor
		? {
				text: '(last_at < ? OR (last_at = ? AND (lineage_id < ? OR (lineage_id = ? AND kind < ?))))',
				params: [cursor[0], cursor[0], cursor[1], cursor[1], cursor[2]]
			}
		: NO_FILTER;
	const rows = await all<ActivityRow>(
		sql(
			db,
			'SELECT lineage_id, kind, first_at, last_at, count FROM activity ' +
				`WHERE user_id = ? AND ${keyset.text} ` +
				'ORDER BY last_at DESC, lineage_id DESC, kind DESC LIMIT ?',
			userId,
			...keyset.params,
			size + 1
		)
	);
	return toPage(rows, size, toActivity, (row) => [row.last_at, row.lineage_id, row.kind]);
}

/**
 * Deletes the user's own activity (all, or one lineage and/or kind), together with the matching
 * attributed share events. Returns the number of activity rows deleted.
 */
export async function deleteOwnActivity(
	db: D1Database,
	userId: string,
	filter: { lineageId?: string | null; kind?: ActivityKind | null } = {}
): Promise<number> {
	const lineageId = filter.lineageId ?? null;
	const kind = filter.kind ?? null;
	if (kind !== null && !isOneOf(ACTIVITY_KINDS, kind)) throw new SocialRepoError('invalid-input');
	const [deleted] = await batch(db, [
		sql(
			db,
			'DELETE FROM activity WHERE user_id = ? AND (? IS NULL OR lineage_id = ?) ' +
				'AND (? IS NULL OR kind = ?)',
			userId,
			lineageId,
			lineageId,
			kind,
			kind
		),
		sql(
			db,
			"DELETE FROM share_event_users WHERE user_id = ? AND kind IN ('previewed', 'installed') " +
				'AND (? IS NULL OR kind = ?) ' +
				'AND (? IS NULL OR share_id IN (SELECT id FROM shares WHERE lineage_id = ?))',
			userId,
			kind,
			kind,
			lineageId,
			lineageId
		)
	]);
	return changes(deleted);
}

/** The user's installed curves still readable by the user, last installed first. */
export async function listInstalled(
	db: D1Database,
	userId: string,
	page: PageRequest = {}
): Promise<Page<LibraryEntry>> {
	const size = clampPageSize(page.limit);
	const readable = readableLineageSql('l', { userId });
	const keyset = before2('a.last_at', 'l.id', decodeCursor(page.cursor, ['number', 'string']));
	const rows = await all<SummaryRow & { at: number }>(
		sql(
			db,
			`SELECT ${SUMMARY_COLUMNS}, a.last_at AS at FROM activity a ` +
				`JOIN lineages l ON l.id = a.lineage_id ${SUMMARY_JOINS} ` +
				`WHERE a.user_id = ? AND a.kind = 'installed' AND ${readable.text} AND ${keyset.text} ` +
				'ORDER BY a.last_at DESC, l.id DESC LIMIT ?',
			userId,
			...readable.params,
			...keyset.params,
			size + 1
		)
	);
	return toPage(
		rows,
		size,
		(row) => ({ lineage: toSummary(row), at: row.at }),
		(row) => [row.at, row.l_id]
	);
}

const EVENTS_CTE =
	'events (lineage_id, user_id, kind, at) AS (' +
	'SELECT lineage_id, user_id, kind, last_at FROM activity WHERE lineage_id IN (SELECT value FROM json_each(?)) ' +
	"UNION ALL SELECT lineage_id, user_id, 'favorited', created_at FROM favorites " +
	'WHERE lineage_id IN (SELECT value FROM json_each(?)))';

/**
 * Public counts (distinct verified, non-banned users, the owner excluded) of the lineages among
 * `lineageIds` that `viewer` can read. Lineages with no event are present with zeros.
 */
export async function countsForLineages(
	db: D1Database,
	lineageIds: readonly string[],
	viewer: Viewer
): Promise<Map<string, PublicCounts>> {
	const ids = idList(lineageIds);
	const readable = readableLineageSql('l', viewer);
	const rows = await all<{ lineage_id: string; kind: string; n: number }>(
		sql(
			db,
			`WITH ${EVENTS_CTE} SELECT e.lineage_id AS lineage_id, e.kind AS kind, count(*) AS n ` +
				'FROM events e JOIN lineages l ON l.id = e.lineage_id JOIN "user" u ON u."id" = e.user_id ' +
				`WHERE ${countedUserSql('u')} AND e.user_id IS NOT l.owner_user_id AND ${readable.text} ` +
				'GROUP BY e.lineage_id, e.kind',
			ids,
			ids,
			...readable.params
		)
	);
	const visible = await all<{ id: string }>(
		sql(
			db,
			`SELECT l.id AS id FROM lineages l WHERE l.id IN (SELECT value FROM json_each(?)) AND ${readable.text}`,
			ids,
			...readable.params
		)
	);
	const counts = new Map<string, PublicCounts>();
	for (const { id } of visible) counts.set(id, { favorites: 0, previewed: 0, installed: 0 });
	for (const row of rows) {
		const entry = counts.get(row.lineage_id);
		if (!entry) continue;
		if (row.kind === 'favorited') entry.favorites = row.n;
		else if (row.kind === 'previewed') entry.previewed = row.n;
		else if (row.kind === 'installed') entry.installed = row.n;
	}
	return counts;
}

/**
 * Who previewed, installed and favorited the owner's lineage: totals of distinct verified,
 * non-banned users (the owner excluded), the nicknames of those whose activity is public, and how
 * many are private. Null when the lineage is not the owner's.
 */
export async function getAudience(
	db: D1Database,
	lineageId: string,
	ownerUserId: string
): Promise<Audience | null> {
	const owned = await first<{ n: number }>(
		sql(
			db,
			'SELECT count(*) AS n FROM lineages WHERE id = ? AND owner_user_id = ?',
			lineageId,
			ownerUserId
		)
	);
	if ((owned?.n ?? 0) === 0) return null;
	const ids = JSON.stringify([lineageId]);
	const isPublic = `(u."activity_visibility" = 'public' AND u."username" IS NOT NULL)`;
	const [totals, named] = await Promise.all([
		all<{ kind: string; total: number; private_count: number }>(
			sql(
				db,
				`WITH ${EVENTS_CTE} SELECT e.kind AS kind, count(*) AS total, ` +
					`sum(CASE WHEN ${isPublic} THEN 0 ELSE 1 END) AS private_count ` +
					'FROM events e JOIN "user" u ON u."id" = e.user_id ' +
					`WHERE ${countedUserSql('u')} AND e.user_id <> ? GROUP BY e.kind`,
				ids,
				ids,
				ownerUserId
			)
		),
		all<{ kind: string; username: string; display: string | null; at: number }>(
			sql(
				db,
				`WITH ${EVENTS_CTE}, ranked AS (SELECT e.kind AS kind, u."username" AS username, ` +
					'u."displayUsername" AS display, e.at AS at, ' +
					'ROW_NUMBER() OVER (PARTITION BY e.kind ORDER BY e.at DESC, u."username") AS n ' +
					'FROM events e JOIN "user" u ON u."id" = e.user_id ' +
					`WHERE ${countedUserSql('u')} AND ${isPublic} AND e.user_id <> ?) ` +
					'SELECT kind, username, display, at FROM ranked WHERE n <= ? ORDER BY kind, n',
				ids,
				ids,
				ownerUserId,
				AUDIENCE_NAMES_MAX
			)
		)
	]);
	const group = (kind: string): AudienceGroup => {
		const total = totals.find((row) => row.kind === kind);
		return {
			total: total?.total ?? 0,
			privateCount: total?.private_count ?? 0,
			named: named
				.filter((row) => row.kind === kind)
				.map((row) => ({
					username: row.username,
					displayUsername: row.display ?? row.username,
					at: row.at
				}))
		};
	};
	return {
		previewed: group('previewed'),
		installed: group('installed'),
		favorited: group('favorited')
	};
}

// ---- Shares ---------------------------------------------------------------------------------

interface ShareRow {
	id: string;
	lineage_id: string;
	version_id: string | null;
	owner_user_id: string;
	channel: string | null;
	created_at: number;
}

function toShare(row: ShareRow): ShareRecord {
	return {
		id: row.id,
		lineageId: row.lineage_id,
		versionId: row.version_id,
		ownerUserId: row.owner_user_id,
		channel: row.channel,
		createdAt: row.created_at
	};
}

const SHARE_COLUMNS = 'id, lineage_id, version_id, owner_user_id, channel, created_at';

/** A share of a lineage (and optionally one of its versions) readable by the sharer. */
export async function createShare(
	db: D1Database,
	input: {
		id: string;
		lineageId: string;
		versionId: string | null;
		ownerUserId: string;
		channel: string | null;
		now: number;
	}
): Promise<RepoResult<ShareRecord>> {
	if (!isSocialId(input.id) || (input.channel !== null && !CHANNEL.test(input.channel))) {
		return { ok: false, code: 'invalid-input' };
	}
	const readable = readableLineageSql('l', { userId: input.ownerUserId });
	const created = await guarded(db, [
		sql(
			db,
			'INSERT INTO shares (id, lineage_id, version_id, owner_user_id, channel, created_at) ' +
				`SELECT ?, l.id, ?, ?, ?, ? FROM lineages l WHERE l.id = ? AND ${readable.text} ` +
				'AND (? IS NULL OR EXISTS (SELECT 1 FROM versions sv WHERE sv.id = ? AND sv.lineage_id = l.id))',
			input.id,
			input.versionId,
			input.ownerUserId,
			input.channel,
			input.now,
			input.lineageId,
			...readable.params,
			input.versionId,
			input.versionId
		)
	]);
	if (!created.ok) return created;
	if (changes(created.results[0]) === 0) return { ok: false, code: 'not-found' };
	const share = await getShare(db, input.id);
	return share ? { ok: true, value: share } : { ok: false, code: 'not-found' };
}

/** The share row (no visibility: callers check the lineage with getLineageForViewer). */
export async function getShare(db: D1Database, shareId: string): Promise<ShareRecord | null> {
	const row = await first<ShareRow>(
		sql(db, `SELECT ${SHARE_COLUMNS} FROM shares WHERE id = ?`, shareId)
	);
	return row ? toShare(row) : null;
}

export async function listOwnShares(
	db: D1Database,
	ownerUserId: string,
	page: PageRequest = {}
): Promise<Page<ShareRecord>> {
	const size = clampPageSize(page.limit);
	const keyset = before2('created_at', 'id', decodeCursor(page.cursor, ['number', 'string']));
	const rows = await all<ShareRow>(
		sql(
			db,
			`SELECT ${SHARE_COLUMNS} FROM shares WHERE owner_user_id = ? AND ${keyset.text} ` +
				'ORDER BY created_at DESC, id DESC LIMIT ?',
			ownerUserId,
			...keyset.params,
			size + 1
		)
	);
	return toPage(rows, size, toShare, (row) => [row.created_at, row.id]);
}

/**
 * One funnel event. Anonymous events (and every 'open') only increment the daily counter; a
 * signed-in user's previewed/installed/favorited is recorded once per user and kind. Returns
 * false when the share does not exist (or the attributed event was already recorded).
 */
export async function recordShareEvent(
	db: D1Database,
	event: { shareId: string; kind: ShareEventKind; userId: string | null; day: string; at: number }
): Promise<boolean> {
	if (!isOneOf(SHARE_EVENT_KINDS, event.kind) || !DAY.test(event.day)) {
		throw new SocialRepoError('invalid-input');
	}
	if (event.userId !== null && isOneOf(SHARE_USER_EVENT_KINDS, event.kind)) {
		const meta = await run(
			sql(
				db,
				'INSERT INTO share_event_users (share_id, user_id, kind, at) SELECT id, ?, ?, ? FROM shares ' +
					'WHERE id = ? ON CONFLICT (share_id, user_id, kind) DO NOTHING',
				event.userId,
				event.kind,
				event.at,
				event.shareId
			)
		);
		return meta.changes > 0;
	}
	const meta = await run(
		sql(
			db,
			'INSERT INTO share_events (share_id, day, kind, anon_count) SELECT id, ?, ?, 1 FROM shares ' +
				'WHERE id = ? ON CONFLICT (share_id, day, kind) DO UPDATE SET ' +
				'anon_count = share_events.anon_count + 1',
			event.day,
			event.kind,
			event.shareId
		)
	);
	return meta.changes > 0;
}

/** Funnel of a share, for its owner only: daily anonymous counters and attributed user counts. */
export async function getShareStats(
	db: D1Database,
	shareId: string,
	ownerUserId: string
): Promise<ShareStats | null> {
	const share = await getShare(db, shareId);
	if (!share || share.ownerUserId !== ownerUserId) return null;
	const [days, users] = await Promise.all([
		all<{ day: string; kind: string; anon_count: number }>(
			sql(
				db,
				'SELECT day, kind, anon_count FROM share_events WHERE share_id = ? ORDER BY day, kind',
				shareId
			)
		),
		// Attributed users are counted only while they still are: counted (verified, not banned)
		// and with public activity. A user who later went private or was banned drops out (FX4.9).
		all<{ kind: string; n: number }>(
			sql(
				db,
				'SELECT seu.kind AS kind, count(*) AS n FROM share_event_users seu ' +
					'JOIN "user" su ON su."id" = seu.user_id ' +
					`WHERE seu.share_id = ? AND ${countedUserSql('su')} ` +
					`AND su."activity_visibility" = 'public' GROUP BY seu.kind`,
				shareId
			)
		)
	]);
	const totals = Object.fromEntries(
		SHARE_EVENT_KINDS.map((kind) => [kind, { anonymous: 0, users: 0 }])
	) as Record<ShareEventKind, { anonymous: number; users: number }>;
	for (const row of days) {
		if (isOneOf(SHARE_EVENT_KINDS, row.kind)) totals[row.kind].anonymous += row.anon_count;
	}
	for (const row of users) {
		if (isOneOf(SHARE_EVENT_KINDS, row.kind)) totals[row.kind].users = row.n;
	}
	return {
		shareId,
		days: days.map((row) => ({
			day: row.day,
			kind: row.kind as ShareEventKind,
			count: row.anon_count
		})),
		totals
	};
}

// ---- Packs ----------------------------------------------------------------------------------

interface PackRow {
	id: string;
	owner_user_id: string | null;
	name: string;
	description: string;
	visibility: string;
	moderation: string;
	created_at: number;
	updated_at: number;
}

function toPack(row: PackRow): PackRecord {
	return {
		id: row.id,
		ownerUserId: row.owner_user_id,
		name: row.name,
		description: row.description,
		visibility: row.visibility as PackVisibility,
		moderation: row.moderation as ModerationState,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

const PACK_COLUMNS =
	'p.id AS id, p.owner_user_id AS owner_user_id, p.name AS name, p.description AS description, ' +
	'p.visibility AS visibility, p.moderation AS moderation, p.created_at AS created_at, ' +
	'p.updated_at AS updated_at';

export async function createPack(
	db: D1Database,
	input: PackInput
): Promise<RepoResult<PackRecord>> {
	if (
		!isSocialId(input.id) ||
		!validName(input.name) ||
		!validDescription(input.description) ||
		!isOneOf(LINEAGE_VISIBILITIES, input.visibility)
	) {
		return { ok: false, code: 'invalid-input' };
	}
	const created = await guarded(db, [
		sql(
			db,
			'INSERT INTO packs (id, owner_user_id, name, description, visibility, moderation, ' +
				"created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'visible', ?, ?)",
			input.id,
			input.ownerUserId,
			input.name,
			input.description,
			input.visibility,
			input.now,
			input.now
		)
	]);
	if (!created.ok) return created;
	const pack = await first<PackRow>(
		sql(db, `SELECT ${PACK_COLUMNS} FROM packs p WHERE p.id = ?`, input.id)
	);
	return pack ? { ok: true, value: toPack(pack) } : { ok: false, code: 'not-found' };
}

/** Updates the given fields of the owner's pack; 'not-found' when it is not the owner's. */
export async function updatePack(
	db: D1Database,
	packId: string,
	ownerUserId: string,
	patch: { name?: string; description?: string; visibility?: PackVisibility },
	now: number
): Promise<RepoResult<{ changed: true }>> {
	if (
		(patch.name !== undefined && !validName(patch.name)) ||
		(patch.description !== undefined && !validDescription(patch.description)) ||
		(patch.visibility !== undefined && !isOneOf(LINEAGE_VISIBILITIES, patch.visibility))
	) {
		return { ok: false, code: 'invalid-input' };
	}
	const meta = await run(
		sql(
			db,
			'UPDATE packs SET name = COALESCE(?, name), description = COALESCE(?, description), ' +
				'visibility = COALESCE(?, visibility), updated_at = ? WHERE id = ? AND owner_user_id = ?',
			patch.name ?? null,
			patch.description ?? null,
			patch.visibility ?? null,
			now,
			packId,
			ownerUserId
		)
	);
	return meta.changes > 0
		? { ok: true, value: { changed: true } }
		: { ok: false, code: 'not-found' };
}

export async function deletePack(
	db: D1Database,
	packId: string,
	ownerUserId: string
): Promise<boolean> {
	const meta = await run(
		sql(db, 'DELETE FROM packs WHERE id = ? AND owner_user_id = ?', packId, ownerUserId)
	);
	return meta.changes > 0;
}

/**
 * Replaces the items of the owner's pack with `lineageIds`, in that order (positions 0..n-1),
 * atomically. Every lineage must be readable by the owner; the license is copied from its head.
 */
export async function setPackItems(
	db: D1Database,
	packId: string,
	ownerUserId: string,
	lineageIds: readonly string[],
	now: number
): Promise<RepoResult<{ count: number }>> {
	if (
		lineageIds.length > PACK_ITEMS_MAX ||
		new Set(lineageIds).size !== lineageIds.length ||
		!lineageIds.every(isSocialId)
	) {
		return { ok: false, code: 'invalid-input' };
	}
	const owned = await first<{ n: number }>(
		sql(
			db,
			'SELECT count(*) AS n FROM packs WHERE id = ? AND owner_user_id = ?',
			packId,
			ownerUserId
		)
	);
	if ((owned?.n ?? 0) === 0) return { ok: false, code: 'not-found' };
	const ids = JSON.stringify(lineageIds);
	const readable = readableLineageSql('l', { userId: ownerUserId });
	const found = await first<{ n: number }>(
		sql(
			db,
			`SELECT count(*) AS n FROM lineages l WHERE l.id IN (SELECT value FROM json_each(?)) AND ${readable.text}`,
			ids,
			...readable.params
		)
	);
	if ((found?.n ?? 0) !== lineageIds.length) return { ok: false, code: 'not-found' };
	const [, inserted] = await batch(db, [
		sql(
			db,
			'DELETE FROM pack_items WHERE pack_id IN (SELECT id FROM packs WHERE id = ? AND owner_user_id = ?)',
			packId,
			ownerUserId
		),
		sql(
			db,
			'INSERT INTO pack_items (pack_id, lineage_id, position, license) ' +
				'SELECT p.id, l.id, j.key, v.license FROM packs p CROSS JOIN json_each(?) j ' +
				'JOIN lineages l ON l.id = j.value JOIN versions v ON v.id = l.head_version ' +
				`WHERE p.id = ? AND p.owner_user_id = ? AND ${readable.text}`,
			ids,
			packId,
			ownerUserId,
			...readable.params
		),
		sql(
			db,
			'UPDATE packs SET updated_at = ? WHERE id = ? AND owner_user_id = ?',
			now,
			packId,
			ownerUserId
		)
	]);
	return { ok: true, value: { count: changes(inserted) } };
}

/**
 * A pack readable by `viewer` (public or unlisted, or own, or admin). Items of someone else's pack
 * are only the publicly listable lineages; the owner (or an admin) sees every item they can read.
 */
export async function getPackForViewer(
	db: D1Database,
	packId: string,
	viewer: Viewer
): Promise<PackView | null> {
	const readable = readablePackSql('p', viewer);
	const pack = await first<PackRow & AuthorCols>(
		sql(
			db,
			`SELECT ${PACK_COLUMNS}, u."username" AS u_username, u."displayUsername" AS u_display ` +
				'FROM packs p LEFT JOIN "user" u ON u."id" = p.owner_user_id ' +
				`WHERE p.id = ? AND ${readable.text}`,
			packId,
			...readable.params
		)
	);
	if (!pack) return null;
	const privileged =
		viewer.admin === true || (viewer.userId !== null && viewer.userId === pack.owner_user_id);
	const itemFilter: SqlFragment = privileged
		? readableLineageSql('l', viewer)
		: { text: publicLineageSql('l'), params: [] };
	const items = await all<SummaryRow & { position: number; item_license: string }>(
		sql(
			db,
			`SELECT ${SUMMARY_COLUMNS}, i.position AS position, i.license AS item_license ` +
				`FROM pack_items i JOIN lineages l ON l.id = i.lineage_id ${SUMMARY_JOINS} ` +
				`WHERE i.pack_id = ? AND ${itemFilter.text} ORDER BY i.position`,
			packId,
			...itemFilter.params
		)
	);
	return {
		...toPack(pack),
		author: toAuthor(pack),
		items: items.map((row): PackItem => ({
			position: row.position,
			license: row.item_license as License,
			lineage: toSummary(row)
		}))
	};
}

export async function listOwnPacks(
	db: D1Database,
	ownerUserId: string,
	page: PageRequest = {}
): Promise<Page<PackRecord>> {
	const size = clampPageSize(page.limit);
	const keyset = before2('p.created_at', 'p.id', decodeCursor(page.cursor, ['number', 'string']));
	const rows = await all<PackRow>(
		sql(
			db,
			`SELECT ${PACK_COLUMNS} FROM packs p WHERE p.owner_user_id = ? AND ${keyset.text} ` +
				'ORDER BY p.created_at DESC, p.id DESC LIMIT ?',
			ownerUserId,
			...keyset.params,
			size + 1
		)
	);
	return toPage(rows, size, toPack, (row) => [row.created_at, row.id]);
}

/** Public packs of everyone, newest first. */
export async function listPublicPacks(
	db: D1Database,
	page: PageRequest = {}
): Promise<Page<PackRecord>> {
	const size = clampPageSize(page.limit);
	const keyset = before2('p.created_at', 'p.id', decodeCursor(page.cursor, ['number', 'string']));
	const rows = await all<PackRow>(
		sql(
			db,
			`SELECT ${PACK_COLUMNS} FROM packs p WHERE ${publicPackSql('p')} AND ${keyset.text} ` +
				'ORDER BY p.created_at DESC, p.id DESC LIMIT ?',
			...keyset.params,
			size + 1
		)
	);
	return toPage(rows, size, toPack, (row) => [row.created_at, row.id]);
}

// ---- Reports and moderation -----------------------------------------------------------------

interface ReportRow {
	id: string;
	target_kind: string;
	target_id: string;
	reason: string;
	note: string | null;
	reporter_user_id: string | null;
	created_at: number;
	resolution: string | null;
	resolved_at: number | null;
}

function toReport(row: ReportRow): ReportRecord {
	return {
		id: row.id,
		targetKind: row.target_kind as ReportTargetKind,
		targetId: row.target_id,
		reason: row.reason as ReportRecord['reason'],
		note: row.note,
		reporterUserId: row.reporter_user_id,
		createdAt: row.created_at,
		resolution: row.resolution as ReportResolution | null,
		resolvedAt: row.resolved_at
	};
}

/** One report per reporter and target; a repeated report is `created: false`. */
export async function insertReport(
	db: D1Database,
	input: ReportInput
): Promise<RepoResult<{ created: boolean }>> {
	if (
		!isSocialId(input.id) ||
		!isOneOf(REPORT_TARGET_KINDS, input.targetKind) ||
		typeof input.targetId !== 'string' ||
		input.targetId.length < 1 ||
		input.targetId.length > 64 ||
		!isOneOf(REPORT_REASONS, input.reason) ||
		(input.note !== null && (typeof input.note !== 'string' || textLength(input.note) > NOTE_MAX))
	) {
		return { ok: false, code: 'invalid-input' };
	}
	const meta = await run(
		sql(
			db,
			'INSERT INTO reports (id, target_kind, target_id, reason, note, reporter_user_id, created_at) ' +
				'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (target_kind, target_id, reporter_user_id) DO NOTHING',
			input.id,
			input.targetKind,
			input.targetId,
			input.reason,
			input.note,
			input.reporterUserId,
			input.now
		)
	);
	return { ok: true, value: { created: meta.changes > 0 } };
}

/** Epoch ms of a Better Auth DATE column (ISO text or a number) inside SQL. */
function epochMsSql(column: string): string {
	return (
		`(CASE WHEN typeof(${column}) IN ('integer', 'real') THEN ${column} ` +
		`ELSE CAST(strftime('%s', ${column}) AS INTEGER) * 1000 END)`
	);
}

/**
 * Distinct reporters of open reports on the target whose accounts count for the auto-hide rule:
 * verified, not banned and created at least `minAccountAgeMs` before `now`.
 */
export async function countEligibleReporters(
	db: D1Database,
	targetKind: ReportTargetKind,
	targetId: string,
	options: { minAccountAgeMs: number; now: number }
): Promise<number> {
	const row = await first<{ n: number }>(
		sql(
			db,
			'SELECT count(DISTINCT r.reporter_user_id) AS n FROM reports r ' +
				'JOIN "user" u ON u."id" = r.reporter_user_id ' +
				'WHERE r.target_kind = ? AND r.target_id = ? AND r.resolution IS NULL ' +
				`AND ${countedUserSql('u')} AND ${epochMsSql('u."createdAt"')} <= ?`,
			targetKind,
			targetId,
			options.now - options.minAccountAgeMs
		)
	);
	return row?.n ?? 0;
}

/** Admin queue: targets with open reports, most recently reported first. */
export async function listReportQueue(
	db: D1Database,
	page: PageRequest = {}
): Promise<Page<ReportQueueEntry>> {
	const size = clampPageSize(page.limit);
	const cursor = decodeCursor(page.cursor, ['number', 'string', 'string']);
	const having: SqlFragment = cursor
		? {
				text:
					'HAVING (max(created_at) < ? OR (max(created_at) = ? AND (target_kind < ? ' +
					'OR (target_kind = ? AND target_id < ?))))',
				params: [cursor[0], cursor[0], cursor[1], cursor[1], cursor[2]]
			}
		: { text: '', params: [] };
	const rows = await all<{
		target_kind: string;
		target_id: string;
		n: number;
		first_at: number;
		last_at: number;
	}>(
		sql(
			db,
			'SELECT target_kind, target_id, count(*) AS n, min(created_at) AS first_at, ' +
				'max(created_at) AS last_at FROM reports WHERE resolution IS NULL ' +
				`GROUP BY target_kind, target_id ${having.text} ` +
				'ORDER BY last_at DESC, target_kind DESC, target_id DESC LIMIT ?',
			...having.params,
			size + 1
		)
	);
	return toPage(
		rows,
		size,
		(row) => ({
			targetKind: row.target_kind as ReportTargetKind,
			targetId: row.target_id,
			openReports: row.n,
			firstAt: row.first_at,
			lastAt: row.last_at
		}),
		(row) => [row.last_at, row.target_kind, row.target_id]
	);
}

/** Every report on a target (admin only: includes reporter ids). */
export async function listReportsForTarget(
	db: D1Database,
	targetKind: ReportTargetKind,
	targetId: string
): Promise<ReportRecord[]> {
	const rows = await all<ReportRow>(
		sql(
			db,
			'SELECT id, target_kind, target_id, reason, note, reporter_user_id, created_at, resolution, ' +
				'resolved_at FROM reports WHERE target_kind = ? AND target_id = ? ORDER BY created_at, id',
			targetKind,
			targetId
		)
	);
	return rows.map(toReport);
}

/** Resolves every open report on a target; returns how many were resolved. */
export async function resolveReports(
	db: D1Database,
	targetKind: ReportTargetKind,
	targetId: string,
	resolution: ReportResolution,
	now: number
): Promise<number> {
	if (!isOneOf(REPORT_RESOLUTIONS, resolution)) throw new SocialRepoError('invalid-input');
	const meta = await run(
		sql(
			db,
			'UPDATE reports SET resolution = ?, resolved_at = ? ' +
				'WHERE target_kind = ? AND target_id = ? AND resolution IS NULL',
			resolution,
			now,
			targetKind,
			targetId
		)
	);
	return meta.changes;
}

// ---- Rankings -------------------------------------------------------------------------------

/**
 * Recomputes one ranking in one atomic batch: score = distinct verified, non-banned users (the
 * owner excluded) who favorited (favorites) or installed (installs) a publicly listable lineage
 * inside the window; ties broken by most recent event, then lineage id. Idempotent: rerunning
 * with the same `now` gives the same rows, and a run older than the stored one changes nothing
 * (`applied: false`).
 */
export async function recomputeRankings(
	db: D1Database,
	metric: RankingMetric,
	window: RankingWindow,
	now: number
): Promise<{ applied: boolean; rows: number }> {
	if (!isOneOf(RANKING_METRICS, metric) || !isOneOf(RANKING_WINDOWS, window)) {
		throw new SocialRepoError('invalid-input');
	}
	const span = RANKING_WINDOW_MS[window];
	const since = span === null ? 0 : now - span;
	const source =
		metric === 'favorites'
			? 'SELECT lineage_id, user_id, created_at AS at FROM favorites WHERE created_at >= ?'
			: "SELECT lineage_id, user_id, last_at AS at FROM activity WHERE kind = 'installed' AND last_at >= ?";
	const guard =
		'NOT EXISTS (SELECT 1 FROM ranking_state s WHERE s.metric = ? AND s."window" = ? AND s.computed_at > ?)';
	const results = await batch(db, [
		sql(
			db,
			`DELETE FROM rankings WHERE metric = ? AND "window" = ? AND ${guard}`,
			metric,
			window,
			metric,
			window,
			now
		),
		sql(
			db,
			'INSERT INTO rankings (metric, "window", lineage_id, score, rank, computed_at) ' +
				'SELECT ?, ?, t.lineage_id, t.score, ' +
				'ROW_NUMBER() OVER (ORDER BY t.score DESC, t.recent DESC, t.lineage_id ASC), ? FROM (' +
				'SELECT e.lineage_id AS lineage_id, count(*) AS score, max(e.at) AS recent ' +
				`FROM (${source}) e JOIN lineages l ON l.id = e.lineage_id ` +
				'JOIN "user" u ON u."id" = e.user_id ' +
				`WHERE ${countedUserSql('u')} AND e.user_id IS NOT l.owner_user_id AND ${publicLineageSql('l')} ` +
				'GROUP BY e.lineage_id ORDER BY score DESC, recent DESC, lineage_id ASC LIMIT ?) t ' +
				`WHERE ${guard}`,
			metric,
			window,
			now,
			since,
			RANKING_MAX_ROWS,
			metric,
			window,
			now
		),
		sql(
			db,
			'INSERT INTO ranking_state (metric, "window", computed_at, row_count) VALUES (?, ?, ?, ' +
				'(SELECT count(*) FROM rankings WHERE metric = ? AND "window" = ? AND computed_at = ?)) ' +
				'ON CONFLICT (metric, "window") DO UPDATE SET computed_at = excluded.computed_at, ' +
				'row_count = excluded.row_count WHERE excluded.computed_at >= ranking_state.computed_at',
			metric,
			window,
			now,
			metric,
			window,
			now
		)
	]);
	return { applied: changes(results[2]) > 0, rows: changes(results[1]) };
}

/**
 * A materialized ranking, best first. Visibility is re-checked at read time, so a lineage hidden
 * after the last computation disappears at once (leaving a gap in `rank`).
 */
export async function listRankings(
	db: D1Database,
	metric: RankingMetric,
	window: RankingWindow,
	page: PageRequest = {}
): Promise<Page<RankingEntry>> {
	if (!isOneOf(RANKING_METRICS, metric) || !isOneOf(RANKING_WINDOWS, window)) {
		throw new SocialRepoError('invalid-input');
	}
	const size = clampPageSize(page.limit);
	const cursor = decodeCursor(page.cursor, ['number']);
	const rows = await all<SummaryRow & { r_rank: number; r_score: number; r_computed: number }>(
		sql(
			db,
			`SELECT ${SUMMARY_COLUMNS}, r.rank AS r_rank, r.score AS r_score, r.computed_at AS r_computed ` +
				`FROM rankings r JOIN lineages l ON l.id = r.lineage_id ${SUMMARY_JOINS} ` +
				`WHERE r.metric = ? AND r."window" = ? AND r.rank > ? AND ${publicLineageSql('l')} ` +
				'ORDER BY r.rank LIMIT ?',
			metric,
			window,
			cursor ? cursor[0] : 0,
			size + 1
		)
	);
	return toPage(
		rows,
		size,
		(row) => ({
			rank: row.r_rank,
			score: row.r_score,
			computedAt: row.r_computed,
			lineage: toSummary(row)
		}),
		(row) => [row.r_rank]
	);
}

export async function getRankingState(
	db: D1Database,
	metric: RankingMetric,
	window: RankingWindow
): Promise<{ computedAt: number; rowCount: number } | null> {
	const row = await first<{ computed_at: number; row_count: number }>(
		sql(
			db,
			'SELECT computed_at, row_count FROM ranking_state WHERE metric = ? AND "window" = ?',
			metric,
			window
		)
	);
	return row ? { computedAt: row.computed_at, rowCount: row.row_count } : null;
}

// ---- S6 -------------------------------------------------------------------------------------

/** Stores an anonymous batch and its pairs atomically; 'duplicate' for a reused receipt. */
export async function insertS6Batch(
	db: D1Database,
	input: S6BatchInput
): Promise<RepoResult<{ id: string }>> {
	if (
		!isSocialId(input.id) ||
		!RECEIPT.test(input.receiptHash) ||
		typeof input.consentVer !== 'string' ||
		input.consentVer.length < 1 ||
		input.consentVer.length > 32 ||
		!DAY.test(input.day) ||
		input.pairs.length < 1 ||
		input.pairs.length > S6_PAIRS_MAX ||
		!input.pairs.every(
			(pair) =>
				S6_ITEM.test(pair.a) &&
				S6_ITEM.test(pair.b) &&
				pair.a !== pair.b &&
				isOneOf(S6_CHOICES, pair.choice) &&
				typeof pair.levelMatched === 'boolean'
		)
	) {
		return { ok: false, code: 'invalid-input' };
	}
	const pairs = JSON.stringify(
		input.pairs.map((pair) => [pair.a, pair.b, pair.choice, pair.levelMatched ? 1 : 0])
	);
	const done = await guarded(db, [
		sql(
			db,
			'INSERT INTO s6_batches (id, receipt_hash, consent_ver, day) VALUES (?, ?, ?, ?)',
			input.id,
			input.receiptHash,
			input.consentVer,
			input.day
		),
		sql(
			db,
			'INSERT INTO s6_pairs (batch_id, a, b, choice, level_matched) ' +
				"SELECT ?, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), " +
				"json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]') FROM json_each(?) j ORDER BY j.key",
			input.id,
			pairs
		)
	]);
	return done.ok ? { ok: true, value: { id: input.id } } : done;
}

/** Withdraws a batch by its receipt hash (pairs cascade); true when one was deleted. */
export async function deleteS6BatchByReceipt(
	db: D1Database,
	receiptHash: string
): Promise<boolean> {
	if (!RECEIPT.test(receiptHash)) return false;
	const meta = await run(sql(db, 'DELETE FROM s6_batches WHERE receipt_hash = ?', receiptHash));
	return meta.changes > 0;
}

/** Pairs for the aggregation job, by ascending id (keyset on `afterId`). */
export async function listS6Pairs(
	db: D1Database,
	options: { afterId?: number; limit?: number } = {}
): Promise<S6PairRecord[]> {
	const limit = Math.min(Math.max(Math.trunc(options.limit ?? 1000), 1), 5000);
	const rows = await all<{
		id: number;
		a: string;
		b: string;
		choice: string;
		level_matched: number;
		day: string;
	}>(
		sql(
			db,
			'SELECT p.id AS id, p.a AS a, p.b AS b, p.choice AS choice, p.level_matched AS level_matched, ' +
				'b.day AS day FROM s6_pairs p JOIN s6_batches b ON b.id = p.batch_id WHERE p.id > ? ' +
				'ORDER BY p.id LIMIT ?',
			options.afterId ?? 0,
			limit
		)
	);
	return rows.map((row) => ({
		id: row.id,
		a: row.a,
		b: row.b,
		choice: row.choice as S6PairRecord['choice'],
		levelMatched: row.level_matched === 1,
		day: row.day
	}));
}

// ---- S7 trades ------------------------------------------------------------------------------

interface TradeRow {
	id: string;
	user_id: string;
	lineage_id: string;
	version_id: string;
	status: string;
	match_id: string | null;
	score: number | null;
	created_at: number;
	matched_at: number | null;
	scored_at: number | null;
	expires_at: number;
}

interface TradeViewRow extends TradeRow {
	p_lineage: string | null;
	p_version: string | null;
	p_score: number | null;
	p_curve: string | null;
	p_s1: string | null;
}

function toTrade(row: TradeRow): TradeRecord {
	return {
		id: row.id,
		userId: row.user_id,
		lineageId: row.lineage_id,
		versionId: row.version_id,
		status: row.status as TradeStatus,
		matchId: row.match_id,
		score: row.score,
		createdAt: row.created_at,
		matchedAt: row.matched_at,
		scoredAt: row.scored_at,
		expiresAt: row.expires_at
	};
}

function toTradeView(row: TradeViewRow): TradeView {
	const trade = toTrade(row);
	const paired = trade.status === 'matched' || trade.status === 'revealed';
	const revealed = trade.status === 'revealed';
	return {
		...trade,
		partner:
			paired && row.p_curve !== null && row.p_s1 !== null
				? {
						curveId: row.p_curve,
						s1: row.p_s1,
						lineageId: revealed ? row.p_lineage : null,
						versionId: revealed ? row.p_version : null,
						score: revealed ? row.p_score : null
					}
				: null
	};
}

const TRADE_COLUMNS =
	't.id AS id, t.user_id AS user_id, t.lineage_id AS lineage_id, t.version_id AS version_id, ' +
	't.status AS status, t.match_id AS match_id, t.score AS score, t.created_at AS created_at, ' +
	't.matched_at AS matched_at, t.scored_at AS scored_at, t.expires_at AS expires_at';
const TRADE_VIEW_FROM =
	'FROM trades t LEFT JOIN trades p ON p.id = t.match_id LEFT JOIN versions pv ON pv.id = p.version_id ' +
	'LEFT JOIN curves pc ON pc.id = pv.curve_id';
const TRADE_VIEW_COLUMNS =
	`${TRADE_COLUMNS}, p.lineage_id AS p_lineage, p.version_id AS p_version, p.score AS p_score, ` +
	'pc.id AS p_curve, pc.s1 AS p_s1';

/**
 * Joins the S7 queue with a version of a lineage readable by the user whose curve passed the
 * gate. At most one active trade per user ('already-active').
 */
export async function createTrade(
	db: D1Database,
	input: { id: string; userId: string; lineageId: string; versionId: string; now: number }
): Promise<RepoResult<TradeRecord>> {
	if (!isSocialId(input.id)) return { ok: false, code: 'invalid-input' };
	const readable = readableLineageSql('l', { userId: input.userId });
	const created = await guarded(db, [
		sql(
			db,
			'INSERT INTO trades (id, user_id, lineage_id, version_id, status, created_at, expires_at) ' +
				"SELECT ?, ?, l.id, v.id, 'waiting', ?, ? FROM versions v JOIN lineages l ON l.id = v.lineage_id " +
				`JOIN curves c ON c.id = v.curve_id WHERE v.id = ? AND l.id = ? AND c.gate_ok = 1 AND ${readable.text}`,
			input.id,
			input.userId,
			input.now,
			input.now + TRADE_TTL_MS,
			input.versionId,
			input.lineageId,
			...readable.params
		)
	]);
	if (!created.ok) return created;
	if (changes(created.results[0]) === 0) return { ok: false, code: 'not-found' };
	const row = await first<TradeRow>(
		sql(db, `SELECT ${TRADE_COLUMNS} FROM trades t WHERE t.id = ?`, input.id)
	);
	return row ? { ok: true, value: toTrade(row) } : { ok: false, code: 'not-found' };
}

/**
 * The pairing primitive: matches `tradeId` with `candidateId` iff both are still waiting and
 * unexpired. Two conditional UPDATEs in one batch, so concurrent attempts on the same candidate
 * match it at most once. True when this call made the match.
 */
export async function tryPairTrades(
	db: D1Database,
	tradeId: string,
	candidateId: string,
	now: number
): Promise<boolean> {
	const expires = now + TRADE_TTL_MS;
	const results = await batch(db, [
		sql(
			db,
			"UPDATE trades SET status = 'matched', match_id = ?, matched_at = ?, expires_at = ? " +
				"WHERE id = ? AND status = 'waiting' AND expires_at > ? AND EXISTS (SELECT 1 FROM trades m " +
				"WHERE m.id = ? AND m.status = 'waiting' AND m.expires_at > ? AND m.user_id <> trades.user_id)",
			tradeId,
			now,
			expires,
			candidateId,
			now,
			tradeId,
			now
		),
		sql(
			db,
			"UPDATE trades SET status = 'matched', match_id = ?, matched_at = ?, expires_at = ? " +
				"WHERE id = ? AND status = 'waiting' AND EXISTS (SELECT 1 FROM trades c " +
				"WHERE c.id = ? AND c.status = 'matched' AND c.match_id = ?)",
			candidateId,
			now,
			expires,
			tradeId,
			candidateId,
			tradeId
		)
	]);
	return changes(results[1]) === 1;
}

/** Tries to pair the user's waiting trade with the oldest waiting trades of other users. */
export async function pairTrade(
	db: D1Database,
	tradeId: string,
	userId: string,
	now: number,
	attempts = 3
): Promise<RepoResult<PairResult>> {
	const mine = await first<TradeRow>(
		sql(
			db,
			`SELECT ${TRADE_COLUMNS} FROM trades t WHERE t.id = ? AND t.user_id = ?`,
			tradeId,
			userId
		)
	);
	if (!mine) return { ok: false, code: 'not-found' };
	if (mine.status === 'matched' && mine.match_id !== null) {
		return { ok: true, value: { status: 'matched', matchId: mine.match_id } };
	}
	if (mine.status !== 'waiting' || mine.expires_at <= now)
		return { ok: false, code: 'invalid-input' };
	const candidates = await all<{ id: string }>(
		sql(
			db,
			"SELECT id FROM trades WHERE status = 'waiting' AND expires_at > ? AND user_id <> ? " +
				'AND lineage_id <> ? ORDER BY created_at, id LIMIT ?',
			now,
			userId,
			mine.lineage_id,
			Math.min(Math.max(Math.trunc(attempts), 1), 10)
		)
	);
	for (const candidate of candidates) {
		if (await tryPairTrades(db, tradeId, candidate.id, now)) {
			return { ok: true, value: { status: 'matched', matchId: candidate.id } };
		}
	}
	const after = await first<{ status: string; match_id: string | null }>(
		sql(db, 'SELECT status, match_id FROM trades WHERE id = ?', tradeId)
	);
	if (after?.status === 'matched' && after.match_id !== null) {
		return { ok: true, value: { status: 'matched', matchId: after.match_id } };
	}
	return { ok: true, value: { status: 'waiting' } };
}

/**
 * The user scores the partner's curve (1-5) once; when both scored, both trades are revealed in
 * the same batch.
 */
export async function scoreTrade(
	db: D1Database,
	tradeId: string,
	userId: string,
	score: number,
	now: number
): Promise<RepoResult<{ revealed: boolean }>> {
	if (!Number.isInteger(score) || score < 1 || score > 5)
		return { ok: false, code: 'invalid-input' };
	const results = await batch(db, [
		sql(
			db,
			'UPDATE trades SET score = ?, scored_at = ? WHERE id = ? AND user_id = ? ' +
				"AND status = 'matched' AND score IS NULL AND match_id IS NOT NULL AND expires_at > ?",
			score,
			now,
			tradeId,
			userId,
			now
		),
		sql(
			db,
			"UPDATE trades SET status = 'revealed' WHERE status = 'matched' " +
				'AND id IN (?, (SELECT match_id FROM trades WHERE id = ?)) ' +
				'AND (SELECT count(*) FROM trades s WHERE s.id IN (?, (SELECT match_id FROM trades WHERE id = ?)) ' +
				'AND s.score IS NOT NULL) = 2',
			tradeId,
			tradeId,
			tradeId,
			tradeId
		)
	]);
	if (changes(results[0]) === 1)
		return { ok: true, value: { revealed: changes(results[1]) === 2 } };
	const row = await first<{ score: number | null }>(
		sql(db, 'SELECT score FROM trades WHERE id = ? AND user_id = ?', tradeId, userId)
	);
	if (!row) return { ok: false, code: 'not-found' };
	return { ok: false, code: row.score !== null ? 'duplicate' : 'invalid-input' };
}

/** Cancels the user's trade while it is still waiting. */
export async function cancelTrade(
	db: D1Database,
	tradeId: string,
	userId: string
): Promise<boolean> {
	const meta = await run(
		sql(
			db,
			"UPDATE trades SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'waiting'",
			tradeId,
			userId
		)
	);
	return meta.changes > 0;
}

/** Expires active trades past their deadline (hourly job); returns how many expired. */
export async function expireTrades(db: D1Database, now: number): Promise<number> {
	const meta = await run(
		sql(
			db,
			"UPDATE trades SET status = 'expired' WHERE status IN ('waiting', 'matched') AND expires_at <= ?",
			now
		)
	);
	return meta.changes;
}

export async function getTradeForUser(
	db: D1Database,
	tradeId: string,
	userId: string
): Promise<TradeView | null> {
	const row = await first<TradeViewRow>(
		sql(
			db,
			`SELECT ${TRADE_VIEW_COLUMNS} ${TRADE_VIEW_FROM} WHERE t.id = ? AND t.user_id = ?`,
			tradeId,
			userId
		)
	);
	return row ? toTradeView(row) : null;
}

export async function listOwnTrades(
	db: D1Database,
	userId: string,
	page: PageRequest = {}
): Promise<Page<TradeView>> {
	const size = clampPageSize(page.limit);
	const keyset = before2('t.created_at', 't.id', decodeCursor(page.cursor, ['number', 'string']));
	const rows = await all<TradeViewRow>(
		sql(
			db,
			`SELECT ${TRADE_VIEW_COLUMNS} ${TRADE_VIEW_FROM} WHERE t.user_id = ? AND ${keyset.text} ` +
				'ORDER BY t.created_at DESC, t.id DESC LIMIT ?',
			userId,
			...keyset.params,
			size + 1
		)
	);
	return toPage(rows, size, toTradeView, (row) => [row.created_at, row.id]);
}

/** Average score received by each lineage in revealed trades. */
export async function tradeAverages(
	db: D1Database,
	lineageIds: readonly string[]
): Promise<Map<string, { average: number; count: number }>> {
	const rows = await all<{ lineage_id: string; average: number; n: number }>(
		sql(
			db,
			'SELECT t.lineage_id AS lineage_id, avg(p.score) AS average, count(p.score) AS n ' +
				'FROM trades t JOIN trades p ON p.id = t.match_id ' +
				"WHERE t.status = 'revealed' AND p.score IS NOT NULL " +
				'AND t.lineage_id IN (SELECT value FROM json_each(?)) GROUP BY t.lineage_id',
			idList(lineageIds)
		)
	);
	return new Map(rows.map((row) => [row.lineage_id, { average: row.average, count: row.n }]));
}

// ---- Public profiles ------------------------------------------------------------------------

/**
 * Profile of a nickname (already normalized by the caller), or null for an unknown or banned
 * user. Counts are always given ("contagens agregadas"); lists depend on the visibility options.
 */
export async function getPublicProfile(
	db: D1Database,
	username: string
): Promise<PublicProfile | null> {
	const row = await first<{
		id: string;
		username: string;
		displayUsername: string | null;
		bio: string | null;
		library_visibility: string | null;
		activity_visibility: string | null;
		lineages: number;
		packs: number;
	}>(
		sql(
			db,
			'SELECT pu."id" AS id, pu."username" AS username, pu."displayUsername" AS "displayUsername", ' +
				'pu."bio" AS bio, pu."library_visibility" AS library_visibility, ' +
				'pu."activity_visibility" AS activity_visibility, ' +
				`(SELECT count(*) FROM lineages l WHERE l.owner_user_id = pu."id" AND ${publicLineageSql('l')}) AS lineages, ` +
				`(SELECT count(*) FROM packs p WHERE p.owner_user_id = pu."id" AND ${publicPackSql('p')}) AS packs ` +
				'FROM "user" pu WHERE pu."username" = ? AND COALESCE(pu."banned", 0) = 0',
			username
		)
	);
	if (!row) return null;
	return {
		userId: row.id,
		username: row.username,
		displayUsername: row.displayUsername ?? row.username,
		bio: row.bio,
		libraryVisibility: row.library_visibility === 'public' ? 'public' : 'private',
		activityVisibility: row.activity_visibility === 'public' ? 'public' : 'private',
		counts: { lineages: row.lineages, packs: row.packs }
	};
}

const LIBRARY_PUBLIC =
	'EXISTS (SELECT 1 FROM "user" pu WHERE pu."id" = ? AND pu."library_visibility" = \'public\' ' +
	'AND COALESCE(pu."banned", 0) = 0)';

/** Public creations on a profile; empty unless the library is public. */
export async function listProfileLineages(
	db: D1Database,
	ownerUserId: string,
	page: PageRequest = {}
): Promise<Page<LineageSummary>> {
	const size = clampPageSize(page.limit);
	const keyset = before2('l.created_at', 'l.id', decodeCursor(page.cursor, ['number', 'string']));
	const rows = await all<SummaryRow>(
		sql(
			db,
			`SELECT ${SUMMARY_COLUMNS} FROM lineages l ${SUMMARY_JOINS} ` +
				`WHERE l.owner_user_id = ? AND ${LIBRARY_PUBLIC} AND ${publicLineageSql('l')} AND ${keyset.text} ` +
				'ORDER BY l.created_at DESC, l.id DESC LIMIT ?',
			ownerUserId,
			ownerUserId,
			...keyset.params,
			size + 1
		)
	);
	return toPage(rows, size, toSummary, (row) => [row.l_created, row.l_id]);
}

/** Public packs on a profile; empty unless the library is public. */
export async function listProfilePacks(
	db: D1Database,
	ownerUserId: string,
	page: PageRequest = {}
): Promise<Page<PackRecord>> {
	const size = clampPageSize(page.limit);
	const keyset = before2('p.created_at', 'p.id', decodeCursor(page.cursor, ['number', 'string']));
	const rows = await all<PackRow>(
		sql(
			db,
			`SELECT ${PACK_COLUMNS} FROM packs p WHERE p.owner_user_id = ? AND ${LIBRARY_PUBLIC} ` +
				`AND ${publicPackSql('p')} AND ${keyset.text} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
			ownerUserId,
			ownerUserId,
			...keyset.params,
			size + 1
		)
	);
	return toPage(rows, size, toPack, (row) => [row.created_at, row.id]);
}

/** Public favorites on a profile; empty unless both the library and the activity are public. */
export async function listProfileFavorites(
	db: D1Database,
	userId: string,
	page: PageRequest = {}
): Promise<Page<LibraryEntry>> {
	const size = clampPageSize(page.limit);
	const keyset = before2('f.created_at', 'l.id', decodeCursor(page.cursor, ['number', 'string']));
	const rows = await all<SummaryRow & { at: number }>(
		sql(
			db,
			`SELECT ${SUMMARY_COLUMNS}, f.created_at AS at FROM favorites f ` +
				`JOIN lineages l ON l.id = f.lineage_id ${SUMMARY_JOINS} ` +
				`WHERE f.user_id = ? AND ${LIBRARY_PUBLIC} AND EXISTS (SELECT 1 FROM "user" au ` +
				`WHERE au."id" = f.user_id AND au."activity_visibility" = 'public') ` +
				`AND ${publicLineageSql('l')} AND ${keyset.text} ` +
				'ORDER BY f.created_at DESC, l.id DESC LIMIT ?',
			userId,
			userId,
			...keyset.params,
			size + 1
		)
	);
	return toPage(
		rows,
		size,
		(row) => ({ lineage: toSummary(row), at: row.at }),
		(row) => [row.at, row.l_id]
	);
}
