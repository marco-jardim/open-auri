// Header account entry: the minimal session summary the chrome may know (never the e-mail).
import { AUTH_PAGES, withNext } from '../auth/next.ts';

export interface AccountSummary {
	/**
	 * The signed-in user's own account id (never shown). It ties local per-account data, such as
	 * the social activity outbox, to the person who acted.
	 */
	id: string;
	/** Public nickname (display form), or null before the nickname is chosen. */
	username: string | null;
	emailVerified: boolean;
}

export const SESSION_ENDPOINT = '/api/auth/get-session';

/**
 * Picks the non-sensitive fields of a Better Auth `get-session` body; null when signed out. A
 * user without a string `id` is not a usable session and reads as signed out.
 */
export function toAccountSummary(body: unknown): AccountSummary | null {
	if (typeof body !== 'object' || body === null) return null;
	const user: unknown = Reflect.get(body, 'user');
	if (typeof user !== 'object' || user === null) return null;
	const pick = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
	const id = pick(Reflect.get(user, 'id'));
	if (id === null) return null;
	const display: unknown = Reflect.get(user, 'displayUsername');
	const username: unknown = Reflect.get(user, 'username');
	return {
		id,
		username: pick(display) ?? pick(username),
		emailVerified: Reflect.get(user, 'emailVerified') === true
	};
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Outcome of a session probe that keeps "nobody is signed in" apart from "could not tell"
 * (FX4.10): `signed-out` only when the auth API answered successfully without a usable session;
 * `error` for any failure (offline, HTTP error, no auth service in dev, non-JSON body).
 */
export type AccountProbeResult =
	{ status: 'signed-in'; account: AccountSummary } | { status: 'signed-out' } | { status: 'error' };

/**
 * Session probe with the definitive/failed distinction. Callers that destroy local per-account
 * data on sign-out must act only on `signed-out`. Rethrows an abort; never throws otherwise.
 */
export async function probeAccount(
	fetcher: FetchLike = (input, init) => fetch(input, init),
	signal?: AbortSignal
): Promise<AccountProbeResult> {
	let body: unknown;
	try {
		const response = await fetcher(SESSION_ENDPOINT, {
			credentials: 'same-origin',
			headers: { accept: 'application/json' },
			...(signal ? { signal } : {})
		});
		if (!response.ok) return { status: 'error' };
		body = await response.json();
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') throw error;
		return { status: 'error' };
	}
	const account = toAccountSummary(body);
	return account === null ? { status: 'signed-out' } : { status: 'signed-in', account };
}

/**
 * Session probe for prerendered pages (their layout data is built without a session).
 * Any failure (offline, no auth service in dev, non-JSON) reads as signed out; use
 * `probeAccount` to tell a failure from a definitive signed-out answer.
 */
export async function fetchAccount(
	fetcher: FetchLike = (input, init) => fetch(input, init),
	signal?: AbortSignal
): Promise<AccountSummary | null> {
	const result = await probeAccount(fetcher, signal);
	return result.status === 'signed-in' ? result.account : null;
}

function isAuthPage(pathname: string): boolean {
	return AUTH_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}

/** "Entrar" link: returns to the current page after sign-in (not from the auth pages). */
export function signInHref(currentPath: string): string {
	const pathname = currentPath.split(/[?#]/, 1)[0] ?? '/';
	return isAuthPage(pathname) ? '/entrar' : withNext('/entrar', currentPath);
}

export const ACCOUNT_HREF = '/conta';

/** Endpoint (T3.7) that records a signed-in user's policy acknowledgement. */
export const POLICY_ACCEPT_ENDPOINT = '/conta/politica';

/**
 * Records the acknowledgement of `version` for the signed-in user. Rejects on any failure so
 * the PolicyBanner stays open with its error message.
 */
export async function postPolicyAcceptance(
	version: string,
	fetcher: FetchLike = (input, init) => fetch(input, init)
): Promise<void> {
	const response = await fetcher(POLICY_ACCEPT_ENDPOINT, {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ version })
	});
	if (!response.ok) throw new Error(`Policy acceptance failed with HTTP ${response.status}`);
}
