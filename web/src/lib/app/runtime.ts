// On-demand app runtime (FUX.2, spec docs/plans/fux-spec.md §5.3 L1 and §5.4 W2). The client
// runtime (catalog, safety, policy, audio engine, cable service, state) is a dynamic chunk: the
// root layout imports it at once on instrument routes and when a write was interrupted (rescue
// marker), and on idle (or the first interaction that needs it) everywhere else.
//
// Keep this module tiny and free of static imports of the runtime: everything here sits in the
// static closure of every route.
import type * as ClientRuntime from './client.svelte.ts';

export type AppRuntime = typeof ClientRuntime;

/**
 * Same key as `CABLE_INFLIGHT_KEY` (`#lib/cable/service.ts`); a unit test pins the equality, so
 * the layout can read the marker without importing the cable service.
 */
export const INFLIGHT_MARKER_KEY = 'oa.cable.inflight';

/** Routes whose page drives the runtime from the first paint (editor, audio, cable, social). */
export const INSTRUMENT_ROUTES: ReadonlySet<string> = new Set([
	'/',
	'/comparar',
	'/soe-como-x',
	'/cabo',
	'/teste-cego',
	'/biblioteca',
	'/comunidade',
	'/c/[id]',
	'/u/[apelido]'
]);

/** Auth pages that render Turnstile (W7: preconnect to its origin only there). */
export const TURNSTILE_ROUTES: ReadonlySet<string> = new Set([
	'/entrar',
	'/criar-conta',
	'/esqueci-senha',
	'/redefinir-senha'
]);

export const IDLE_TIMEOUT_MS = 1500;

export function isInstrumentRoute(routeId: string | null | undefined): boolean {
	return routeId !== null && routeId !== undefined && INSTRUMENT_ROUTES.has(routeId);
}

export function isTurnstileRoute(routeId: string | null | undefined): boolean {
	return routeId !== null && routeId !== undefined && TURNSTILE_ROUTES.has(routeId);
}

/**
 * Synchronous read of the in-flight write marker. Any value counts (the service parses and
 * validates it): a marker means a write may have been interrupted and the rescue notice must not
 * wait for idle. Storage that cannot be read reports no marker (the service cannot persist one).
 */
export function hasInflightMarker(storage?: Pick<Storage, 'getItem'> | null): boolean {
	try {
		const target = storage === undefined ? globalThis.localStorage : storage;
		return (target?.getItem(INFLIGHT_MARKER_KEY) ?? null) !== null;
	} catch (error) {
		console.warn('Could not read the cable in-flight marker', error);
		return false;
	}
}

export type RuntimeTrigger = 'now' | 'idle';

/** When to import the runtime for a page: at once (rescue or instrument) or on idle. */
export function runtimeTrigger(
	routeId: string | null | undefined,
	marker: boolean
): RuntimeTrigger {
	return marker || isInstrumentRoute(routeId) ? 'now' : 'idle';
}

let pending: Promise<AppRuntime> | undefined;

/**
 * Imports the runtime chunk once. Vite preloads the chunk's static dependencies in parallel with
 * it (no waterfall). A failed import (offline without cache, deploy skew) is retried next call.
 */
export function loadAppRuntime(): Promise<AppRuntime> {
	return (pending ??= import('./client.svelte.ts').catch((error: unknown) => {
		pending = undefined;
		throw error;
	}));
}

/** Fallback delay where `requestIdleCallback` does not exist (Safari): roughly "after load". */
const IDLE_FALLBACK_MS = 300;

/**
 * Runs `callback` when the main thread is idle, at the latest after `timeout` ms. Browsers
 * without `requestIdleCallback` fall back to a short timer. Returns a cancel function.
 */
export function whenIdle(callback: () => void, timeout = IDLE_TIMEOUT_MS): () => void {
	if (typeof requestIdleCallback === 'function') {
		const handle = requestIdleCallback(() => callback(), { timeout });
		return () => cancelIdleCallback(handle);
	}
	const handle = setTimeout(callback, Math.min(timeout, IDLE_FALLBACK_MS));
	return () => clearTimeout(handle);
}
