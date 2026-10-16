// Optional Cloudflare Access in front of /admin (plan T3.8).
//
// When both ACCESS_AUD and ACCESS_TEAM_DOMAIN are set in the Worker env, every /admin request
// must carry a valid `Cf-Access-Jwt-Assertion`: RS256, signed by a key of
// `https://<team>/cdn-cgi/access/certs`, `aud` containing ACCESS_AUD, `iss` equal to
// `https://<team>`, not expired (and not before `nbf`/`iat`, 60 s skew). Anything else fails
// closed: a missing or malformed header, an unknown key id, a JWKS fetch failure, a half-configured
// pair (only one of the two variables set).
//
// The variables are read defensively from the raw platform env (they are optional and outside
// the validated ServerEnv). The JWKS is cached per certs URL for 5 minutes; an unknown `kid`
// triggers at most one refetch per 30 s (key rotation without letting forged kids hammer Access).
// `fetch` and the clock are injectable for tests. No `$app/*`: tested inside workerd.

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
export const JWKS_TTL_MS = 5 * 60 * 1000;
const REFETCH_MIN_MS = 30 * 1000;
const CLOCK_SKEW_S = 60;
const MAX_TOKEN_LENGTH = 16 * 1024;
const TEAM_HOST =
	/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export interface AccessConfig {
	aud: string;
	/** `https://<team domain>` (no trailing slash): the expected `iss`. */
	issuer: string;
	certsUrl: string;
}

/** `null`: Access is not configured. `'invalid'`: half or badly configured (fail closed). */
export type AccessConfigResult = AccessConfig | null | 'invalid';

function readString(env: unknown, name: string): string | undefined {
	if (typeof env !== 'object' || env === null) return undefined;
	const value: unknown = Reflect.get(env, name);
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Reads ACCESS_AUD / ACCESS_TEAM_DOMAIN from the raw platform env. */
export function readAccessConfig(env: unknown): AccessConfigResult {
	const aud = readString(env, 'ACCESS_AUD');
	const team = readString(env, 'ACCESS_TEAM_DOMAIN');
	if (aud === undefined && team === undefined) return null;
	if (aud === undefined || team === undefined) return 'invalid';
	const host = team
		.replace(/^https:\/\//i, '')
		.replace(/\/+$/, '')
		.toLowerCase();
	if (!TEAM_HOST.test(host)) return 'invalid';
	const issuer = `https://${host}`;
	return { aud, issuer, certsUrl: `${issuer}/cdn-cgi/access/certs` };
}

export type AccessFailureReason =
	| 'misconfigured'
	| 'missing'
	| 'malformed'
	| 'algorithm'
	| 'unknown_key'
	| 'jwks_unavailable'
	| 'signature'
	| 'audience'
	| 'issuer'
	| 'expired'
	| 'not_yet_valid';

export type AccessResult =
	| { ok: true; configured: false }
	| { ok: true; configured: true; subject: string | null }
	| { ok: false; reason: AccessFailureReason };

export interface AccessDeps {
	fetch?: typeof fetch;
	now?: () => number;
}

interface Jwk {
	kid?: string;
	kty?: string;
	alg?: string;
	n?: string;
	e?: string;
}

interface CachedKeys {
	keys: Map<string, CryptoKey>;
	fetchedAt: number;
}

const jwksCache = new Map<string, CachedKeys>();

/** Drops the cached keys (tests, or after a forced rotation). */
export function clearAccessKeyCache(): void {
	jwksCache.clear();
}

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
	const padded = text.replace(/-/g, '+').replace(/_/g, '/');
	const full = padded + '='.repeat((4 - (padded.length % 4)) % 4);
	try {
		const binary = atob(full);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		return null;
	}
}

function decodeJson(part: string): Record<string, unknown> | null {
	const bytes = base64UrlDecode(part);
	if (!bytes) return null;
	try {
		const value: unknown = JSON.parse(
			new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
		);
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

async function importKeys(body: unknown): Promise<Map<string, CryptoKey>> {
	const keys = new Map<string, CryptoKey>();
	const list =
		typeof body === 'object' && body !== null ? (body as { keys?: unknown }).keys : undefined;
	if (!Array.isArray(list)) return keys;
	for (const raw of list as Jwk[]) {
		if (typeof raw !== 'object' || raw === null) continue;
		if (raw.kty !== 'RSA' || typeof raw.kid !== 'string' || !raw.n || !raw.e) continue;
		if (raw.alg !== undefined && raw.alg !== 'RS256') continue;
		const key = await crypto.subtle
			.importKey(
				'jwk',
				{ kty: 'RSA', n: raw.n, e: raw.e, alg: 'RS256', ext: true },
				{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
				false,
				['verify']
			)
			.catch(() => null);
		if (key) keys.set(raw.kid, key);
	}
	return keys;
}

async function fetchKeys(
	config: AccessConfig,
	deps: Required<AccessDeps>
): Promise<CachedKeys | null> {
	try {
		const response = await deps.fetch(config.certsUrl, {
			headers: { accept: 'application/json' },
			// A redirect answers 3xx (not ok) and is rejected: keys come from the certs URL only.
			redirect: 'manual'
		});
		if (!response.ok) return null;
		const keys = await importKeys(await response.json());
		if (keys.size === 0) return null;
		const entry = { keys, fetchedAt: deps.now() };
		jwksCache.set(config.certsUrl, entry);
		return entry;
	} catch {
		return null;
	}
}

async function keyFor(
	kid: string,
	config: AccessConfig,
	deps: Required<AccessDeps>
): Promise<CryptoKey | 'unknown' | 'unavailable'> {
	const now = deps.now();
	let entry = jwksCache.get(config.certsUrl);
	if (!entry || now - entry.fetchedAt >= JWKS_TTL_MS) {
		entry = (await fetchKeys(config, deps)) ?? undefined;
		if (!entry) return 'unavailable';
	} else if (!entry.keys.has(kid) && now - entry.fetchedAt >= REFETCH_MIN_MS) {
		entry = (await fetchKeys(config, deps)) ?? entry;
	}
	return entry.keys.get(kid) ?? 'unknown';
}

function numeric(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Verifies an Access JWT against `config`. Never throws. */
export async function verifyAccessJwt(
	token: string | null,
	config: AccessConfig,
	deps: AccessDeps = {}
): Promise<AccessResult> {
	const resolved: Required<AccessDeps> = {
		fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
		now: deps.now ?? Date.now
	};
	if (!token) return { ok: false, reason: 'missing' };
	if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
	const parts = token.split('.');
	if (parts.length !== 3) return { ok: false, reason: 'malformed' };
	const [headerPart = '', payloadPart = '', signaturePart = ''] = parts;
	const header = decodeJson(headerPart);
	const payload = decodeJson(payloadPart);
	const signature = base64UrlDecode(signaturePart);
	if (!header || !payload || !signature || signature.length === 0) {
		return { ok: false, reason: 'malformed' };
	}
	if (header.alg !== 'RS256') return { ok: false, reason: 'algorithm' };
	if (typeof header.kid !== 'string' || header.kid === '')
		return { ok: false, reason: 'malformed' };

	const key = await keyFor(header.kid, config, resolved);
	if (key === 'unavailable') return { ok: false, reason: 'jwks_unavailable' };
	if (key === 'unknown') return { ok: false, reason: 'unknown_key' };

	let valid: boolean;
	try {
		valid = await crypto.subtle.verify(
			'RSASSA-PKCS1-v1_5',
			key,
			signature,
			new TextEncoder().encode(`${headerPart}.${payloadPart}`)
		);
	} catch {
		valid = false;
	}
	if (!valid) return { ok: false, reason: 'signature' };

	const audience = payload.aud;
	const audiences = Array.isArray(audience) ? audience : [audience];
	if (!audiences.some((value) => value === config.aud)) return { ok: false, reason: 'audience' };
	if (payload.iss !== config.issuer) return { ok: false, reason: 'issuer' };
	const nowS = Math.floor(resolved.now() / 1000);
	const exp = numeric(payload.exp);
	if (exp === null || exp + CLOCK_SKEW_S <= nowS) return { ok: false, reason: 'expired' };
	const nbf = numeric(payload.nbf);
	const iat = numeric(payload.iat);
	if ((nbf !== null && nbf - CLOCK_SKEW_S > nowS) || (iat !== null && iat - CLOCK_SKEW_S > nowS)) {
		return { ok: false, reason: 'not_yet_valid' };
	}
	const subject = typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : null;
	return { ok: true, configured: true, subject };
}

/** Access check for a request: passes when not configured, else requires a valid JWT. */
export async function checkAccess(
	request: Request,
	rawEnv: unknown,
	deps: AccessDeps = {}
): Promise<AccessResult> {
	const config = readAccessConfig(rawEnv);
	if (config === null) return { ok: true, configured: false };
	if (config === 'invalid') return { ok: false, reason: 'misconfigured' };
	return verifyAccessJwt(request.headers.get(ACCESS_JWT_HEADER), config, deps);
}
