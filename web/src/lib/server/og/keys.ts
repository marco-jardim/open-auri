// R2 layout of the OG images (T4.7, FX4.3). Dependency-free: imported by the store and by the jobs
// Worker's `og-sweep` job (workers/jobs/src/jobs/og-sweep.ts, relative import).
//
// Key: `og/<curveId>-<versionId>.png`. Curve ids never contain '-' (base32 digests), so the first
// '-' after the prefix separates the two ids. Each object carries `customMetadata.card`: the card
// layout version. Objects of another layout (or without the field, i.e. written before FX4.3, whose
// card still showed the author's nickname) are never served: the store renders them again and the
// sweep deletes them.

export const OG_PREFIX = 'og/';

/** Card layout version stored in `customMetadata.card`. "2" = no author on the card (FX4.3). */
export const OG_CARD_VERSION = '2';

const KEY_PATTERN = /^og\/([A-Za-z0-9_]{1,128})-([A-Za-z0-9_-]{1,128})\.png$/;

/** R2 key of the OG image of a version. */
export function ogKey(curveId: string, versionId: string): string {
	return `${OG_PREFIX}${curveId}-${versionId}.png`;
}

/** Inverse of {@link ogKey}; null for any key the store would never write. */
export function parseOgKey(key: string): { curveId: string; versionId: string } | null {
	const match = KEY_PATTERN.exec(key);
	if (!match) return null;
	const [, curveId, versionId] = match;
	if (curveId === undefined || versionId === undefined) return null;
	return { curveId, versionId };
}

/** Whether a stored object was written with the current card layout. */
export function isCurrentCard(customMetadata: Record<string, string> | undefined): boolean {
	return customMetadata?.card === OG_CARD_VERSION;
}
