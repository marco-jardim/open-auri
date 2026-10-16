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
// except the allowlisted paths (sign-in, second factor and sign-out, and the guarded /admin area
// so the switch itself can be turned off and moderation keeps working during an incident).
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
	'/admin'
]);
/** Path prefixes that stay writable (the admin area; every action there is guarded and audited). */
export const READ_ONLY_ALLOWED_PREFIXES: readonly string[] = ['/admin/'];

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

/** The 503 answered to blocked writes (JSON, stable code, retryable). */
export function readOnlyResponse(): Response {
	return new Response(
		JSON.stringify({ code: READ_ONLY_CODE, message: 'The service is temporarily read-only' }),
		{
			status: 503,
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'no-store',
				'retry-after': String(READ_ONLY_RETRY_AFTER_S)
			}
		}
	);
}

/**
 * Write middleware: `null` when the request may proceed, else the 503 `READ_ONLY` response.
 * Safe methods never read KV.
 */
export async function enforceWritable(
	request: Request,
	env: ReadOnlyEnv,
	deps: ReadOnlyDeps = {}
): Promise<Response | null> {
	if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
	let pathname: string;
	try {
		pathname = new URL(request.url).pathname;
	} catch {
		pathname = '';
	}
	if (!(await isReadOnly(env, deps))) return null;
	if (pathname !== '' && isWriteAllowlisted(pathname)) return null;
	return readOnlyResponse();
}
