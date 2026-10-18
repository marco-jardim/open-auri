// R2 layout of the OG images (T4.7, FX4.3). Dependency-free: imported by the store and by the jobs
// Worker's `og-sweep` job (workers/jobs/src/jobs/og-sweep.ts, relative import).
//
// Key: `og/<curveId>-<versionId>.png`. Curve ids never contain '-' (base32 digests), so the first
// '-' after the prefix separates the two ids. Each object carries `customMetadata.card`: the card
// layout version. Objects of another layout (or without the field, i.e. written before FX4.3, whose
// card still showed the author's nickname) are never served: the store renders them again and the
// sweep deletes them.

export const OG_PREFIX = 'og/';

/**
 * Card layout version stored in `customMetadata.card`. "2" = no author on the card (FX4.3); "3" =
 * the YOLO chip (migration 0013), with `customMetadata.yolo` ("1" or "0") recording whether the
 * stored card has it.
 */
export const OG_CARD_VERSION = '3';

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

/** `customMetadata.yolo` of a card: "1" with the YOLO chip, "0" without. */
export function yoloFlag(yolo: boolean): string {
	return yolo ? '1' : '0';
}

/**
 * Whether a stored object was written with the current card layout and, when `yolo` is given,
 * with the same YOLO chip (a curve re-classified since keeps its key, so the flag tells the store
 * to render it again). The sweep passes no `yolo`: it only drops old layouts.
 */
export function isCurrentCard(
	customMetadata: Record<string, string> | undefined,
	yolo?: boolean
): boolean {
	if (customMetadata?.card !== OG_CARD_VERSION) return false;
	return yolo === undefined || customMetadata.yolo === yoloFlag(yolo);
}
