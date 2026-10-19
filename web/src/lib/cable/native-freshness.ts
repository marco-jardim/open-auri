import { version } from '$app/env';
import { resolve } from '$app/paths';

/** Maximum time a native write may wait for the deployed write policy. */
export const NATIVE_FRESHNESS_TIMEOUT_MS = 3000;

export class NativeFreshnessError extends Error {
	constructor(
		readonly reason: 'newer' | 'unavailable',
		options?: ErrorOptions
	) {
		super(`Native write policy freshness: ${reason}`, options);
		this.name = 'NativeFreshnessError';
	}
}

export interface NativeFreshnessDeps {
	fetch?: typeof globalThis.fetch;
	version?: string;
}

/**
 * Kit 3 emits { version } at `${appDir}/version.json`; this app uses the default `_app`.
 * Resolving the root route includes any configured base path.
 * Do not use updated.check() here: Kit returns false on network/HTTP failures too.
 * Nothing is cached or remembered: every native write must confirm the current deploy.
 */
export async function assertNativeWriteFresh(deps: NativeFreshnessDeps = {}): Promise<void> {
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
			const response = await (deps.fetch ?? globalThis.fetch)(`${resolve('/')}_app/version.json`, {
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
			if (data.version !== (deps.version ?? version)) throw new NativeFreshnessError('newer');
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
