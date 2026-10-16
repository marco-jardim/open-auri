// Packs (S9, T4.11): create, edit (name, description, visibility, ordered items), delete and
// read. Data access through repo.ts (createPack, updatePack, setPackItems, deletePack,
// getPackForViewer) and queries/packs.ts (head licenses for the per-item license check).
//
// Rules:
//   - only the owner edits or deletes; someone else's pack and a missing pack both answer 404;
//   - items are an ordered list (positions 0..n-1), at most PACK_ITEMS_MAX, no repeats; each
//     lineage must be readable by the owner (own lineage in any state, or public/unlisted);
//   - the license of each item is the license of the lineage's head version (copied by the
//     repository); a client that sends a license must send that one, otherwise 409 CONFLICT
//     with `details.reason = 'license-mismatch'` (so nobody relicenses someone else's curve);
//   - readers who are not the owner only see items that are publicly listable lineages
//     (getPackForViewer); private and unlisted lineages never show in someone else's pack;
//   - name and description go through normalizeText (NFKC, no invisibles or bidi, no URLs).
import type { D1Database } from '@cloudflare/workers-types';
import { normalizeText } from 'open-auri/share';
import { ApiError, type ApiErrorCode } from '#lib/server/api/index.ts';
import { headLicensesForOwner } from '#lib/server/social/queries/packs.ts';
import {
	createPack,
	deletePack,
	getPackForViewer,
	isSocialId,
	setPackItems,
	updatePack
} from '#lib/server/social/repo.ts';
import {
	DESCRIPTION_MAX,
	NAME_MAX,
	PACK_ITEMS_MAX,
	type AuthorCredit,
	type License,
	type PackView,
	type PackVisibility,
	type SocialErrorCode,
	type Viewer
} from '#lib/server/social/types.ts';
import { lineageCard, type LineageCard } from '#lib/server/social/profiles.ts';

export interface PackItemDto {
	position: number;
	license: License;
	lineage: LineageCard;
}

export interface PackDto {
	id: string;
	name: string;
	description: string;
	visibility: PackVisibility;
	author: AuthorCredit | null;
	/** True when the viewer owns the pack (and sees every item they can read). */
	owned: boolean;
	createdAt: number;
	updatedAt: number;
	items: PackItemDto[];
}

export interface PackItemInput {
	lineageId: string;
	license?: License | undefined;
}

export interface PackFieldsInput {
	name?: string | undefined;
	description?: string | undefined;
	visibility?: PackVisibility | undefined;
}

export interface PackEditInput extends PackFieldsInput {
	items?: readonly PackItemInput[] | undefined;
}

export interface PackCreateInput extends PackEditInput {
	name: string;
}

const REPO_TO_API: Readonly<Record<SocialErrorCode, readonly [number, ApiErrorCode]>> = {
	'not-found': [404, 'NOT_FOUND'],
	'invalid-input': [400, 'INVALID_BODY'],
	'invalid-cursor': [400, 'INVALID_CURSOR'],
	'head-moved': [409, 'HEAD_MOVED'],
	'gate-rejected': [422, 'GATE_REJECTED'],
	retracted: [410, 'GONE'],
	duplicate: [409, 'DUPLICATE'],
	'already-active': [409, 'ALREADY_ACTIVE'],
	limit: [429, 'QUOTA_EXCEEDED']
};

/** ApiError for a repository error code (mapping of the F4 brief). */
export function repoError(code: SocialErrorCode): ApiError {
	const [status, apiCode] = REPO_TO_API[code];
	return new ApiError(status, apiCode);
}

function invalid(path: string, code: string): ApiError {
	return new ApiError(400, 'INVALID_BODY', { issues: [{ path, code }] });
}

/** Normalized free text; empty descriptions stay empty, names need at least one character. */
export function cleanPackText(field: 'name' | 'description', value: string): string {
	const multiline = field === 'description';
	let text: string;
	if (value.trim() === '') {
		text = '';
	} else {
		try {
			text = normalizeText(value, { multiline, path: `/${field}` });
		} catch (error) {
			throw new ApiError(
				400,
				'INVALID_BODY',
				{ issues: [{ path: field, code: 'text' }] },
				{
					cause: error
				}
			);
		}
	}
	const length = [...text].length;
	const max = field === 'name' ? NAME_MAX : DESCRIPTION_MAX;
	if ((field === 'name' && length === 0) || length > max) throw invalid(field, 'length');
	return text;
}

function cleanFields(input: PackFieldsInput): {
	name?: string;
	description?: string;
	visibility?: PackVisibility;
} {
	return {
		...(input.name === undefined ? {} : { name: cleanPackText('name', input.name) }),
		...(input.description === undefined
			? {}
			: { description: cleanPackText('description', input.description) }),
		...(input.visibility === undefined ? {} : { visibility: input.visibility })
	};
}

/**
 * Validates the ordered items for `ownerUserId`: size, repeats, ids, readability and the
 * per-item license against the head version. Returns the lineage ids in order.
 */
export async function checkPackItems(
	db: D1Database,
	ownerUserId: string,
	items: readonly PackItemInput[]
): Promise<string[]> {
	if (items.length > PACK_ITEMS_MAX) throw invalid('items', 'too-many');
	const ids = items.map((item) => item.lineageId);
	if (!ids.every(isSocialId)) throw invalid('items', 'invalid-id');
	if (new Set(ids).size !== ids.length) throw invalid('items', 'duplicate');
	const heads = await headLicensesForOwner(db, ownerUserId, ids);
	items.forEach((item, index) => {
		const head = heads.get(item.lineageId);
		if (head === undefined) throw new ApiError(404, 'NOT_FOUND', { index });
		if (item.license !== undefined && item.license !== head) {
			throw new ApiError(409, 'CONFLICT', { reason: 'license-mismatch', index, license: head });
		}
	});
	return ids;
}

export function packDto(pack: PackView, owned: boolean): PackDto {
	return {
		id: pack.id,
		name: pack.name,
		description: pack.description,
		visibility: pack.visibility,
		author: pack.author,
		owned,
		createdAt: pack.createdAt,
		updatedAt: pack.updatedAt,
		items: pack.items.map((item) => ({
			position: item.position,
			license: item.license,
			lineage: lineageCard(item.lineage)
		}))
	};
}

/** A pack as `viewer` may see it, or null (missing, private, moderated or owner banned). */
export async function viewPack(
	db: D1Database,
	packId: string,
	viewer: Viewer
): Promise<PackDto | null> {
	if (!isSocialId(packId)) return null;
	const pack = await getPackForViewer(db, packId, viewer);
	if (!pack) return null;
	const owned = viewer.userId !== null && pack.ownerUserId === viewer.userId;
	return packDto(pack, owned);
}

async function ownView(db: D1Database, packId: string, ownerUserId: string): Promise<PackDto> {
	const view = await viewPack(db, packId, { userId: ownerUserId });
	if (!view) throw new ApiError(404, 'NOT_FOUND');
	return view;
}

export async function createOwnPack(
	db: D1Database,
	ownerUserId: string,
	input: PackCreateInput,
	now: number
): Promise<PackDto> {
	const name = cleanPackText('name', input.name);
	const description =
		input.description === undefined ? '' : cleanPackText('description', input.description);
	const ids = input.items ? await checkPackItems(db, ownerUserId, input.items) : null;
	const id = crypto.randomUUID();
	const created = await createPack(db, {
		id,
		ownerUserId,
		name,
		description,
		visibility: input.visibility ?? 'private',
		now
	});
	if (!created.ok) throw repoError(created.code);
	if (ids && ids.length > 0) {
		const set = await setPackItems(db, id, ownerUserId, ids, now);
		if (!set.ok) throw repoError(set.code);
	}
	return ownView(db, id, ownerUserId);
}

export async function editOwnPack(
	db: D1Database,
	packId: string,
	ownerUserId: string,
	input: PackEditInput,
	now: number
): Promise<PackDto> {
	if (!isSocialId(packId)) throw new ApiError(404, 'NOT_FOUND');
	const fields = cleanFields(input);
	const ids = input.items ? await checkPackItems(db, ownerUserId, input.items) : null;
	// Also the ownership check: someone else's pack changes nothing and reads as not found.
	const updated = await updatePack(db, packId, ownerUserId, fields, now);
	if (!updated.ok) throw repoError(updated.code);
	if (ids) {
		const set = await setPackItems(db, packId, ownerUserId, ids, now);
		if (!set.ok) throw repoError(set.code);
	}
	return ownView(db, packId, ownerUserId);
}

export async function removeOwnPack(
	db: D1Database,
	packId: string,
	ownerUserId: string
): Promise<boolean> {
	if (!isSocialId(packId)) return false;
	return deletePack(db, packId, ownerUserId);
}
