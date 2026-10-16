// ETag and Cache-Control for /api/v1 GET responses. Strong ETag = quoted SHA-256 (base64url) of the
// exact body bytes; If-None-Match uses the weak comparison of RFC 9110 §13.1.2 (list, `*`, `W/`).

export const CACHE_PUBLIC_60 = 'public, max-age=60, s-maxage=60';
export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
export const CACHE_PRIVATE_NO_STORE = 'private, no-store';

const JSON_TYPE = 'application/json; charset=utf-8';

/** UTF-8 bytes of a string body (as an ArrayBuffer, the type `digest` accepts everywhere). */
async function toBytes(body: string | ArrayBuffer): Promise<ArrayBuffer> {
	return typeof body === 'string' ? new Response(body).arrayBuffer() : body;
}

function base64Url(bytes: ArrayBuffer): string {
	let binary = '';
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Strong validator of `body`: `"<base64url SHA-256>"`. */
export async function strongEtag(body: string | ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', await toBytes(body));
	return `"${base64Url(digest)}"`;
}

/** Opaque tag without the weakness prefix, or `null` when malformed. */
function opaqueTag(value: string): string | null {
	const tag = value.startsWith('W/') ? value.slice(2) : value;
	return /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(tag) ? tag : null;
}

/** Entity tags listed in an If-None-Match value (quoted strings may contain commas). */
function listTags(header: string): string[] {
	return header.match(/(?:W\/)?"[^"]*"|\*/g) ?? [];
}

/**
 * True when `If-None-Match` matches `etag` (weak comparison): `*`, or any listed tag whose opaque
 * part equals the opaque part of `etag`. A missing header never matches.
 */
export function ifNoneMatch(request: Request, etag: string): boolean {
	const header = request.headers.get('if-none-match');
	if (header === null) return false;
	const current = opaqueTag(etag.trim());
	for (const tag of listTags(header)) {
		if (tag === '*') return true;
		if (current !== null && opaqueTag(tag) === current) return true;
	}
	return false;
}

export interface CachedOptions {
	/** Precomputed ETag; computed with {@link strongEtag} when absent. */
	etag?: string;
	cacheControl: string;
	/** Defaults to `application/json; charset=utf-8`. */
	contentType?: string;
	headers?: Readonly<Record<string, string>>;
}

/**
 * 304 (no body) when the request is a GET/HEAD whose If-None-Match matches, else 200 with the body.
 * Both carry `ETag` and `Cache-Control`.
 */
export async function cached(
	request: Request,
	body: string | ArrayBuffer,
	options: CachedOptions
): Promise<Response> {
	const etag = options.etag ?? (await strongEtag(body));
	const headers = new Headers(options.headers);
	headers.set('etag', etag);
	headers.set('cache-control', options.cacheControl);
	const conditional = request.method === 'GET' || request.method === 'HEAD';
	if (conditional && ifNoneMatch(request, etag)) {
		return new Response(null, { status: 304, headers });
	}
	headers.set('content-type', options.contentType ?? JSON_TYPE);
	return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}
