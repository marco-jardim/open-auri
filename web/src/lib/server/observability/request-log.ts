// Structured request log (T5.2): one JSON line per dynamic request, read in Workers Logs.
//
//   { "event": "http.request", "id": "<cf-ray or random>", "route": "/api/v1/curves/[id]",
//     "method": "GET", "status": 200, "ms": 12, "code"?: "NOT_FOUND", "error"?: "TypeError" }
//
// Only the SvelteKit route id goes out (`/curva/[id]`), never the raw URL, path parameters or the
// query string (e-mailed links carry tokens there). No IP, User-Agent, e-mail, cookie, token or
// user id. This is NOT the Marco Civil access log (security/access-log.ts): that one is encrypted
// and goes to its own queue; the two never share fields or code.
//
// `ms` is wall time between the hook and the response object. Workers clocks only advance across
// I/O, so a CPU-only request may show 0. `code` is the error code of a JSON error response
// (`{ error: { code } }` of /api/v1, `{ code }` of Better Auth), read from a clone and kept only
// when it is an UPPER_SNAKE code. No `$app/*` imports: hooks.server.ts passes `building`.
import type { Handle } from '@sveltejs/kit/hooks';

export interface RequestLogLine {
	event: 'http.request';
	id: string;
	route: string;
	method: string;
	status: number;
	ms: number;
	code?: string;
	error?: string;
}

export interface RequestLogOptions {
	/** `building` from `$app/env`: no lines while prerendering. */
	building?: boolean;
	/** Line sink (default: console.log, or console.error for 5xx). */
	write?: (line: RequestLogLine) => void;
	/** Clock (tests). */
	now?: () => number;
}

const RAY = /^[0-9a-f]{16}(-[A-Z]{3})?$/i;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** Error bodies above this size are not parsed for a code. */
const CODE_BODY_MAX = 4096;

/** `cf-ray` when it has the expected shape, else a random UUID (never another header value). */
export function requestId(headers: Headers): string {
	const ray = headers.get('cf-ray');
	return ray && RAY.test(ray) ? ray : crypto.randomUUID();
}

/** The route id, or a fixed marker for requests that matched no route. */
export function routeLabel(routeId: string | null | undefined): string {
	return routeId ?? '(unmatched)';
}

function methodLabel(method: string): string {
	const upper = method.toUpperCase();
	return METHODS.has(upper) ? upper : 'OTHER';
}

function pickCode(body: unknown): string | undefined {
	if (typeof body !== 'object' || body === null) return undefined;
	const nested: unknown = Reflect.get(body, 'error');
	const candidate: unknown =
		typeof nested === 'object' && nested !== null
			? Reflect.get(nested, 'code')
			: Reflect.get(body, 'code');
	return typeof candidate === 'string' && CODE.test(candidate) ? candidate : undefined;
}

/** Error code of a JSON error response, or undefined (never throws, never logs the body). */
export async function errorCodeOf(response: Response): Promise<string | undefined> {
	if (response.status < 400 || response.bodyUsed || !response.body) return undefined;
	const type = response.headers.get('content-type') ?? '';
	if (!type.toLowerCase().startsWith('application/json')) return undefined;
	const length = Number(response.headers.get('content-length') ?? '0');
	if (length > CODE_BODY_MAX) return undefined;
	try {
		const text = await response.clone().text();
		if (text.length > CODE_BODY_MAX) return undefined;
		return pickCode(JSON.parse(text));
	} catch {
		// Not JSON (or a stream that cannot be cloned): the line just has no code.
		return undefined;
	}
}

function defaultWrite(line: RequestLogLine): void {
	const text = JSON.stringify(line);
	if (line.status >= 500) console.error(text);
	else console.log(text);
}

/**
 * Handle factory: logs one line per request after `resolve`. Put it right after the platform
 * shim so the latency covers every other hook (the read-only 503 included). A thrown error is
 * logged as status 500 with its class name and rethrown unchanged.
 */
export function createRequestLogHandle(options: RequestLogOptions = {}): Handle {
	const write = options.write ?? defaultWrite;
	const now = options.now ?? (() => Date.now());
	return async ({ event, resolve }) => {
		if (options.building) return resolve(event);
		const started = now();
		const base = {
			event: 'http.request' as const,
			id: requestId(event.request.headers),
			route: routeLabel(event.route.id),
			method: methodLabel(event.request.method)
		};
		let response: Response;
		try {
			response = await resolve(event);
		} catch (error) {
			write({
				...base,
				status: 500,
				ms: Math.max(0, now() - started),
				error: error instanceof Error ? error.name : typeof error
			});
			throw error;
		}
		const line: RequestLogLine = {
			...base,
			status: response.status,
			ms: Math.max(0, now() - started)
		};
		const code = await errorCodeOf(response);
		if (code) line.code = code;
		write(line);
		return response;
	};
}
