// Access rules of the account area, as plain functions (tested in workerd; the routes turn them
// into redirects and `fail()`s):
//   - every /conta page and action needs a signed-in, non-banned user (T3.5 `checkUser`);
//     anonymous page loads go to /entrar?next=<path>, anonymous actions and endpoints get 401;
//   - profile and nickname actions also need a verified e-mail (`checkVerified`);
//   - every action works on `locals.user.id` only: no action takes a user id from the request;
//   - CSRF: form actions rely on SvelteKit's origin check; the JSON/download endpoints also
//     require a same-origin request here (Origin header, or Sec-Fetch-Site when Origin is absent).
import { checkUser, checkVerified, type AccessResult, type AuthLocals } from '../auth/guards.ts';

export const ACCOUNT_PATH = '/conta';
export const SIGN_IN_PATH = '/entrar';

/** `/entrar?next=/conta` (only same-site relative paths are carried). */
export function signInRedirect(next: string = ACCOUNT_PATH): string {
	const safe = next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/';
	return `${SIGN_IN_PATH}?next=${encodeURIComponent(safe)}`;
}

export type AccountAccess =
	| { ok: true; user: NonNullable<AuthLocals['user']>; session: NonNullable<AuthLocals['session']> }
	| { ok: false; status: 401 | 403; code: string };

export function accountAccess(locals: AuthLocals, verified = false): AccountAccess {
	const result: AccessResult = verified ? checkVerified(locals) : checkUser(locals);
	if (!result.ok) return { ok: false, status: result.status, code: result.code };
	return { ok: true, user: result.user, session: result.session };
}

/** True for requests the browser marks as coming from `origin` itself. */
export function isSameOriginRequest(request: Request, origin: string): boolean {
	const header = request.headers.get('origin');
	if (header !== null && header !== 'null') return header === origin;
	return request.headers.get('sec-fetch-site') === 'same-origin';
}
