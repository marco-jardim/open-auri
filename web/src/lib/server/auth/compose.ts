// Order of the server hooks (src/hooks.server.ts) and the read-only step, kept outside
// hooks.server.ts (which imports `$app/*`) so the order is unit-testable.
//
//   readOnly → paraglide → auth → securityHeaders → accessLog
//
// readOnly comes first: while the T3.8 switch is on, writes outside its allowlist (and the two
// state-changing Better Auth GET links) get the 503 `READ_ONLY` before any other work (no auth
// instance, no session lookup, no D1 write: the session lookup may itself refresh the session
// row, so the step cannot move after auth). The later steps never see that response, so the
// handle takes a `finish` step (hooks.server.ts passes the same security-header and access-log
// functions the securityHeaders / accessLog steps use) and runs it on the 503 only. The access
// record of a blocked request has no user id (auth did not run).
import type { Handle } from '@sveltejs/kit/hooks';
import { enforceWritable, type ReadOnlyEnv } from '../admin/read-only.ts';

export const HOOK_ORDER = [
	'readOnly',
	'paraglide',
	'auth',
	'securityHeaders',
	'accessLog'
] as const;
export type HookName = (typeof HOOK_ORDER)[number];

/** The handles in {@link HOOK_ORDER}, ready for `sequence(...)`. */
export function orderedHandles(handles: Record<HookName, Handle>): Handle[] {
	return HOOK_ORDER.map((name) => handles[name]);
}

export interface ReadOnlyHandleOptions {
	/** `building` from `$app/env`: no platform while prerendering. */
	building: boolean;
	/** `getServerEnv` (or a narrower fake in tests). */
	env: (platform: { env?: unknown }) => ReadOnlyEnv;
	/**
	 * Runs on the 503 only (the later steps never see it): security headers and access log.
	 * Must not throw; its result is what the client gets.
	 */
	finish?: (event: Parameters<Handle>[0]['event'], response: Response) => Response;
}

export function createReadOnlyHandle(options: ReadOnlyHandleOptions): Handle {
	return async ({ event, resolve }) => {
		const platform = event.platform;
		if (options.building || !platform) return resolve(event);
		const blocked = await enforceWritable(event.request, options.env(platform));
		if (!blocked) return resolve(event);
		return options.finish ? options.finish(event, blocked) : blocked;
	};
}
