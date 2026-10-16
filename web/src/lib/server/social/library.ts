// Personal library (T4.3): the three shelves of the signed-in user (created, favorites,
// installed), idempotent favorite/unfavorite with optional share attribution, and the merge of the
// anonymous browser library into the account. Data access goes through repo.ts and
// queries/library.ts; curves are validated and gated only through gate.ts (`checkCurve`).
import type { D1Database } from '@cloudflare/workers-types';
import {
	canonKey,
	curveId,
	decodeS1,
	EnvelopeError,
	normalizeText,
	S1Error
} from 'open-auri/share';
import { checkCurve, type GateDeps } from '#lib/server/social/gate.ts';
import { countOwnLineagesSince, ownHeadNames } from '#lib/server/social/queries/library.ts';
import {
	addFavorite,
	findOwnLineagesByCurves,
	getLineageForViewer,
	getShare,
	isSocialId,
	listFavorites,
	listInstalled,
	listOwnLineages,
	publishLineage,
	recordShareEvent,
	removeFavorite
} from '#lib/server/social/repo.ts';
import {
	DAY_MS,
	DESCRIPTION_MAX,
	NAME_MAX,
	type AuthorCredit,
	type Lang,
	type LibraryEntry,
	type License,
	type LineageStatus,
	type LineageSummary,
	type LineageVisibility,
	type ModerationState,
	type Page,
	type SocialErrorCode
} from '#lib/server/social/types.ts';

// ---- Shelves --------------------------------------------------------------------------------

export const LIBRARY_SHELVES = ['created', 'favorites', 'installed'] as const;
export type LibraryShelf = (typeof LIBRARY_SHELVES)[number];

export interface LibraryQuery {
	shelf: LibraryShelf;
	/** Only for the `created` shelf. */
	visibility?: LineageVisibility | null;
	cursor?: string | null;
	limit?: number;
}

/** A library row as the API returns it (no internal user id). */
export interface LibraryItem {
	id: string;
	/** True when the caller owns the lineage. */
	own: boolean;
	visibility: LineageVisibility;
	status: LineageStatus;
	moderation: ModerationState;
	curated: boolean;
	forkedFromVersion: string | null;
	createdAt: number;
	updatedAt: number;
	author: AuthorCredit | null;
	head: {
		id: string;
		parentId: string | null;
		name: string;
		description: string;
		license: License;
		lang: Lang;
		recipe: string | null;
		createdAt: number;
	};
	curve: { id: string; s1: string; levelDb: number | null; gateOk: boolean };
	/** Shelf time: creation (created), favorited (favorites) or last install (installed). */
	at: number;
}

export function toLibraryItem(lineage: LineageSummary, at: number, userId: string): LibraryItem {
	const { head, curve } = lineage;
	return {
		id: lineage.id,
		own: lineage.ownerUserId === userId,
		visibility: lineage.visibility,
		status: lineage.status,
		moderation: lineage.moderation,
		curated: lineage.curated,
		forkedFromVersion: lineage.forkedFromVersion,
		createdAt: lineage.createdAt,
		updatedAt: lineage.updatedAt,
		author: lineage.author,
		head: {
			id: head.id,
			parentId: head.parentId,
			name: head.name,
			description: head.description,
			license: head.license,
			lang: head.lang,
			recipe: head.recipe,
			createdAt: head.createdAt
		},
		curve: { id: curve.id, s1: curve.s1, levelDb: curve.levelDb, gateOk: curve.gateOk },
		at
	};
}

function entries(page: Page<LibraryEntry>, userId: string): Page<LibraryItem> {
	return {
		items: page.items.map((entry) => toLibraryItem(entry.lineage, entry.at, userId)),
		nextCursor: page.nextCursor
	};
}

/**
 * One page of a shelf of `userId` (from the session): own lineages in every visibility and state
 * (optionally filtered by visibility), favorites and installed curves still readable by the user.
 * Throws SocialRepoError('invalid-cursor') for a cursor that does not decode.
 */
export async function listLibrary(
	db: D1Database,
	userId: string,
	query: LibraryQuery
): Promise<Page<LibraryItem>> {
	const page = { cursor: query.cursor ?? null, ...(query.limit ? { limit: query.limit } : {}) };
	switch (query.shelf) {
		case 'created': {
			const own = await listOwnLineages(db, userId, {
				...page,
				...(query.visibility ? { visibility: query.visibility } : {})
			});
			return {
				items: own.items.map((lineage) => toLibraryItem(lineage, lineage.createdAt, userId)),
				nextCursor: own.nextCursor
			};
		}
		case 'favorites':
			return entries(await listFavorites(db, userId, page), userId);
		case 'installed':
			return entries(await listInstalled(db, userId, page), userId);
	}
}

// ---- Favorites ------------------------------------------------------------------------------

export type FavoriteResult =
	{ ok: true; created: boolean; attributed: boolean } | { ok: false; code: 'not-found' };

function utcDay(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

/**
 * Idempotent favorite. 'not-found' when the lineage is not readable by the user (missing, someone
 * else's private lineage, retracted, moderated...). With `shareId`, a newly created favorite is
 * attributed to that share as a `favorited` funnel event when the share points to the same lineage
 * (once per user and share; a share of another lineage or a missing share is ignored).
 */
export async function favoriteLineage(
	db: D1Database,
	userId: string,
	lineageId: string,
	options: { shareId?: string | null; now?: number } = {}
): Promise<FavoriteResult> {
	const now = options.now ?? Date.now();
	if (!isSocialId(lineageId)) return { ok: false, code: 'not-found' };
	const readable = await getLineageForViewer(db, lineageId, { userId });
	if (!readable) return { ok: false, code: 'not-found' };
	const added = await addFavorite(db, userId, lineageId, now);
	if (!added.ok) return { ok: false, code: 'not-found' };
	let attributed = false;
	const shareId = options.shareId ?? null;
	if (added.value.created && shareId !== null && isSocialId(shareId)) {
		const share = await getShare(db, shareId);
		if (share && share.lineageId === lineageId) {
			attributed = await recordShareEvent(db, {
				shareId,
				kind: 'favorited',
				userId,
				day: utcDay(now),
				at: now
			});
		}
	}
	return { ok: true, created: added.value.created, attributed };
}

/** Idempotent; `removed` is true when a favorite existed. Never reveals if the lineage exists. */
export async function unfavoriteLineage(
	db: D1Database,
	userId: string,
	lineageId: string
): Promise<{ removed: boolean }> {
	if (!isSocialId(lineageId)) return { removed: false };
	return { removed: await removeFavorite(db, userId, lineageId) };
}

// ---- Merge of the local library -------------------------------------------------------------

/** Items per merge request. */
export const MERGE_BATCH_MAX = 100;
/** Lineages a user may have created in the last 24 hours for a merge to still create more. */
export const MERGE_DAILY_MAX = 500;
export const MERGE_DEFAULT_LICENSE: License = 'CC-BY-4.0';
export const MERGE_DEFAULT_LANG: Lang = 'pt-BR';

/** One item of the browser library, as sent by the client. */
export interface MergeItem {
	localId: string;
	s1: string;
	name: string;
	description?: string | undefined;
	lang?: Lang | undefined;
	license?: License | undefined;
}

export type MergeRejectCode =
	'INVALID_CURVE' | 'GATE_REJECTED' | 'INVALID_TEXT' | 'QUOTA_EXCEEDED' | 'DUPLICATE' | 'INTERNAL';

export interface MergeReport {
	created: { localId: string; lineageId: string }[];
	duplicates: { localId: string; lineageId: string }[];
	rejected: { localId: string; code: MergeRejectCode; reasons?: string[] }[];
	conflicts: { localId: string; lineageId: string; field: 'name' }[];
}

export interface MergeOptions {
	now?: number;
	/** Gate injection for tests (default: the production gate). */
	deps?: Partial<GateDeps>;
}

interface Identity {
	curveId: string;
	canonKey: string;
}

type Outcome =
	| { kind: 'lineage'; lineageId: string; name: string }
	| { kind: 'rejected'; code: MergeRejectCode; reasons?: string[] };

async function identify(s1: string): Promise<Identity | null> {
	let decoded: ReturnType<typeof decodeS1>;
	try {
		decoded = decodeS1(s1);
	} catch (error) {
		if (error instanceof S1Error) return null;
		throw error;
	}
	return { curveId: await curveId(s1), canonKey: canonKey(decoded.bands, decoded.preampDb) };
}

function issueCodes(error: EnvelopeError): string[] {
	const issues: unknown = error.errors;
	if (!Array.isArray(issues)) return ['env:invalid'];
	const codes = issues.map((issue: unknown) =>
		typeof issue === 'object' && issue !== null && 'code' in issue ? String(issue.code) : ''
	);
	return [...new Set(codes.filter((code) => code !== ''))];
}

function truncate(value: string, max: number): string {
	const points = [...value];
	return points.length <= max ? value : points.slice(0, max).join('').trimEnd();
}

type TextResult = { ok: true; value: string } | { ok: false; reasons: string[] };

/** NFKC, no invisibles/bidi, no URL (core `normalizeText`), then cut to `max` code points. */
function cleanText(value: string, multiline: boolean, max: number, path: string): TextResult {
	try {
		return { ok: true, value: truncate(normalizeText(value, { multiline, path }), max) };
	} catch (error) {
		if (error instanceof EnvelopeError) return { ok: false, reasons: issueCodes(error) };
		throw error;
	}
}

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Deterministic ids of the lineage created for (user, canonical curve): two concurrent merges of
 * the same curve collide on the primary key instead of creating two lineages.
 */
async function mergeIds(
	userId: string,
	key: string
): Promise<{ lineageId: string; versionId: string }> {
	const material = new TextEncoder().encode(`open-auri:library-merge:v1\n${userId}\n${key}`);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
	const suffix = base64url(digest.slice(0, 18));
	return { lineageId: `lm${suffix}`, versionId: `vm${suffix}` };
}

const REPO_REJECT: Partial<Record<SocialErrorCode, MergeRejectCode>> = {
	'gate-rejected': 'GATE_REJECTED',
	duplicate: 'DUPLICATE',
	'invalid-input': 'INVALID_TEXT'
};

/**
 * Merges a batch (at most MERGE_BATCH_MAX items, distinct `localId`s) of the browser library into
 * the account of `userId` (from the session). Each item lands in exactly one list of the report:
 *
 * - `duplicates`: the user already owns a lineage with a version of the same curve (`curve_id` or
 *   `canonKey`), or an earlier item of the batch has it, with the same name;
 * - `conflicts`: same, but the name differs (`field: 'name'`); nothing is changed;
 * - `rejected`: invalid S1, curve reproved by the gate, text refused by the normalizer, or the
 *   daily quota is spent; the item stays local only;
 * - `created`: a new PRIVATE lineage (name and description normalized and cut to the limits).
 *
 * Idempotent: re-sending the same batch creates nothing new (every item is then a duplicate).
 */
export async function mergeLocalLibrary(
	db: D1Database,
	userId: string,
	items: readonly MergeItem[],
	options: MergeOptions = {}
): Promise<MergeReport> {
	if (items.length > MERGE_BATCH_MAX) throw new RangeError('merge batch too large');
	const now = options.now ?? Date.now();
	const report: MergeReport = { created: [], duplicates: [], rejected: [], conflicts: [] };

	const identities = await Promise.all(items.map((item) => identify(item.s1)));
	const known = identities.filter((identity): identity is Identity => identity !== null);
	const owned = await findOwnLineagesByCurves(db, userId, {
		curveIds: [...new Set(known.map((identity) => identity.curveId))],
		canonKeys: [...new Set(known.map((identity) => identity.canonKey))]
	});
	const names = await ownHeadNames(db, userId, [...new Set(owned.map((row) => row.lineageId))]);

	/** Outcomes by `id:<curveId>` and `ck:<canonKey>`: the account's lineages, then the batch's. */
	const seen = new Map<string, Outcome>();
	const remember = (identity: Identity, outcome: Outcome): void => {
		if (!seen.has(`id:${identity.curveId}`)) seen.set(`id:${identity.curveId}`, outcome);
		if (!seen.has(`ck:${identity.canonKey}`)) seen.set(`ck:${identity.canonKey}`, outcome);
	};
	for (const row of owned) {
		const name = names.get(row.lineageId);
		if (name === undefined) continue;
		remember(row, { kind: 'lineage', lineageId: row.lineageId, name });
	}

	const recent = await countOwnLineagesSince(db, userId, now - DAY_MS);
	let quota = Math.max(0, MERGE_DAILY_MAX - recent);

	const existing = (localId: string, rawName: string, outcome: Outcome): void => {
		if (outcome.kind === 'rejected') {
			report.rejected.push({
				localId,
				code: outcome.code,
				...(outcome.reasons ? { reasons: [...outcome.reasons] } : {})
			});
			return;
		}
		const name = cleanText(rawName, false, NAME_MAX, 'name');
		if (name.ok && name.value === outcome.name) {
			report.duplicates.push({ localId, lineageId: outcome.lineageId });
		} else {
			report.conflicts.push({ localId, lineageId: outcome.lineageId, field: 'name' });
		}
	};

	for (const [index, item] of items.entries()) {
		const identity = identities[index] ?? null;
		if (identity === null) {
			const check = await checkCurve(db, item.s1, now, options.deps);
			const reasons = check.ok ? [] : check.code === 'invalid-curve' ? check.codes : check.reasons;
			report.rejected.push({ localId: item.localId, code: 'INVALID_CURVE', reasons });
			continue;
		}
		const previous = seen.get(`id:${identity.curveId}`) ?? seen.get(`ck:${identity.canonKey}`);
		if (previous) {
			existing(item.localId, item.name, previous);
			continue;
		}

		const name = cleanText(item.name, false, NAME_MAX, 'name');
		const description = cleanText(item.description ?? '', true, DESCRIPTION_MAX, 'description');
		if (!name.ok || !description.ok || name.value === '') {
			const reasons = [
				...(name.ok ? (name.value === '' ? ['env:length'] : []) : name.reasons),
				...(description.ok ? [] : description.reasons)
			];
			report.rejected.push({ localId: item.localId, code: 'INVALID_TEXT', reasons });
			continue;
		}
		if (quota <= 0) {
			report.rejected.push({ localId: item.localId, code: 'QUOTA_EXCEEDED' });
			continue;
		}

		const check = await checkCurve(db, item.s1, now, options.deps);
		if (!check.ok) {
			const outcome: Outcome =
				check.code === 'invalid-curve'
					? { kind: 'rejected', code: 'INVALID_CURVE', reasons: check.codes }
					: { kind: 'rejected', code: 'GATE_REJECTED', reasons: check.reasons };
			remember(identity, outcome);
			existing(item.localId, item.name, outcome);
			continue;
		}

		const ids = await mergeIds(userId, check.curve.canonKey);
		const published = await publishLineage(db, {
			lineageId: ids.lineageId,
			ownerUserId: userId,
			visibility: 'private',
			curve: check.curve,
			version: {
				id: ids.versionId,
				name: name.value,
				description: description.value,
				license: item.license ?? MERGE_DEFAULT_LICENSE,
				recipe: null,
				lang: item.lang ?? MERGE_DEFAULT_LANG
			},
			now
		});
		if (published.ok) {
			quota--;
			const outcome: Outcome = { kind: 'lineage', lineageId: ids.lineageId, name: name.value };
			remember(identity, outcome);
			report.created.push({ localId: item.localId, lineageId: ids.lineageId });
			continue;
		}
		if (published.code === 'duplicate') {
			// A concurrent merge created the same lineage between the lookup and this insert.
			const winner = await getLineageForViewer(db, ids.lineageId, { userId });
			if (winner && winner.ownerUserId === userId) {
				const outcome: Outcome = {
					kind: 'lineage',
					lineageId: winner.id,
					name: winner.head.name
				};
				remember(identity, outcome);
				existing(item.localId, item.name, outcome);
				continue;
			}
		}
		report.rejected.push({
			localId: item.localId,
			code: REPO_REJECT[published.code] ?? 'INTERNAL'
		});
	}
	return report;
}
