// Public profiles and the opt-in public library (T4.11, plan §3.7 "Apelido público" and "Página
// pública da biblioteca"). Lookup goes through account/nickname.ts (skeleton, 90-day holds);
// data through repo.ts (getPublicProfile and the listProfile* functions, which already apply
// library_visibility / activity_visibility and the public listing rules).
//
// Rules:
//   - unknown nickname, nickname held without owner (closed account) or banned user → missing;
//   - previous nickname still on hold → redirect to the current one (only when that profile is
//     itself visible, so a ban does not leak the new nickname);
//   - any path segment that is not exactly the stored nickname (case, compatibility forms,
//     confusables, surrounding spaces) → redirect to the canonical one;
//   - counts are always given; creations and public packs only with library_visibility =
//     'public'; favorites only when activity_visibility = 'public' as well.
// DTOs never carry internal user ids.
import type { D1Database } from '@cloudflare/workers-types';
import { resolveNickname } from '#lib/server/account/nickname.ts';
import {
	getPublicProfile,
	listProfileFavorites,
	listProfileLineages,
	listProfilePacks
} from '#lib/server/social/repo.ts';
import type {
	AuthorCredit,
	Lang,
	License,
	LineageSummary,
	Page,
	PackRecord,
	PageRequest,
	PublicProfile
} from '#lib/server/social/types.ts';

export const PROFILE_LISTS = ['lineages', 'packs', 'favorites'] as const;
export type ProfileList = (typeof PROFILE_LISTS)[number];

/** First page sizes of the profile page and of the API without `?list=`. */
export const PROFILE_FIRST_PAGE: Readonly<Record<ProfileList, number>> = {
	lineages: 24,
	packs: 12,
	favorites: 12
};

/** A publicly listable lineage as profiles and packs show it. */
export interface LineageCard {
	id: string;
	name: string;
	description: string;
	license: License;
	lang: Lang;
	curveId: string;
	s1: string;
	levelDb: number | null;
	curated: boolean;
	forked: boolean;
	author: AuthorCredit | null;
	createdAt: number;
	updatedAt: number;
}

export interface PackCard {
	id: string;
	name: string;
	description: string;
	createdAt: number;
	updatedAt: number;
}

export interface FavoriteCard {
	at: number;
	lineage: LineageCard;
}

export interface ProfileDto {
	username: string;
	displayUsername: string;
	bio: string | null;
	library: 'public' | 'private';
	activity: 'public' | 'private';
	counts: { lineages: number; packs: number };
}

export interface ProfileOverview {
	profile: ProfileDto;
	lineages: Page<LineageCard> | null;
	packs: Page<PackCard> | null;
	favorites: Page<FavoriteCard> | null;
}

export type ProfileLookup =
	| { kind: 'profile'; profile: PublicProfile }
	| { kind: 'redirect'; to: string }
	| { kind: 'missing' };

const MISSING: ProfileLookup = { kind: 'missing' };

export function lineageCard(summary: LineageSummary): LineageCard {
	return {
		id: summary.id,
		name: summary.head.name,
		description: summary.head.description,
		license: summary.head.license,
		lang: summary.head.lang,
		curveId: summary.curve.id,
		s1: summary.curve.s1,
		levelDb: summary.curve.levelDb,
		curated: summary.curated,
		forked: summary.forkedFromVersion !== null,
		author: summary.author,
		createdAt: summary.createdAt,
		updatedAt: summary.updatedAt
	};
}

export function packCard(pack: PackRecord): PackCard {
	return {
		id: pack.id,
		name: pack.name,
		description: pack.description,
		createdAt: pack.createdAt,
		updatedAt: pack.updatedAt
	};
}

export function profileDto(profile: PublicProfile): ProfileDto {
	return {
		username: profile.username,
		displayUsername: profile.displayUsername,
		bio: profile.bio,
		library: profile.libraryVisibility,
		activity: profile.activityVisibility,
		counts: { lineages: profile.counts.lineages, packs: profile.counts.packs }
	};
}

/** Which lists of `profile` are public. */
export function allowedLists(profile: PublicProfile): Record<ProfileList, boolean> {
	const library = profile.libraryVisibility === 'public';
	return {
		lineages: library,
		packs: library,
		favorites: library && profile.activityVisibility === 'public'
	};
}

/** Resolves `/u/<value>`; see the rules at the top of this file. */
export async function findProfile(
	db: D1Database,
	value: string,
	now: number
): Promise<ProfileLookup> {
	if (typeof value !== 'string' || value === '' || value.length > 64) return MISSING;
	const found = await resolveNickname(db, value, now);
	if (!found || found.kind === 'held') return MISSING;
	if (found.kind === 'redirect') {
		const target = await getPublicProfile(db, found.to);
		return target ? { kind: 'redirect', to: target.username } : MISSING;
	}
	const profile = await getPublicProfile(db, found.username);
	if (!profile) return MISSING;
	// Exact string: normalizeUsername lowercases, so comparing normalized forms let other
	// spellings answer 200 under a non-canonical URL.
	if (value !== profile.username) {
		return { kind: 'redirect', to: profile.username };
	}
	return { kind: 'profile', profile };
}

/** One page of a profile list, or null when that list is not public. */
export async function loadProfileList(
	db: D1Database,
	profile: PublicProfile,
	list: 'lineages',
	page?: PageRequest
): Promise<Page<LineageCard> | null>;
export async function loadProfileList(
	db: D1Database,
	profile: PublicProfile,
	list: 'packs',
	page?: PageRequest
): Promise<Page<PackCard> | null>;
export async function loadProfileList(
	db: D1Database,
	profile: PublicProfile,
	list: 'favorites',
	page?: PageRequest
): Promise<Page<FavoriteCard> | null>;
export async function loadProfileList(
	db: D1Database,
	profile: PublicProfile,
	list: ProfileList,
	page?: PageRequest
): Promise<Page<LineageCard> | Page<PackCard> | Page<FavoriteCard> | null>;
export async function loadProfileList(
	db: D1Database,
	profile: PublicProfile,
	list: ProfileList,
	page: PageRequest = {}
): Promise<Page<LineageCard> | Page<PackCard> | Page<FavoriteCard> | null> {
	if (!allowedLists(profile)[list]) return null;
	const request: PageRequest = {
		cursor: page.cursor ?? null,
		limit: page.limit ?? PROFILE_FIRST_PAGE[list]
	};
	switch (list) {
		case 'lineages': {
			const result = await listProfileLineages(db, profile.userId, request);
			return { items: result.items.map(lineageCard), nextCursor: result.nextCursor };
		}
		case 'packs': {
			const result = await listProfilePacks(db, profile.userId, request);
			return { items: result.items.map(packCard), nextCursor: result.nextCursor };
		}
		case 'favorites': {
			const result = await listProfileFavorites(db, profile.userId, request);
			return {
				items: result.items.map((entry) => ({ at: entry.at, lineage: lineageCard(entry.lineage) })),
				nextCursor: result.nextCursor
			};
		}
	}
}

/** The profile with the first page of each public list (null for lists that are not public). */
export async function loadProfileOverview(
	db: D1Database,
	profile: PublicProfile
): Promise<ProfileOverview> {
	const [lineages, packs, favorites] = await Promise.all([
		loadProfileList(db, profile, 'lineages'),
		loadProfileList(db, profile, 'packs'),
		loadProfileList(db, profile, 'favorites')
	]);
	return { profile: profileDto(profile), lineages, packs, favorites };
}
