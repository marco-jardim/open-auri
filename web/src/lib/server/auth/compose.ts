// Order of the server hooks (src/hooks.server.ts) and the read-only step, kept outside
// hooks.server.ts (which imports `$app/*`) so the order is unit-testable.
//
//   readOnly → paraglide → auth → securityHeaders → accessLog
//
// readOnly comes first: while the T3.8 switch is on, writes outside its allowlist get the 503
// `READ_ONLY` before any other work (no auth instance, no session lookup, no D1 write). Its
// response is not wrapped by the later steps (static JSON with no-store; no security headers
// beyond what it sets, no access-log record).
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
}

export function createReadOnlyHandle(options: ReadOnlyHandleOptions): Handle {
	return async ({ event, resolve }) => {
		const platform = event.platform;
		if (options.building || !platform) return resolve(event);
		return (await enforceWritable(event.request, options.env(platform))) ?? resolve(event);
	};
}
