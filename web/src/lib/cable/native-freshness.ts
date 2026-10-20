import { version } from '$app/env';
import { resolve } from '$app/paths';

/** Maximum time a native write may wait for the deployed write policy. */
export const NATIVE_FRESHNESS_TIMEOUT_MS = 3000;

/**
 * `localStorage` key of the last live confirmation, `{ version, checkedAt }`: a deploy version
 * id and a timestamp (technical, non-personal).
 */
export const NATIVE_LAST_GOOD_KEY = 'oa.cable.nativeLastGood.v1';

export class NativeFreshnessError extends Error {
	constructor(
		readonly reason: 'newer' | 'unavailable',
		options?: ErrorOptions
	) {
		super(`Native write policy freshness: ${reason}`, options);
		this.name = 'NativeFreshnessError';
	}
}

/** What cleared a native write. */
export interface NativeWriteFreshness {
	/** `live`: confirmed now; `last-good`: the check failed, so on its last confirmation. */
	basis: 'live' | 'last-good';
	/** When the server last confirmed this build (epoch ms). */
	checkedAt: number;
}

/** The part of `Storage` the last-good record uses. */
export type NativeLastGoodStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface NativeFreshnessDeps {
	fetch?: typeof globalThis.fetch;
	version?: string;
	/** Where the last-good record lives (default `localStorage`; null: none, so offline refuses). */
	storage?: NativeLastGoodStorage | null;
	now?: () => number;
}

interface LastGood {
	version: string;
	checkedAt: number;
}

function browserStorage(): NativeLastGoodStorage | null {
	try {
		const storage = (globalThis as { localStorage?: Partial<Storage> | null }).localStorage;
		if (
			typeof storage === 'object' &&
			storage !== null &&
			typeof storage.getItem === 'function' &&
			typeof storage.setItem === 'function' &&
			typeof storage.removeItem === 'function'
		) {
			return storage as NativeLastGoodStorage;
		}
	} catch (cause) {
		console.warn('native last-good storage unavailable', cause);
	}
	return null;
}

/** Largest valid `Date` value (epoch ms): a later `checkedAt` is no time at all. */
const MAX_EPOCH_MS = 8.64e15;

/** The stored string; null when absent or unreadable (a read failure only warns). */
function readRaw(storage: NativeLastGoodStorage | null): string | null {
	if (storage === null) return null;
	try {
		const raw = storage.getItem(NATIVE_LAST_GOOD_KEY);
		return typeof raw === 'string' ? raw : null;
	} catch (cause) {
		console.warn('native last-good read failed', cause);
		return null;
	}
}

/** The stored record; null when absent, unreadable or not exactly `{ version, checkedAt }`. */
function readLastGood(storage: NativeLastGoodStorage | null): LastGood | null {
	const raw = readRaw(storage);
	return raw === null ? null : parseLastGood(raw);
}

function parseLastGood(raw: string): LastGood | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const keys = Object.keys(value);
	if (keys.length !== 2 || !keys.includes('version') || !keys.includes('checkedAt')) return null;
	const record = value as Record<string, unknown>;
	const stored = record.version;
	const checkedAt = record.checkedAt;
	if (typeof stored !== 'string' || stored.length === 0) return null;
	if (
		typeof checkedAt !== 'number' ||
		!Number.isSafeInteger(checkedAt) ||
		checkedAt < 0 ||
		checkedAt > MAX_EPOCH_MS
	) {
		return null;
	}
	return { version: stored, checkedAt };
}

/** Records (or with null clears) the last-good confirmation; storage failures only warn. */
function writeLastGood(storage: NativeLastGoodStorage | null, record: LastGood | null): void {
	if (storage === null) return;
	try {
		if (record === null) storage.removeItem(NATIVE_LAST_GOOD_KEY);
		else storage.setItem(NATIVE_LAST_GOOD_KEY, JSON.stringify(record));
	} catch (cause) {
		console.warn('native last-good write failed', cause);
	}
}

/**
 * Forgets the last-good record: this device has seen that native writes are disabled or that
 * a newer deploy exists, so no page may write offline on an older confirmation. Never throws.
 */
export function forgetNativeLastGood(
	storage: NativeLastGoodStorage | null = browserStorage()
): void {
	writeLastGood(storage, null);
}

/**
 * At page start in the app: keeps the record only when it is a valid confirmation of this very
 * build (`build`), else removes it. A page the service worker serves offline can be older than
 * the last page this device ran; it must never write on another build's confirmation. Never
 * throws.
 */
export function reconcileNativeLastGood(
	build: string = version,
	storage: NativeLastGoodStorage | null = browserStorage()
): void {
	const raw = readRaw(storage);
	if (raw === null) return;
	if (parseLastGood(raw)?.version !== build) writeLastGood(storage, null);
}

/** One bounded live check of the deployed version; throws only `NativeFreshnessError`. */
async function checkLive(fetcher: typeof globalThis.fetch, build: string): Promise<void> {
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				reject(new NativeFreshnessError('unavailable'));
				abort.abort();
			}, NATIVE_FRESHNESS_TIMEOUT_MS);
		});
		const check = async () => {
			const response = await fetcher(`${resolve('/')}_app/version.json`, {
				cache: 'no-store',
				headers: { 'cache-control': 'no-cache' },
				signal: abort.signal
			});
			if (!response.ok) throw new NativeFreshnessError('unavailable');
			const data: unknown = await response.json();
			if (
				typeof data !== 'object' ||
				data === null ||
				!('version' in data) ||
				typeof data.version !== 'string' ||
				data.version.length === 0
			) {
				throw new NativeFreshnessError('unavailable');
			}
			if (data.version !== build) throw new NativeFreshnessError('newer');
		};
		// Race the whole operation, including JSON, even if a fetcher ignores the abort signal.
		await Promise.race([check(), timeout]);
	} catch (cause) {
		if (cause instanceof NativeFreshnessError) throw cause;
		throw new NativeFreshnessError('unavailable', { cause });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Kit 3 emits { version } at `${appDir}/version.json`; this app uses the default `_app`.
 * Resolving the root route includes any configured base path.
 * Do not use updated.check() here: Kit returns false on network/HTTP failures too.
 *
 * Every native write asks the server first. A live match clears it and is remembered as the
 * last-good confirmation of this build (`NATIVE_LAST_GOOD_KEY`). A different deployed version
 * refuses (`newer`) and forgets that record. The record is also forgotten whenever this device
 * sees a newer deploy or disabled native writes by other means (`forgetNativeLastGood`: Kit's
 * `updated`, detection) and, at page start, when it names another build
 * (`reconcileNativeLastGood`), so a device that saw a newer deploy never writes offline from an
 * older page. When the check is unavailable (offline, a blocked `version.json`, timeout, HTTP
 * error, malformed data), the write proceeds optimistically, with no expiry, only on a valid
 * last-good record of this same build; otherwise it refuses (`unavailable`). So a remote change
 * to the write policy reaches such a device only once its check succeeds again.
 */
export async function assertNativeWriteFresh(
	deps: NativeFreshnessDeps = {}
): Promise<NativeWriteFreshness> {
	const build = deps.version ?? version;
	const storage = deps.storage === undefined ? browserStorage() : deps.storage;
	try {
		await checkLive(deps.fetch ?? globalThis.fetch, build);
	} catch (cause) {
		const error =
			cause instanceof NativeFreshnessError
				? cause
				: new NativeFreshnessError('unavailable', { cause });
		if (error.reason === 'newer') {
			writeLastGood(storage, null);
			throw error;
		}
		const lastGood = readLastGood(storage);
		if (lastGood !== null && lastGood.version === build) {
			return { basis: 'last-good', checkedAt: lastGood.checkedAt };
		}
		throw error;
	}
	const checkedAt = deps.now?.() ?? Date.now();
	writeLastGood(storage, { version: build, checkedAt });
	return { basis: 'live', checkedAt };
}
