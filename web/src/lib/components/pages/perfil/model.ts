// Client model of /u/[apelido] (T4.11): the DTO shapes returned by the page load and by
// GET /api/v1/users/[apelido] (same as social/profiles.ts, repeated here so client code never
// imports a server module), filters, sorting and the S1 decode of the A/B preview.
import { decodeS1 } from 'open-auri/share';

export type License = 'CC0-1.0' | 'CC-BY-4.0';
export const LICENSE_OPTIONS: readonly License[] = ['CC0-1.0', 'CC-BY-4.0'];

export interface AuthorCredit {
	username: string;
	displayUsername: string;
}

export interface LineageCard {
	id: string;
	name: string;
	description: string;
	license: License;
	lang: 'pt-BR' | 'en-US';
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

export interface CardPage<T> {
	items: T[];
	nextCursor: string | null;
}

export interface ProfileView {
	profile: {
		username: string;
		displayUsername: string;
		bio: string | null;
		library: 'public' | 'private';
		activity: 'public' | 'private';
		counts: { lineages: number; packs: number };
	};
	lineages: CardPage<LineageCard> | null;
	packs: CardPage<PackCard> | null;
	favorites: CardPage<FavoriteCard> | null;
}

export type CreationSort = 'recent' | 'name' | 'level';

export interface CreationFilter {
	query: string;
	license: License | 'all';
	sort: CreationSort;
	locale: string;
}

function fold(value: string, locale: string): string {
	return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase(locale);
}

/** Creations matching the name/description query and license, in the chosen order. */
export function selectCreations(
	items: readonly LineageCard[],
	filter: CreationFilter
): LineageCard[] {
	const query = fold(filter.query.trim(), filter.locale);
	const kept = items.filter(
		(item) =>
			(filter.license === 'all' || item.license === filter.license) &&
			(query === '' ||
				fold(item.name, filter.locale).includes(query) ||
				fold(item.description, filter.locale).includes(query))
	);
	const collator = new Intl.Collator(filter.locale, { sensitivity: 'base', numeric: true });
	return kept.sort((a, b) => {
		if (filter.sort === 'name') {
			return collator.compare(a.name, b.name) || b.createdAt - a.createdAt;
		}
		if (filter.sort === 'level') {
			const left = a.levelDb ?? Number.NEGATIVE_INFINITY;
			const right = b.levelDb ?? Number.NEGATIVE_INFINITY;
			return right - left || b.createdAt - a.createdAt;
		}
		return b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);
	});
}

/** Appends a next page, skipping ids already shown (pages may overlap after edits). */
export function mergePage<T>(
	current: readonly T[],
	next: readonly T[],
	key: (item: T) => string
): T[] {
	const seen = new Set(current.map(key));
	return [...current, ...next.filter((item) => !seen.has(key(item)))];
}

export function formatDate(at: number, locale: string): string {
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(at);
}

export function formatLevel(levelDb: number | null, locale: string): string {
	if (levelDb === null || !Number.isFinite(levelDb)) return '-';
	return new Intl.NumberFormat(locale, {
		maximumFractionDigits: 1,
		minimumFractionDigits: 1,
		signDisplay: 'exceptZero'
	}).format(levelDb);
}

export type PreviewBands = ReturnType<typeof decodeS1>['bands'];

/** Bands and preamp of a published curve for the A/B preview, or null when it does not decode. */
export function previewCurve(s1: string): { bands: PreviewBands; preampDb: number } | null {
	try {
		const decoded = decodeS1(s1);
		return { bands: decoded.bands, preampDb: decoded.preampDb };
	} catch (error) {
		console.warn('Perfil preview decode failed', error instanceof Error ? error.name : 'unknown');
		return null;
	}
}
