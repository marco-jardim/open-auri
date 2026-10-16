// Marco Civil (Lei 12.965/2014) art. 15 access-log capture (plan §3.8 and T3.3 item 7). For every
// dynamic request the Worker serves, `captureAccess` enqueues `{ ts, ip, port, user_id,
// route_group, status }` on ACCESS_LOG_QUEUE through `waitUntil`, so the response is never
// delayed. The jobs Worker (workers/jobs/src/jobs/access-log-consumer.ts) groups the records by
// hour, encrypts each batch and writes it to R2 (`access-log/`, 180-day lifecycle).
//
// The message itself is already encrypted here (AES-256-GCM, key derived from ACCESS_LOG_KEY;
// format in workers/jobs/src/jobs/access-log-crypto.js, mirrored below and cross-checked by
// tests): queue storage, retries and the dead-letter queue never hold a clear IP. Failures are
// logged with an event name and an error class only (no IP, user id, route or key).
//
// Route group = SvelteKit route id (a template such as `/u/[apelido]`, never the concrete path or
// query string, which may carry tokens). S6 routes (any `s6` segment) are reduced to `s6`, carry no
// user id, and are sent with a random delay; the consumer keeps only their day (S6 is anonymous:
// this keeps the access log from being correlated with S6 submissions).
import type { QueueSendOptions } from '@cloudflare/workers-types';
import { bytesToBase64Url, utf8 } from './encoding.ts';

/** Must equal HKDF_SALT / MESSAGE_AAD in workers/jobs/src/jobs/access-log-crypto.js. */
const HKDF_SALT = 'open-auri/access-log';
const MESSAGE_AAD = 'open-auri/access-log/message/v1';
const KEYRING_ENTRY = /^([a-z0-9]{1,16}):(.+)$/;
const MAX_ROUTE_GROUP = 128;
export const S6_GROUP = 's6';
/** Random delay applied to S6 records: 1 min to 6 h. */
export const S6_DELAY_SECONDS = { min: 60, max: 21_600 } as const;

export interface AccessRecord {
	v: 1;
	/** Request time, epoch milliseconds (UTC). */
	ts: number;
	ip: string;
	port: number | null;
	user_id: string | null;
	route_group: string;
	status: number;
}

export interface AccessEventLike {
	request: { headers: { get(name: string): string | null } };
	route: { id: string | null };
	getClientAddress?: () => string;
}

export interface AccessLogFailure {
	event: 'access_log.enqueue_failed' | 'access_log.skipped';
	reason: string;
}

export interface CaptureOptions {
	/** ACCESS_LOG_QUEUE (or a test double): only send is used and its result is ignored. */
	queue: { send(body: unknown, options?: QueueSendOptions): Promise<unknown> };
	/** ACCESS_LOG_ENABLED. */
	enabled: boolean;
	waitUntil: (promise: Promise<unknown>) => void;
	/** ACCESS_LOG_KEY (keyring; the first entry encrypts). */
	key: string;
	/** Final response status. */
	status: number;
	userId?: string | null;
	/** Client source port, when the caller has one (no standard Workers field is assumed). */
	port?: number | null;
	now?: () => number;
	log?: (failure: AccessLogFailure) => void;
}

/** ACCESS_LOG_ENABLED: on unless explicitly "false" (plan: enabled by default). */
export function isAccessLogEnabled(value: string | undefined): boolean {
	return value !== 'false';
}

export function isS6Route(routeId: string | null): boolean {
	return routeId !== null && routeId.split('/').includes(S6_GROUP);
}

export function routeGroup(routeId: string | null): string {
	if (routeId === null) return 'unmatched';
	if (isS6Route(routeId)) return S6_GROUP;
	return routeId.slice(0, MAX_ROUTE_GROUP);
}

function clientIp(event: AccessEventLike): string | null {
	const header = event.request.headers.get('cf-connecting-ip');
	if (header) return header.trim();
	try {
		return event.getClientAddress?.() ?? null;
	} catch {
		return null;
	}
}

/** Builds the record for one request (pure; exported for tests). */
export function buildAccessRecord(
	event: AccessEventLike,
	options: Pick<CaptureOptions, 'status' | 'userId' | 'port'> & { ts: number }
): AccessRecord | null {
	const ip = clientIp(event);
	if (!ip) return null;
	const group = routeGroup(event.route.id);
	const port = options.port;
	return {
		v: 1,
		ts: options.ts,
		ip,
		port:
			typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
		user_id: group === S6_GROUP ? null : (options.userId ?? null),
		route_group: group,
		status: options.status
	};
}

const keyCache = new Map<string, Promise<{ kid: string; key: CryptoKey }>>();

function currentKey(secret: string): Promise<{ kid: string; key: CryptoKey }> {
	let cached = keyCache.get(secret);
	if (!cached) {
		cached = (async () => {
			const first = secret.split(',')[0]?.trim() ?? '';
			const entry = KEYRING_ENTRY.exec(first);
			const kid = entry?.[1] ?? 'k1';
			const value = entry?.[2] ?? first;
			if (value.length < 32) throw new Error('ACCESS_LOG_KEY too short');
			const material = await crypto.subtle.importKey('raw', utf8(value), 'HKDF', false, [
				'deriveKey'
			]);
			const key = await crypto.subtle.deriveKey(
				{ name: 'HKDF', hash: 'SHA-256', salt: utf8(HKDF_SALT), info: utf8(`message:${kid}`) },
				material,
				{ name: 'AES-GCM', length: 256 },
				false,
				['encrypt']
			);
			return { kid, key };
		})();
		// One secret per isolate in practice; never let a rotated secret pile up.
		keyCache.clear();
		keyCache.set(secret, cached);
		cached.catch(() => keyCache.delete(secret));
	}
	return cached;
}

/** `{ v: 1, kid, iv, ct }`, the queue message format read by the jobs consumer. */
export async function sealAccessRecord(
	record: AccessRecord,
	secret: string
): Promise<{ v: 1; kid: string; iv: string; ct: string }> {
	const { kid, key } = await currentKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: utf8(MESSAGE_AAD) },
		key,
		utf8(JSON.stringify(record))
	);
	return { v: 1, kid, iv: bytesToBase64Url(iv), ct: bytesToBase64Url(ct) };
}

function randomDelaySeconds(): number {
	const [value = 0] = crypto.getRandomValues(new Uint32Array(1));
	const span = S6_DELAY_SECONDS.max - S6_DELAY_SECONDS.min + 1;
	return S6_DELAY_SECONDS.min + (value % span);
}

function defaultLog(failure: AccessLogFailure): void {
	console.error(JSON.stringify(failure));
}

/**
 * Schedules the access-log message for this request. Never throws and never awaits on the
 * response path; the returned promise (also handed to `waitUntil`) is for tests.
 */
export function captureAccess(event: AccessEventLike, options: CaptureOptions): Promise<void> {
	const log = options.log ?? defaultLog;
	if (!options.enabled) return Promise.resolve();
	const ts = (options.now ?? Date.now)();
	let built: AccessRecord | null;
	try {
		built = buildAccessRecord(event, { ...options, ts });
	} catch {
		built = null;
	}
	if (!built) {
		log({ event: 'access_log.skipped', reason: 'no-client-ip' });
		return Promise.resolve();
	}
	const record = built;
	const pending = (async () => {
		const body = await sealAccessRecord(record, options.key);
		const s6 = record.route_group === S6_GROUP;
		await options.queue.send(body, {
			contentType: 'json',
			...(s6 ? { delaySeconds: randomDelaySeconds() } : {})
		});
	})().catch((error: unknown) => {
		log({
			event: 'access_log.enqueue_failed',
			reason: error instanceof Error ? error.name : 'unknown'
		});
	});
	options.waitUntil(pending);
	return pending;
}
