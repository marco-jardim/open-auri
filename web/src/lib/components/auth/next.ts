// Return-to-origin (`?next=`) for the authentication pages. Only same-origin relative paths are
// accepted; anything that a browser could resolve to another origin is dropped (open redirect).
//
// Rejected: absolute URLs, scheme-relative `//host`, backslashes (`/\host` is `//host` to
// browsers), control characters and whitespace, paths that normalise to `//host` (`/.//host`,
// `/a/../..//host`), the auth API and the auth pages themselves (no loops), and values over
// MAX_NEXT_LENGTH. Accepted values are returned normalised (pathname + search + hash).

/** The five authentication pages (T3.6). */
export const AUTH_PAGES = [
	'/entrar',
	'/criar-conta',
	'/verificar-email',
	'/esqueci-senha',
	'/redefinir-senha'
] as const;

export const MAX_NEXT_LENGTH = 512;

const BASE = 'https://next.invalid';

/** Backslash, whitespace, C0 controls or DEL anywhere in the value. */
function hasForbiddenCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x20 || code === 0x7f || char === '\\' || /\s/u.test(char)) return true;
	}
	return false;
}

function isAuthPage(pathname: string): boolean {
	return AUTH_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}

/** The safe same-origin path for `value`, or `null` when it must be ignored. */
export function safeNext(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	if (value.length === 0 || value.length > MAX_NEXT_LENGTH) return null;
	if (!value.startsWith('/') || value.startsWith('//')) return null;
	if (hasForbiddenCharacter(value)) return null;
	let url: URL;
	try {
		url = new URL(value, BASE);
	} catch {
		return null;
	}
	if (url.origin !== BASE) return null;
	const pathname = url.pathname;
	if (!pathname.startsWith('/') || pathname.startsWith('//')) return null;
	if (pathname === '/api' || pathname.startsWith('/api/')) return null;
	if (isAuthPage(pathname)) return null;
	return `${pathname}${url.search}${url.hash}`;
}

/** `path` with `next` appended as a query parameter (when safe). */
export function withNext(path: string, next: string | null | undefined): string {
	const safe = safeNext(next);
	if (!safe || safe === '/') return path;
	const separator = path.includes('?') ? '&' : '?';
	return `${path}${separator}next=${encodeURIComponent(safe)}`;
}

/** Where to go after a successful sign-in. */
export function afterSignIn(next: string | null | undefined): string {
	return safeNext(next) ?? '/';
}
