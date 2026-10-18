// "Minha biblioteca" (T4.14): pure helpers of the signed-in shelves, the local-library merge and the
// share funnel. Nothing here touches the network or `window` at module load; storage is injected.
import type { AccountSummary } from '#lib/components/chrome/account.ts';
import {
	isSocialApiError,
	type LibraryMergeItem,
	type MergeReport,
	type MyShareItem,
	type SocialApi,
	type SocialErrorCode
} from '#lib/social/index.ts';

interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

/** `localStorage` subset used by the merge flag and the remembered shares. */
export interface KeyValueStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** Local (anonymous) library item fields read here (`#lib/state` `LibraryItem`). */
export interface LocalLibraryItem {
	id: string;
	name: string;
	s1: string;
	/** S5 description ('' or absent when never set). */
	description?: string;
	/** Filter labels by wire index of `s1` (null or absent when none). */
	labels?: readonly (string | null)[] | null;
	updatedAt: number;
}

export const MERGE_KEY = 'oa.biblioteca.merge';
/** Mirror the server's MERGE_GATE_RUNS_MAX, not its larger request-size limit. No server import. */
export const MERGE_BATCH = 20;
const HANDLED_MAX = 2000;

/** Rejections that will not change on a retry: the item stays local only and is not offered again. */
const PERMANENT_REJECTS: ReadonlySet<string> = new Set([
	'INVALID_CURVE',
	'GATE_REJECTED',
	'INVALID_TEXT',
	'DUPLICATE'
]);

export function defaultStorage(): KeyValueStorage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch (error) {
		console.warn(JSON.stringify({ event: 'biblioteca.storage', error: (error as Error).name }));
		return null;
	}
}

/** Stable per-account merge flag, unaffected by nickname changes or nickname reuse. */
export function accountKey(account: AccountSummary | null): string {
	return account?.id ?? '~';
}

function readJson(storage: KeyValueStorage | null, key: string): Record<string, unknown> {
	if (!storage) return {};
	try {
		const parsed: unknown = JSON.parse(storage.getItem(key) ?? '{}');
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch (error) {
		console.warn(
			JSON.stringify({ event: 'biblioteca.storage.read', error: (error as Error).name })
		);
		return {};
	}
}

function writeJson(storage: KeyValueStorage | null, key: string, value: object): void {
	if (!storage) return;
	try {
		storage.setItem(key, JSON.stringify(value));
	} catch (error) {
		console.warn(
			JSON.stringify({ event: 'biblioteca.storage.write', error: (error as Error).name })
		);
	}
}

// ---- Merge flag (per account) --------------------------------------------------------------

export interface MergeFlag {
	/** When the banner was last dismissed ("Agora não"); items not updated since are not offered. */
	offeredAt: number | null;
	/** Local ids already merged, or rejected for good (they stay local only). */
	handled: string[];
}

function isFlag(value: unknown): value is MergeFlag {
	if (typeof value !== 'object' || value === null) return false;
	const { offeredAt, handled } = value as Record<string, unknown>;
	return (
		(offeredAt === null || (typeof offeredAt === 'number' && Number.isFinite(offeredAt))) &&
		Array.isArray(handled) &&
		handled.every((id) => typeof id === 'string')
	);
}

export function readMergeFlag(storage: KeyValueStorage | null, account: string): MergeFlag {
	const value = readJson(storage, MERGE_KEY)[account];
	return isFlag(value)
		? { offeredAt: value.offeredAt, handled: [...value.handled] }
		: { offeredAt: null, handled: [] };
}

export function writeMergeFlag(
	storage: KeyValueStorage | null,
	account: string,
	flag: MergeFlag
): void {
	const all = readJson(storage, MERGE_KEY);
	all[account] = { offeredAt: flag.offeredAt, handled: flag.handled.slice(-HANDLED_MAX) };
	writeJson(storage, MERGE_KEY, all);
}

/** Local items still to offer: never handled, and new or changed since the last dismissal. */
export function unmergedItems<T extends LocalLibraryItem>(
	items: readonly T[],
	flag: MergeFlag
): T[] {
	const handled = new Set(flag.handled);
	return items.filter(
		(item) => !handled.has(item.id) && (flag.offeredAt === null || item.updatedAt > flag.offeredAt)
	);
}

export function toMergeItem(item: LocalLibraryItem, locale: string): LibraryMergeItem {
	return {
		localId: item.id,
		s1: item.s1,
		name: item.name,
		// Only a real description is sent; the server applies its own text rules to it.
		...(item.description ? { description: item.description } : {}),
		// Filter labels by wire index of `s1` (already normalized locally); only when there are any.
		...(item.labels ? { labels: [...item.labels] } : {}),
		lang: locale === 'en-US' ? 'en-US' : 'pt-BR'
	};
}

export interface MergeOutcome {
	report: MergeReport;
	/** Local ids not to offer again (merged or permanently rejected). */
	handled: string[];
	/** Code of the failure that stopped the remaining batches. */
	error: SocialErrorCode | null;
	/** Items never sent because of `error`. */
	unsent: number;
}

/**
 * Sends at most 20 items at a time, retrying quota rejections before the next fresh batch.
 * The API does not distinguish daily quotas from the per-request gate budget: stop and report
 * QUOTA_EXCEEDED after one retry pass makes no progress. Other failed requests stop immediately
 * (only cancellation throws). Transient rejections remain offerable on a later user action.
 */
export async function runMerge(
	api: Pick<SocialApi, 'mergeLibrary'>,
	items: readonly LibraryMergeItem[],
	onBatch?: (done: number, total: number) => void
): Promise<MergeOutcome> {
	const report: MergeReport = { created: [], duplicates: [], rejected: [], conflicts: [] };
	let error: SocialErrorCode | null = null;
	let sent = 0;
	batches: for (let start = 0; start < items.length; start += MERGE_BATCH) {
		let batch = items.slice(start, start + MERGE_BATCH);
		let retrying = false;
		let quotaRejected: MergeReport['rejected'] = [];
		while (batch.length > 0) {
			try {
				const answer = await api.mergeLibrary([...batch]);
				report.created.push(...answer.created);
				report.duplicates.push(...answer.duplicates);
				report.rejected.push(...answer.rejected.filter((entry) => entry.code !== 'QUOTA_EXCEEDED'));
				report.conflicts.push(...answer.conflicts);
				if (!retrying) sent += batch.length;
				quotaRejected = answer.rejected.filter((entry) => entry.code === 'QUOTA_EXCEEDED');
				onBatch?.(sent - quotaRejected.length, items.length);
				if (quotaRejected.length === 0) break;
				if (retrying && quotaRejected.length === batch.length) {
					error = 'QUOTA_EXCEEDED';
					report.rejected.push(...quotaRejected);
					break batches;
				}
				const retryIds = new Set(quotaRejected.map((entry) => entry.localId));
				batch = batch.filter((entry) => retryIds.has(entry.localId));
				retrying = true;
			} catch (cause) {
				if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
				error = isSocialApiError(cause) ? cause.code : 'INTERNAL';
				if (!isSocialApiError(cause)) {
					console.error(JSON.stringify({ event: 'biblioteca.merge', error: String(cause) }));
				}
				report.rejected.push(...quotaRejected);
				break batches;
			}
		}
	}
	const handled = [
		...report.created.map((entry) => entry.localId),
		...report.duplicates.map((entry) => entry.localId),
		...report.conflicts.map((entry) => entry.localId),
		...report.rejected
			.filter((entry) => PERMANENT_REJECTS.has(entry.code))
			.map((entry) => entry.localId)
	];
	return { report, handled, error, unsent: items.length - sent };
}

// ---- Own shares (`GET /me/shares`) ----------------------------------------------------------

/** Pages of `myShares` read when looking for the shares of one lineage. */
export const SHARES_PAGES_MAX = 10;

/**
 * The account's shares of `lineageId`, newest first as the API lists them. The endpoint lists
 * every own share, so this follows the cursor (at most `SHARES_PAGES_MAX` pages) and filters.
 */
export async function sharesOf(
	api: Pick<SocialApi, 'myShares'>,
	lineageId: string,
	signal?: AbortSignal
): Promise<MyShareItem[]> {
	const found: MyShareItem[] = [];
	let cursor: string | null = null;
	for (let pages = 0; pages < SHARES_PAGES_MAX; pages += 1) {
		const page: Page<MyShareItem> = await api.myShares({ cursor }, signal ? { signal } : {});
		found.push(...page.items.filter((share) => share.lineage.id === lineageId));
		cursor = page.nextCursor;
		if (cursor === null) break;
	}
	return found;
}

// ---- Errors --------------------------------------------------------------------------------

export type ErrorKind = 'offline' | 'auth' | 'verify' | 'gate' | 'rate' | 'missing' | 'generic';

export function errorKind(error: unknown): ErrorKind {
	if (!isSocialApiError(error)) return 'generic';
	if (error.unreachable) return 'offline';
	switch (error.code) {
		case 'AUTH_REQUIRED':
		case 'REAUTH_REQUIRED':
			return 'auth';
		case 'EMAIL_NOT_VERIFIED':
			return 'verify';
		case 'GATE_REJECTED':
			return 'gate';
		case 'RATE_LIMITED':
		case 'QUOTA_EXCEEDED':
			return 'rate';
		case 'NOT_FOUND':
		case 'GONE':
			return 'missing';
		default:
			return 'generic';
	}
}

export function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}
