// Data of the public shared-curve page `/c/[id]` (T4.5), as the server load hands it over. Plain
// JSON (no class instances), so it crosses the SSR boundary as is. Text fields are user content:
// the components render them only through `{text}` interpolation.

export interface SharedCurveAuthor {
	username: string;
	displayUsername: string;
}

export interface SharedCurveData {
	lineageId: string;
	versionId: string;
	/** False when the share points to an older version of the lineage. */
	isHead: boolean;
	name: string;
	description: string;
	license: 'CC0-1.0' | 'CC-BY-4.0';
	lang: 'pt-BR' | 'en-US';
	/** Null for "autor removido" (anonymized account). */
	author: SharedCurveAuthor | null;
	/** S1 code of the version's curve (68 chars). */
	s1: string;
	/**
	 * Filter labels of the version by wire index of `s1` (ten entries, null = automatic name), or
	 * null. User content like `name`; never in the OG image, the meta tags or `#p=` links.
	 */
	labels?: (string | null)[] | null;
	visibility: 'private' | 'unlisted' | 'public';
	/** The share id of `?s=`, only when it belongs to this lineage. */
	shareId: string | null;
}

export interface SharedCurveMeta {
	/** Absolute canonical URL of the page (no `?s=`), also used as `og:url`. */
	canonical: string;
	/** Absolute OG image of the version, served by `/og/<versionId>.png`. */
	image: string;
	/** Only public lineages are indexable; unlisted and private ones get `noindex`. */
	indexable: boolean;
}

export interface SharedCurvePageData {
	curve: SharedCurveData;
	meta: SharedCurveMeta;
	signedIn: boolean;
}
