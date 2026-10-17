// Form-action logic of the authentication pages (T3.6). No `$app/*` imports: the route files
// (`+page.server.ts`) only adapt SvelteKit's event to these functions, so unit tests drive them
// with a fake API and integration tests can drive them with a real Better Auth instance.
//
// Calls go through `locals.auth.api.*` (server-side, no HTTP hop). Each call carries:
// - the browser's headers (cookies, language for the e-mail copy, cf-connecting-ip for the
//   T3.3 guard) plus the Turnstile token in `x-turnstile-token` (README of server/auth);
// - a synthetic Request whose Origin is PUBLIC_ORIGIN. SvelteKit has already rejected
//   cross-origin form posts (csrf.checkOrigin), so the action vouches for the origin; the strict
//   origin hook and Better Auth's own checks then run as for a direct API call.
//
// Messages are uniform per flow (see `classify*`): sign-in never says whether the e-mail exists,
// and sign-up, resend and reset requests answer the same for any address.
import type { Auth } from '#lib/server/auth.ts';
import { TURNSTILE_HEADER } from '#lib/server/auth/hooks.ts';
import { TURNSTILE_FIELD } from './fields.ts';
import { afterSignIn, MAX_NEXT_LENGTH, safeNext, withNext } from './next.ts';
import { PASSWORD_MAX, PASSWORD_MIN } from './password-strength.ts';
import type { AuthErrorKind, AuthFormState, FieldIssue } from './types.ts';

// --- API adapter ------------------------------------------------------------------------------

export interface AuthCallInit {
	headers: Headers;
	request: Request;
}

/** The slice of the Better Auth API the pages use, with plain bodies (testable with fakes). */
export interface AuthPagesApi {
	signIn(body: { email: string; password: string }, init: AuthCallInit): Promise<unknown>;
	verifyTotp(body: { code: string }, init: AuthCallInit): Promise<unknown>;
	verifyBackupCode(body: { code: string }, init: AuthCallInit): Promise<unknown>;
	signUp(
		body: { name: string; email: string; password: string; callbackURL: string },
		init: AuthCallInit
	): Promise<unknown>;
	sendVerification(
		body: { email: string; callbackURL: string },
		init: AuthCallInit
	): Promise<unknown>;
	requestReset(body: { email: string }, init: AuthCallInit): Promise<unknown>;
	resetPassword(body: { newPassword: string; token: string }, init: AuthCallInit): Promise<unknown>;
}

/**
 * `asResponse: false` is required: Better Auth 1.7 switches `auth.api.*` to Response mode whenever
 * a `request` is passed (`asResponse ?? isRequestLike(request)`), and then an endpoint error
 * (wrong password, bad reset token) comes back as a 4xx Response instead of a thrown APIError,
 * which the flows below would take for success. Hook errors (Turnstile, rate limits) still threw,
 * so only endpoint-level failures were affected.
 */
export function authPagesApi(auth: Auth): AuthPagesApi {
	const { api } = auth;
	const call = (init: AuthCallInit) => ({ ...init, asResponse: false as const });
	return {
		signIn: (body, init) => api.signInEmail({ body, ...call(init) }),
		verifyTotp: (body, init) => api.verifyTOTP({ body, ...call(init) }),
		verifyBackupCode: (body, init) => api.verifyBackupCode({ body, ...call(init) }),
		signUp: (body, init) => api.signUpEmail({ body, ...call(init) }),
		sendVerification: (body, init) => api.sendVerificationEmail({ body, ...call(init) }),
		requestReset: (body, init) => api.requestPasswordReset({ body, ...call(init) }),
		resetPassword: (body, init) => api.resetPassword({ body, ...call(init) })
	};
}

/** Better Auth path of each call (the synthetic request's URL, used by the hooks only). */
export const AUTH_PATHS = {
	signIn: '/sign-in/email',
	verifyTotp: '/two-factor/verify-totp',
	verifyBackupCode: '/two-factor/verify-backup-code',
	signUp: '/sign-up/email',
	sendVerification: '/send-verification-email',
	requestReset: '/request-password-reset',
	resetPassword: '/reset-password'
} as const;

/** Headers forwarded from the form post; body framing headers are dropped. */
const DROPPED_HEADERS = ['content-type', 'content-length', 'origin', 'referer', TURNSTILE_HEADER];

export function buildAuthCall(
	incoming: Request,
	publicOrigin: string,
	path: string,
	turnstileToken?: string | null
): AuthCallInit {
	const headers = new Headers(incoming.headers);
	for (const name of DROPPED_HEADERS) headers.delete(name);
	headers.set('content-type', 'application/json');
	headers.set('origin', publicOrigin);
	if (turnstileToken) headers.set(TURNSTILE_HEADER, turnstileToken);
	const request = new Request(`${publicOrigin}/api/auth${path}`, { method: 'POST', headers });
	return { headers, request };
}

// --- Form reading -----------------------------------------------------------------------------

export const EMAIL_MAX = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_PATTERN = /^[A-Za-z0-9-]{6,32}$/;

function field(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === 'string' ? value : '';
}

export function readEmail(form: FormData): { value: string; issue?: FieldIssue } {
	const value = field(form, 'email')
		.trim()
		.slice(0, EMAIL_MAX + 1);
	if (value === '') return { value, issue: 'required' };
	if (value.length > EMAIL_MAX || !EMAIL_PATTERN.test(value)) return { value, issue: 'email' };
	return { value };
}

/** Passwords are never trimmed; length is counted like the server (String#length). */
export function readPassword(
	form: FormData,
	name: string,
	{ checkLength = true }: { checkLength?: boolean } = {}
): { value: string; issue?: FieldIssue } {
	const value = field(form, name);
	if (value === '') return { value, issue: 'required' };
	if (checkLength && value.length < PASSWORD_MIN) return { value, issue: 'short' };
	if (value.length > PASSWORD_MAX) return { value, issue: 'long' };
	return { value };
}

export function readCode(form: FormData): { value: string; issue?: FieldIssue } {
	const value = field(form, 'code').replace(/\s+/g, '');
	if (value === '') return { value, issue: 'required' };
	if (!CODE_PATTERN.test(value)) return { value, issue: 'code' };
	return { value };
}

export function readTurnstile(form: FormData): string | null {
	const value = field(form, TURNSTILE_FIELD);
	return value === '' ? null : value;
}

/** The `next` posted with the form (already validated when rendered; validated again here). */
export function readNext(form: FormData): string | null {
	const value = field(form, 'next');
	return value === '' ? null : value;
}

// --- Error classification ---------------------------------------------------------------------

export interface AuthErrorInfo {
	status: number;
	code: string;
	retryAfter?: number;
}

function headerValue(headers: unknown, name: string): string | null {
	if (headers instanceof Headers) return headers.get(name);
	if (typeof headers === 'object' && headers !== null) {
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === name && typeof value === 'string') return value;
		}
	}
	return null;
}

/** Reads a Better Auth `APIError` structurally (status, JSON `code`, `Retry-After`). */
export function readAuthError(error: unknown): AuthErrorInfo | null {
	if (typeof error !== 'object' || error === null) return null;
	const { statusCode, body, headers } = error as {
		statusCode?: unknown;
		body?: unknown;
		headers?: unknown;
	};
	if (typeof statusCode !== 'number') return null;
	const code =
		typeof body === 'object' && body !== null && typeof Reflect.get(body, 'code') === 'string'
			? String(Reflect.get(body, 'code'))
			: '';
	const retry = Number.parseInt(headerValue(headers, 'retry-after') ?? '', 10);
	return {
		status: statusCode,
		code,
		...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {})
	};
}

export type AuthFlow = 'sign-in' | 'two-factor' | 'sign-up' | 'resend' | 'request-reset' | 'reset';

/**
 * `null` means "answer as if it worked" (resend and reset requests never reveal anything).
 * Unknown errors (not an APIError) are `generic`.
 */
export function classifyAuthError(
	flow: AuthFlow,
	error: unknown
): { kind: AuthErrorKind; status: number; retryAfter?: number; field?: FieldIssue } | null {
	const info = readAuthError(error);
	if (!info) return { kind: 'generic', status: 500 };
	const { code, status } = info;
	if (code === 'RATE_LIMITED' || status === 429) {
		return {
			kind: 'rate',
			status: 429,
			...(info.retryAfter ? { retryAfter: info.retryAfter } : {})
		};
	}
	if (code === 'TURNSTILE_REQUIRED' || code === 'TURNSTILE_FAILED') {
		return { kind: 'turnstile', status: 400 };
	}
	if (code === 'TURNSTILE_UNAVAILABLE' || code === 'RATE_LIMIT_UNAVAILABLE' || status === 503) {
		return { kind: 'unavailable', status: 503 };
	}
	if (code === 'SIGNUP_DISABLED') return { kind: 'signup_disabled', status: 403 };
	if (code === 'INVALID_ORIGIN' || status >= 500) return { kind: 'generic', status: 500 };

	switch (flow) {
		case 'sign-in':
			if (code === 'EMAIL_NOT_VERIFIED') return { kind: 'unverified', status: 403 };
			if (code === 'BANNED_USER') return { kind: 'banned', status: 403 };
			// Unknown e-mail, wrong password, malformed input, no credential: one answer.
			return { kind: 'credentials', status: 400 };
		case 'two-factor':
			return { kind: 'code', status: 400 };
		case 'sign-up':
			if (code === 'PASSWORD_TOO_SHORT') return { kind: 'generic', status: 400, field: 'short' };
			if (code === 'PASSWORD_TOO_LONG') return { kind: 'generic', status: 400, field: 'long' };
			if (code === 'INVALID_EMAIL') return { kind: 'generic', status: 400, field: 'email' };
			return { kind: 'generic', status: 400 };
		case 'resend':
		case 'request-reset':
			return null;
		case 'reset':
			if (code === 'INVALID_TOKEN' || code === 'TOKEN_EXPIRED' || code === 'INVALID_USER') {
				return { kind: 'token', status: 400 };
			}
			if (code === 'PASSWORD_TOO_SHORT') return { kind: 'generic', status: 400, field: 'short' };
			if (code === 'PASSWORD_TOO_LONG') return { kind: 'generic', status: 400, field: 'long' };
			return { kind: 'generic', status: 400 };
	}
}

// --- Resend cooldown (matches the server's 3 per 300 s rule) ----------------------------------

export const RESEND_COOLDOWN_SECONDS = 300;
export const RESEND_COOKIE = 'oa_verify_resend';

/** Epoch ms when another verification e-mail may be requested, or null when it may be now. */
export function resendAvailableAt(cookie: string | undefined, now: number): number | null {
	if (!cookie || !/^\d{1,15}$/.test(cookie)) return null;
	const sentAt = Number(cookie);
	if (sentAt > now + 60_000) return null; // clock skew or tampering: ignore
	const at = sentAt + RESEND_COOLDOWN_SECONDS * 1000;
	return at > now ? at : null;
}

export interface CookieWrite {
	name: string;
	value: string;
	options: {
		path: string;
		httpOnly: boolean;
		sameSite: 'lax';
		secure: boolean;
		maxAge: number;
	};
}

/** Stores only a timestamp (no e-mail): the wait survives reloads and works without JS. */
export function resendCookie(now: number, secure: boolean): CookieWrite {
	return {
		name: RESEND_COOKIE,
		value: String(now),
		options: {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure,
			maxAge: RESEND_COOLDOWN_SECONDS
		}
	};
}

// --- Flows ------------------------------------------------------------------------------------

export type ActionOutcome =
	| { type: 'redirect'; location: string; resendSent?: boolean }
	| { type: 'success'; data: AuthFormState; resendSent?: boolean }
	| { type: 'failure'; status: number; data: AuthFormState };

export interface FlowContext {
	/** `null` when the auth service is not available (prerender, missing platform). */
	api: AuthPagesApi | null;
	/** Builds the per-call init (headers + synthetic request) for a Better Auth path. */
	call: (path: string, turnstileToken?: string | null) => AuthCallInit;
	now?: () => number;
}

const unavailable = (data: AuthFormState = {}): ActionOutcome => ({
	type: 'failure',
	status: 503,
	data: { ...data, error: 'unavailable' }
});

function failure(
	status: number,
	data: AuthFormState,
	classified: { kind: AuthErrorKind; retryAfter?: number; field?: FieldIssue },
	fieldName: 'email' | 'password' = 'password'
): ActionOutcome {
	if (classified.field) {
		return {
			type: 'failure',
			status,
			data: { ...data, fields: { [fieldName]: classified.field } }
		};
	}
	return {
		type: 'failure',
		status,
		data: {
			...data,
			error: classified.kind,
			...(classified.retryAfter ? { retryAfter: classified.retryAfter } : {})
		}
	};
}

/** `{ next }` when the posted return path is safe, else nothing (keeps the data minimal). */
function echoNext(next: string | null): { next?: string } {
	const safe = safeNext(next);
	return safe ? { next: safe } : {};
}

function isTwoFactorRedirect(result: unknown): boolean {
	return (
		typeof result === 'object' &&
		result !== null &&
		Reflect.get(result, 'twoFactorRedirect') === true
	);
}

export async function signInFlow(form: FormData, ctx: FlowContext): Promise<ActionOutcome> {
	const email = readEmail(form);
	const password = readPassword(form, 'password', { checkLength: false });
	const next = readNext(form);
	const values = { email: email.value };
	const keep = echoNext(next);
	if (email.issue || password.issue) {
		const fields: AuthFormState['fields'] = {};
		if (email.issue) fields.email = email.issue;
		if (password.issue) fields.password = password.issue;
		return { type: 'failure', status: 400, data: { values, fields, ...keep } };
	}
	if (!ctx.api) return unavailable({ values, ...keep });
	try {
		const result = await ctx.api.signIn(
			{ email: email.value, password: password.value },
			ctx.call(AUTH_PATHS.signIn, readTurnstile(form))
		);
		if (isTwoFactorRedirect(result)) {
			return { type: 'success', data: { step: 'two-factor', ...keep } };
		}
		return { type: 'redirect', location: afterSignIn(next) };
	} catch (error) {
		const classified = classifyAuthError('sign-in', error) ?? { kind: 'credentials', status: 400 };
		return failure(classified.status, { values, ...keep }, classified);
	}
}

export async function twoFactorFlow(form: FormData, ctx: FlowContext): Promise<ActionOutcome> {
	const code = readCode(form);
	const next = readNext(form);
	const keep = echoNext(next);
	const method = form.get('method') === 'backup' ? 'backup' : 'totp';
	if (code.issue) {
		return {
			type: 'failure',
			status: 400,
			data: { step: 'two-factor', fields: { code: code.issue }, ...keep }
		};
	}
	if (!ctx.api) return unavailable({ step: 'two-factor', ...keep });
	try {
		if (method === 'backup') {
			await ctx.api.verifyBackupCode({ code: code.value }, ctx.call(AUTH_PATHS.verifyBackupCode));
		} else {
			await ctx.api.verifyTotp({ code: code.value }, ctx.call(AUTH_PATHS.verifyTotp));
		}
		return { type: 'redirect', location: afterSignIn(next) };
	} catch (error) {
		const classified = classifyAuthError('two-factor', error) ?? { kind: 'code', status: 400 };
		return failure(classified.status, { step: 'two-factor', ...keep }, classified);
	}
}

/** Verification link target (relative: Better Auth redirects there after checking the token). */
export function verificationCallback(next: string | null): string {
	const landing = '/verificar-email?verificado=1';
	const target = withNext(landing, next);
	// The callback is capped like `next` itself (hooks refuse longer ones): an encoded `next`
	// near the cap is dropped rather than failing sign-up.
	return target.length > MAX_NEXT_LENGTH ? landing : target;
}

export async function signUpFlow(
	form: FormData,
	ctx: FlowContext & { signupEnabled: boolean }
): Promise<ActionOutcome> {
	if (!ctx.signupEnabled) {
		return { type: 'failure', status: 403, data: { error: 'signup_disabled' } };
	}
	const email = readEmail(form);
	const password = readPassword(form, 'password');
	const confirm = field(form, 'confirm');
	const next = readNext(form);
	const values = { email: email.value };
	const fields: AuthFormState['fields'] = {};
	if (email.issue) fields.email = email.issue;
	if (password.issue) fields.password = password.issue;
	else if (confirm !== password.value) fields.confirm = confirm === '' ? 'required' : 'mismatch';
	if (Object.keys(fields).length > 0) {
		return { type: 'failure', status: 400, data: { values, fields } };
	}
	if (!ctx.api) return unavailable({ values });
	try {
		// `name` is required by Better Auth; open-auri keeps no real names (nickname comes later).
		await ctx.api.signUp(
			{
				name: '',
				email: email.value,
				password: password.value,
				callbackURL: verificationCallback(next)
			},
			ctx.call(AUTH_PATHS.signUp, readTurnstile(form))
		);
	} catch (error) {
		const classified = classifyAuthError('sign-up', error) ?? { kind: 'generic', status: 400 };
		return failure(
			classified.status,
			{ values },
			classified,
			classified.field === 'email' ? 'email' : 'password'
		);
	}
	// Same answer for new and existing addresses (Better Auth returns a synthetic user).
	return {
		type: 'redirect',
		location: withNext('/verificar-email?enviado=1', next),
		resendSent: true
	};
}

export async function resendFlow(
	form: FormData,
	ctx: FlowContext & { cooldownCookie: string | undefined }
): Promise<ActionOutcome> {
	const now = (ctx.now ?? Date.now)();
	const email = readEmail(form);
	const next = readNext(form);
	const values = { email: email.value };
	const waitUntil = resendAvailableAt(ctx.cooldownCookie, now);
	if (waitUntil !== null) {
		return {
			type: 'failure',
			status: 429,
			data: {
				values,
				error: 'cooldown',
				retryAfter: Math.ceil((waitUntil - now) / 1000),
				resendAvailableAt: waitUntil
			}
		};
	}
	if (email.issue) {
		return { type: 'failure', status: 400, data: { values, fields: { email: email.issue } } };
	}
	if (!ctx.api) return unavailable({ values });
	try {
		await ctx.api.sendVerification(
			{ email: email.value, callbackURL: verificationCallback(next) },
			ctx.call(AUTH_PATHS.sendVerification)
		);
	} catch (error) {
		const classified = classifyAuthError('resend', error);
		if (classified) return failure(classified.status, { values }, classified);
	}
	return {
		type: 'success',
		data: { sent: true, values, resendAvailableAt: now + RESEND_COOLDOWN_SECONDS * 1000 },
		resendSent: true
	};
}

export async function requestResetFlow(form: FormData, ctx: FlowContext): Promise<ActionOutcome> {
	const email = readEmail(form);
	const values = { email: email.value };
	if (email.issue) {
		return { type: 'failure', status: 400, data: { values, fields: { email: email.issue } } };
	}
	if (!ctx.api) return unavailable({ values });
	try {
		await ctx.api.requestReset(
			{ email: email.value },
			ctx.call(AUTH_PATHS.requestReset, readTurnstile(form))
		);
	} catch (error) {
		const classified = classifyAuthError('request-reset', error);
		if (classified) return failure(classified.status, { values }, classified);
	}
	return { type: 'success', data: { sent: true, values } };
}

export async function resetPasswordFlow(form: FormData, ctx: FlowContext): Promise<ActionOutcome> {
	const token = field(form, 'token');
	if (token === '' || token.length > 512) {
		return { type: 'failure', status: 400, data: { error: 'token' } };
	}
	const password = readPassword(form, 'password');
	const confirm = field(form, 'confirm');
	const fields: AuthFormState['fields'] = {};
	if (password.issue) fields.password = password.issue;
	else if (confirm !== password.value) fields.confirm = confirm === '' ? 'required' : 'mismatch';
	if (Object.keys(fields).length > 0) return { type: 'failure', status: 400, data: { fields } };
	if (!ctx.api) return unavailable();
	try {
		await ctx.api.resetPassword(
			{ newPassword: password.value, token },
			ctx.call(AUTH_PATHS.resetPassword)
		);
	} catch (error) {
		const classified = classifyAuthError('reset', error) ?? { kind: 'generic', status: 400 };
		return failure(classified.status, {}, classified);
	}
	return { type: 'redirect', location: '/entrar?redefinida=1' };
}
