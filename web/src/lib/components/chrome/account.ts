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
	/**
	 * Menu hint only (FUX.2): present and true when the client probe of a prerendered page sees an
	 * effective admin session, mirroring the layout's `admin` boolean. Never used for
	 * authorisation; the /admin guard checks the session on the server.
	 */
	admin?: boolean;
}

export const SESSION_ENDPOINT = '/api/auth/get-session';

/**
 * Client mirror of the server's `isAdminEffective` for the user menu: the admin role, not banned,
 * not impersonated and, because the client cannot read ADMIN_2FA_REQUIRED, always with 2FA
 * enabled and verified in this session. The conservative side only hides the menu item; the
 * /admin guard decides access on the server either way.
 */
function adminHint(body: object, user: object): boolean {
	if (Reflect.get(user, 'role') !== 'admin' || Reflect.get(user, 'banned') === true) return false;
	const session: unknown = Reflect.get(body, 'session');
	if (typeof session !== 'object' || session === null) return false;
	if (Reflect.get(session, 'impersonatedBy')) return false;
	const verifiedAt: unknown = Reflect.get(session, 'twoFactorVerifiedAt');
	const verified =
		(typeof verifiedAt === 'string' && verifiedAt !== '') ||
		(typeof verifiedAt === 'number' && Number.isFinite(verifiedAt));
	return Reflect.get(user, 'twoFactorEnabled') === true && verified;
}

/**
 * Picks the non-sensitive fields of a Better Auth `get-session` body; null when signed out. A
 * user without a string `id` is not a usable session and reads as signed out. The admin menu
 * hint is the only role-derived value, a boolean added only when true (never the role itself).
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
		emailVerified: Reflect.get(user, 'emailVerified') === true,
		...(adminHint(body, user) ? { admin: true } : {})
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
