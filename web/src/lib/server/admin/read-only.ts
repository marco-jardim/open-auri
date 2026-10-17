// Emergency "read-only" switch (plan T3.8). Stored in KV `CONFIG` under `mode:read-only`: the
// value "1" turns it on, an absent key means off (any other value counts as off).
//
// `isReadOnly(env)` keeps the value in an in-isolate cache for at most 10 s, so the hook costs
// one KV read per isolate per 10 s. KV itself is eventually consistent (a change can take up to
// about 60 s to reach every location); the toggle clears the cache of the isolate that served it.
// A KV read failure keeps the last known value (or "off" when there is none) and logs a line
// without request data: an unreachable KV must not take the whole site down.
//
// `enforceWritable(request, env)` is the write middleware for hooks.server.ts: while the switch
// is on, every request other than GET/HEAD/OPTIONS gets 503 with the stable code `READ_ONLY`,
// except the allowlisted paths (sign-in, second factor and sign-out, the LGPD export, which only
// reads, the signature-verified Resend webhook, whose bounce suppression is a safety write, and
// the guarded /admin area so the switch itself can be turned off and moderation keeps
// working during an incident). Better Auth also changes state on two GET links sent by e-mail
// (`/api/auth/verify-email`: marks the address verified, switches e-mail, creates a session,
// sends mail; `/api/auth/delete-user/callback`: runs the deletion policy and deletes the user),
// so GET/HEAD on those paths are blocked too while the switch is on. Blocked browser navigations
// (Accept: text/html) get a small static HTML page (own CSP: it loads nothing) instead of the
// JSON body; both carry 503,
// `Retry-After`, `Cache-Control: no-store` and the code `READ_ONLY` (`x-error-code` header).
// The 503 skips the later hooks, so hooks.server.ts hands `createReadOnlyHandle` a `finish`
// step that adds the security headers and the access-log record to it (auth/compose.ts).
// No `$app/*`: tested inside workerd.
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import { audited, AUDIT_ACTIONS, type AuditOptions } from './audit.ts';

export const READ_ONLY_KEY = 'mode:read-only';
export const READ_ONLY_CODE = 'READ_ONLY';
export const READ_ONLY_CACHE_MS = 10_000;
export const READ_ONLY_RETRY_AFTER_S = 300;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Exact paths that stay writable while read-only is on. */
export const READ_ONLY_ALLOWED_PATHS: ReadonlySet<string> = new Set([
	'/api/auth/sign-in/email',
	'/api/auth/sign-in/username',
	'/api/auth/two-factor/verify-totp',
	'/api/auth/two-factor/verify-backup-code',
	'/api/auth/sign-out',
	// LGPD access right: the export is a POST (CSRF and download semantics) but only reads.
	'/conta/exportar',
	// Resend bounce/complaint events (signature-verified): suppressing bounced addresses is a
	// safety write, and Resend only retries for a limited time.
	'/api/webhooks/resend',
	'/admin'
]);
/** Path prefixes that stay writable (the admin area; every action there is guarded and audited). */
export const READ_ONLY_ALLOWED_PREFIXES: readonly string[] = ['/admin/'];

/**
 * Better Auth endpoints that change state on GET (e-mailed links). Blocked for GET/HEAD while
 * read-only is on; matched after {@link normalizeForBlocklist} (blocking more is always safe).
 */
export const READ_ONLY_BLOCKED_GET_PATHS: ReadonlySet<string> = new Set([
	'/api/auth/verify-email',
	'/api/auth/delete-user/callback'
]);

interface CacheEntry {
	value: boolean;
	at: number;
}

const cache = new WeakMap<object, CacheEntry>();

export interface ReadOnlyEnv {
	config: KVNamespace;
}

export interface ReadOnlyDeps {
	now?: () => number;
	log?: (line: string) => void;
}

/** Drops the cached value for `env.config` (after a toggle; tests). */
export function forgetReadOnly(env: ReadOnlyEnv): void {
	cache.delete(env.config);
}

/** Whether the read-only switch is on (cached ≤ 10 s per isolate). */
export async function isReadOnly(env: ReadOnlyEnv, deps: ReadOnlyDeps = {}): Promise<boolean> {
	const now = (deps.now ?? Date.now)();
	const cached = cache.get(env.config);
	if (cached && now - cached.at >= 0 && now - cached.at < READ_ONLY_CACHE_MS) return cached.value;
	let value: boolean;
	try {
		value = (await env.config.get(READ_ONLY_KEY)) === '1';
	} catch (error) {
		(deps.log ?? console.warn)(
			JSON.stringify({
				event: 'admin.read_only_lookup_failed',
				reason: error instanceof Error ? error.name : 'unknown'
			})
		);
		value = cached?.value ?? false;
	}
	cache.set(env.config, { value, at: now });
	return value;
}

/** Turns the switch on or off, audit-first (actor = the admin). */
export async function setReadOnly(
	env: ReadOnlyEnv & { db: D1Database },
	on: boolean,
	actorId: string,
	options: AuditOptions = {}
): Promise<void> {
	await audited(
		env.db,
		{
			actorId,
			actorKind: 'admin',
			action: on ? AUDIT_ACTIONS.readOnlyOn : AUDIT_ACTIONS.readOnlyOff,
			targetKind: 'config',
			targetId: READ_ONLY_KEY
		},
		async () => {
			if (on) await env.config.put(READ_ONLY_KEY, '1');
			else await env.config.delete(READ_ONLY_KEY);
		},
		options
	);
	forgetReadOnly(env);
}

/** Whether `pathname` stays writable while read-only is on. */
export function isWriteAllowlisted(pathname: string): boolean {
	if (READ_ONLY_ALLOWED_PATHS.has(pathname)) return true;
	return READ_ONLY_ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Lenient form of `pathname` for the GET blocklist only: percent-decoded, dot segments resolved,
 * repeated and trailing slashes dropped, lowercase. (The write allowlist stays exact.)
 */
export function normalizeForBlocklist(pathname: string): string {
	let path = pathname;
	try {
		path = decodeURIComponent(path);
	} catch {
		// Keep the raw form; malformed escapes cannot route anywhere useful.
	}
	try {
		path = new URL(path.replace(/\/{2,}/g, '/'), 'https://normalize.invalid').pathname;
	} catch {
		// Keep what we have.
	}
	path = path.replace(/\/{2,}/g, '/').toLowerCase();
	while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
	return path;
}

/** Whether a GET/HEAD to `pathname` changes state and is blocked while read-only is on. */
export function isBlockedGet(pathname: string): boolean {
	return READ_ONLY_BLOCKED_GET_PATHS.has(normalizeForBlocklist(pathname));
}

function wantsHtml(request: Request | undefined): boolean {
	if (!request) return false;
	if (request.headers.get('sec-fetch-mode')?.toLowerCase() === 'navigate') return true;
	return (request.headers.get('accept') ?? '').toLowerCase().includes('text/html');
}

// Runs before paraglide (no locale yet): static, bilingual, no scripts or styles.
const READ_ONLY_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Somente leitura</title>
</head>
<body data-code="${READ_ONLY_CODE}">
<main>
<h1>O site está temporariamente em modo somente leitura</h1>
<p>Nada foi alterado. Tente de novo em alguns minutos. Se você abriu um link recebido por e-mail e ele expirar nesse meio-tempo, peça um novo.</p>
<div lang="en-US">
<h2>The site is temporarily read-only</h2>
<p>Nothing was changed. Please try again in a few minutes. If you opened a link from an e-mail and it expires meanwhile, request a new one.</p>
</div>
<p><a href="/">Página inicial · Home</a></p>
</main>
</body>
</html>
`;

/**
 * CSP of the static HTML page: it loads nothing. `applySecurityHeaders` keeps a policy that already
 * has `frame-ancestors` and only adds the other security headers.
 */
export const READ_ONLY_HTML_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

/**
 * The 503 answered to blocked requests: JSON with the stable code, or a small HTML page for
 * browser navigations. Always retryable, never cached, `x-error-code: READ_ONLY`.
 */
export function readOnlyResponse(request?: Request): Response {
	const html = wantsHtml(request);
	const body = html
		? READ_ONLY_HTML
		: JSON.stringify({ code: READ_ONLY_CODE, message: 'The service is temporarily read-only' });
	const headers: Record<string, string> = {
		'content-type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'retry-after': String(READ_ONLY_RETRY_AFTER_S),
		'x-error-code': READ_ONLY_CODE
	};
	if (html) headers['content-security-policy'] = READ_ONLY_HTML_CSP;
	return new Response(request?.method.toUpperCase() === 'HEAD' ? null : body, {
		status: 503,
		headers
	});
}

/**
 * Write middleware: `null` when the request may proceed, else the 503 `READ_ONLY` response.
 * Safe methods never read KV, except GET/HEAD on {@link READ_ONLY_BLOCKED_GET_PATHS}.
 */
export async function enforceWritable(
	request: Request,
	env: ReadOnlyEnv,
	deps: ReadOnlyDeps = {}
): Promise<Response | null> {
	const method = request.method.toUpperCase();
	let pathname: string;
	try {
		pathname = new URL(request.url).pathname;
	} catch {
		pathname = '';
	}
	if (SAFE_METHODS.has(method)) {
		if (method === 'OPTIONS' || !isBlockedGet(pathname)) return null;
		if (!(await isReadOnly(env, deps))) return null;
		return readOnlyResponse(request);
	}
	if (!(await isReadOnly(env, deps))) return null;
	if (pathname !== '' && isWriteAllowlisted(pathname)) return null;
	return readOnlyResponse(request);
}
