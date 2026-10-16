// SvelteKit glue for the auth pages: builds the flow context from the request event and turns a
// flow outcome into `redirect` / `fail` / data. Imports `@sveltejs/kit` only (no `$app/*`).
import { fail, redirect, type Cookies } from '@sveltejs/kit';
import { getServerEnv } from '#lib/server/env.ts';
import {
	authPagesApi,
	buildAuthCall,
	RESEND_COOKIE,
	resendAvailableAt,
	resendCookie,
	type ActionOutcome,
	type FlowContext
} from './actions.server.ts';
import type { AuthFormState } from './types.ts';

/** The parts of a RequestEvent the auth pages use. */
export interface AuthEvent {
	request: Request;
	url: URL;
	cookies: Cookies;
	locals: App.Locals;
	platform?: App.Platform | undefined;
}

function publicOrigin(event: AuthEvent): string | null {
	try {
		return getServerEnv(event.platform).publicOrigin;
	} catch {
		// No platform (dev server, prerender) or invalid env: the auth service is unavailable.
		return null;
	}
}

export function flowContext(event: AuthEvent): FlowContext {
	const origin = publicOrigin(event);
	const auth = event.locals.auth;
	return {
		api: auth && origin ? authPagesApi(auth) : null,
		call: (path, turnstileToken) =>
			buildAuthCall(event.request, origin ?? event.url.origin, path, turnstileToken)
	};
}

/** SIGNUP_ENABLED from the Worker env; false when the env cannot be read. */
export function signupEnabled(event: Pick<AuthEvent, 'platform'>): boolean {
	try {
		return getServerEnv(event.platform).flags.signupEnabled;
	} catch {
		return false;
	}
}

export function readResendCooldown(event: Pick<AuthEvent, 'cookies'>, now = Date.now()) {
	return resendAvailableAt(event.cookies.get(RESEND_COOKIE), now);
}

/** Response headers of every auth page: never cached, never indexed. */
export const AUTH_PAGE_HEADERS = {
	'cache-control': 'private, no-store',
	'x-robots-tag': 'noindex, nofollow'
} as const;

export function finish(outcome: ActionOutcome, event: AuthEvent) {
	if (outcome.type !== 'failure' && outcome.resendSent) {
		const cookie = resendCookie(Date.now(), event.url.protocol === 'https:');
		event.cookies.set(cookie.name, cookie.value, cookie.options);
	}
	if (outcome.type === 'redirect') redirect(303, outcome.location);
	if (outcome.type === 'failure') return fail(outcome.status, outcome.data);
	return outcome.data satisfies AuthFormState;
}
