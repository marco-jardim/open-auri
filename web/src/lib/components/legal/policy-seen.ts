// Anonymous side of the policy change notice: the last version seen lives in localStorage
// (`oa.policy.seen`). Signed-in users use policy_acceptances on the server instead.
import { POLICY_SEEN_KEY, isPolicyVersion } from '#lib/content/legal/version.ts';

export type SeenStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Where localStorage is looked up; `globalThis` in the app, a stub in tests. */
export interface StorageHost {
	readonly localStorage?: SeenStorage | null;
}

/** The host's localStorage, or null when absent or blocked. */
export function browserStorage(host: StorageHost = globalThis): SeenStorage | null {
	try {
		return host.localStorage ?? null;
	} catch {
		// Storage blocked by the browser (privacy mode, sandboxed frame).
		return null;
	}
}

/** Stores `version` as seen. Returns false when storage is unavailable or full. */
export function writePolicySeen(
	version: string,
	storage: SeenStorage | null = browserStorage()
): boolean {
	if (!storage) return false;
	try {
		storage.setItem(POLICY_SEEN_KEY, version);
		return true;
	} catch {
		return false;
	}
}

/**
 * Version to pass as the banner's `seenVersion` for an anonymous visitor.
 * - A stored valid version is returned as is (the banner shows if it differs from `current`).
 * - First visit (nothing or garbage stored): nothing changed for this visitor, so `current` is
 *   recorded and returned, and no banner shows.
 * - Without usable storage the dismissal could not be remembered, so the banner never shows.
 */
export function resolveAnonymousSeen(
	current: string,
	storage: SeenStorage | null = browserStorage()
): string {
	if (!storage) return current;
	let stored: string | null;
	try {
		stored = storage.getItem(POLICY_SEEN_KEY);
	} catch {
		return current;
	}
	if (isPolicyVersion(stored)) return stored;
	writePolicySeen(current, storage);
	return current;
}
