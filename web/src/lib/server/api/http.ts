// JSON responses, bounded JSON body parsing with zod, and the same-origin check of unsafe methods.
import type { z } from 'zod';
import { CACHE_PRIVATE_NO_STORE } from './cache.ts';
import { ApiError, type ApiJson } from './errors.ts';

export const DEFAULT_MAX_BYTES = 16_384;
export const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * JSON response. `content-type: application/json; charset=utf-8`; `cache-control` defaults to
 * `private, no-store` unless `init.headers` sets one.
 */
export function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set('content-type', 'application/json; charset=utf-8');
	if (!headers.has('cache-control')) headers.set('cache-control', CACHE_PRIVATE_NO_STORE);
	return new Response(JSON.stringify(data), { ...init, headers });
}

export interface ReadJsonOptions {
	/** Maximum body size in bytes (default 16 384). */
	maxBytes?: number;
}

function tooLarge(): ApiError {
	return new ApiError(413, 'PAYLOAD_TOO_LARGE');
}

function isJsonContentType(value: string | null): boolean {
	if (value === null) return false;
	return (value.split(';')[0] ?? '').trim().toLowerCase() === 'application/json';
}

async function readBounded(request: Request, maxBytes: number): Promise<Uint8Array> {
	const declared = request.headers.get('content-length');
	if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw tooLarge();
	if (request.body === null) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw tooLarge();
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** Zod issues reduced to `{ path, code }`: no messages, no received values (no echo of input). */
function issuesOf(error: z.ZodError): ApiJson {
	return error.issues.map((issue) => ({
		path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
		code: issue.code
	}));
}

/**
 * Reads and validates a JSON body. 415 `UNSUPPORTED_MEDIA_TYPE` without `application/json`; 413
 * `PAYLOAD_TOO_LARGE` past `maxBytes` (Content-Length or counted while streaming); 400
 * `INVALID_BODY` for empty, non-UTF-8 or malformed JSON (no details) and for schema failures
 * (`details.issues: [{ path, code }]`).
 */
export async function readJson<S extends z.ZodType>(
	request: Request,
	schema: S,
	{ maxBytes = DEFAULT_MAX_BYTES }: ReadJsonOptions = {}
): Promise<z.output<S>> {
	if (!isJsonContentType(request.headers.get('content-type'))) {
		throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE');
	}
	const bytes = await readBounded(request, maxBytes);
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch (error) {
		throw new ApiError(400, 'INVALID_BODY', undefined, { cause: error });
	}
	// reportInput: false keeps received values out of issues; jitless avoids eval in workerd.
	const parsed = await schema.safeParseAsync(value, { reportInput: false, jitless: true });
	if (!parsed.success) throw new ApiError(400, 'INVALID_BODY', { issues: issuesOf(parsed.error) });
	return parsed.data;
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1';
}

function parseOrigin(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

/**
 * For POST/PUT/PATCH/DELETE, `Origin` must be exactly `publicOrigin`; when `publicOrigin` itself
 * is a loopback origin, any `http://localhost:*` or `http://127.0.0.1:*` is also accepted (dev).
 * A missing or `null` Origin on an unsafe method is refused. Throws 403 `BAD_ORIGIN`.
 */
export function assertSameOrigin(request: Request, publicOrigin: string): void {
	if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return;
	const origin = request.headers.get('origin');
	if (origin === null || origin === 'null') throw new ApiError(403, 'BAD_ORIGIN');
	if (origin === publicOrigin) return;
	const canonical = parseOrigin(publicOrigin);
	const actual = parseOrigin(origin);
	if (
		canonical !== null &&
		actual !== null &&
		isLoopbackHost(canonical.hostname) &&
		actual.protocol === 'http:' &&
		isLoopbackHost(actual.hostname) &&
		actual.origin === origin
	) {
		return;
	}
	throw new ApiError(403, 'BAD_ORIGIN');
}
