import { APIError } from 'better-auth/api';
import { describe, expect, test, vi } from 'vitest';
import { TURNSTILE_HEADER } from '#lib/server/auth.ts';
import { TURNSTILE_ACTIONS } from '#lib/server/security/turnstile.ts';
import {
	AUTH_PATHS,
	RESEND_COOLDOWN_SECONDS,
	RESEND_COOKIE,
	buildAuthCall,
	classifyAuthError,
	readAuthError,
	readCode,
	readEmail,
	readPassword,
	requestResetFlow,
	resendAvailableAt,
	resendCookie,
	resendFlow,
	resetPasswordFlow,
	signInFlow,
	signUpFlow,
	twoFactorFlow,
	verificationCallback,
	type AuthCallInit,
	type AuthPagesApi,
	type FlowContext
} from '#lib/components/auth/actions.server.ts';
import { AUTH_TURNSTILE_ACTIONS, TURNSTILE_FIELD } from '#lib/components/auth/fields.ts';
import { MAX_NEXT_LENGTH } from '#lib/components/auth/next.ts';

const ORIGIN = 'https://open-auri.example';

function apiError(status: 400 | 401 | 403 | 429 | 503, code: string, retryAfter?: number) {
	const name = {
		400: 'BAD_REQUEST',
		401: 'UNAUTHORIZED',
		403: 'FORBIDDEN',
		429: 'TOO_MANY_REQUESTS',
		503: 'SERVICE_UNAVAILABLE'
	} as const;
	return new APIError(
		name[status],
		{ code, message: code },
		retryAfter === undefined ? undefined : { 'Retry-After': String(retryAfter) }
	);
}

function form(entries: Record<string, string>): FormData {
	const data = new FormData();
	for (const [key, value] of Object.entries(entries)) data.set(key, value);
	return data;
}

function fakeApi(overrides: Partial<Record<keyof AuthPagesApi, (...args: unknown[]) => unknown>>) {
	const calls: { method: keyof AuthPagesApi; body: unknown; init: AuthCallInit }[] = [];
	const method =
		(name: keyof AuthPagesApi) =>
		async (body: unknown, init: AuthCallInit): Promise<unknown> => {
			calls.push({ method: name, body, init });
			const override = overrides[name];
			return override ? override(body, init) : { status: true };
		};
	const api: AuthPagesApi = {
		signIn: method('signIn'),
		verifyTotp: method('verifyTotp'),
		verifyBackupCode: method('verifyBackupCode'),
		signUp: method('signUp'),
		sendVerification: method('sendVerification'),
		requestReset: method('requestReset'),
		resetPassword: method('resetPassword')
	};
	return { api, calls };
}

const incoming = new Request(`${ORIGIN}/entrar?/signIn`, {
	method: 'POST',
	headers: {
		origin: ORIGIN,
		cookie: 'open-auri.session_token=abc',
		'accept-language': 'en-US',
		'cf-connecting-ip': '203.0.113.7',
		'content-type': 'application/x-www-form-urlencoded',
		[TURNSTILE_HEADER]: 'spoofed'
	}
});

function context(api: AuthPagesApi | null): FlowContext {
	return { api, call: (path, token) => buildAuthCall(incoming, ORIGIN, path, token) };
}

describe('constants', () => {
	test('client copies match the server sources', () => {
		expect(AUTH_TURNSTILE_ACTIONS.signIn).toBe(TURNSTILE_ACTIONS.signIn);
		expect(AUTH_TURNSTILE_ACTIONS.signUp).toBe(TURNSTILE_ACTIONS.signUp);
		expect(AUTH_TURNSTILE_ACTIONS.reset).toBe(TURNSTILE_ACTIONS.reset);
		expect(TURNSTILE_FIELD).toBe('cf-turnstile-response');
		expect(TURNSTILE_HEADER).toBe('x-turnstile-token');
	});

	test('resend wait matches the server rule (3 per 300 s)', () => {
		expect(RESEND_COOLDOWN_SECONDS).toBe(300);
	});
});

describe('buildAuthCall', () => {
	test('forwards browser headers, vouches for the origin and carries the Turnstile token', () => {
		const call = buildAuthCall(incoming, ORIGIN, AUTH_PATHS.signIn, 'token-1');
		expect(call.headers.get('cookie')).toBe('open-auri.session_token=abc');
		expect(call.headers.get('accept-language')).toBe('en-US');
		expect(call.headers.get('cf-connecting-ip')).toBe('203.0.113.7');
		expect(call.headers.get('origin')).toBe(ORIGIN);
		expect(call.headers.get('content-type')).toBe('application/json');
		expect(call.headers.get(TURNSTILE_HEADER)).toBe('token-1');
		expect(call.request.url).toBe(`${ORIGIN}/api/auth/sign-in/email`);
		expect(call.request.method).toBe('POST');
		expect(call.request.headers.get(TURNSTILE_HEADER)).toBe('token-1');
	});

	test('never forwards a client-sent x-turnstile-token header', () => {
		const call = buildAuthCall(incoming, ORIGIN, AUTH_PATHS.signIn, null);
		expect(call.headers.has(TURNSTILE_HEADER)).toBe(false);
	});
});

describe('form readers', () => {
	test('e-mail', () => {
		expect(readEmail(form({ email: '  ana@example.com ' }))).toEqual({ value: 'ana@example.com' });
		expect(readEmail(form({})).issue).toBe('required');
		expect(readEmail(form({ email: 'ana' })).issue).toBe('email');
		expect(readEmail(form({ email: `${'a'.repeat(250)}@x.io` })).issue).toBe('email');
	});

	test('password is never trimmed and follows the server length', () => {
		expect(readPassword(form({ password: ' 1234567890 ' }), 'password')).toEqual({
			value: ' 1234567890 '
		});
		expect(readPassword(form({ password: 'short' }), 'password').issue).toBe('short');
		const unchecked = readPassword(form({ password: 'short' }), 'password', { checkLength: false });
		expect(unchecked).toEqual({ value: 'short' });
		expect(readPassword(form({ password: 'x'.repeat(129) }), 'password').issue).toBe('long');
		expect(readPassword(form({}), 'password').issue).toBe('required');
	});

	test('second-factor code', () => {
		expect(readCode(form({ code: '123 456' }))).toEqual({ value: '123456' });
		expect(readCode(form({ code: 'abcde-fghij' }))).toEqual({ value: 'abcde-fghij' });
		expect(readCode(form({ code: '12' })).issue).toBe('code');
		expect(readCode(form({ code: '' })).issue).toBe('required');
	});
});

describe('readAuthError and classifyAuthError', () => {
	test('reads status, code and Retry-After from an APIError', () => {
		expect(readAuthError(apiError(429, 'RATE_LIMITED', 7))).toEqual({
			status: 429,
			code: 'RATE_LIMITED',
			retryAfter: 7
		});
		expect(readAuthError(new Error('boom'))).toBeNull();
		expect(readAuthError('nope')).toBeNull();
	});

	test('sign-in gives one answer for unknown e-mail, wrong password and malformed input', () => {
		const codes = [
			'INVALID_EMAIL_OR_PASSWORD',
			'USER_NOT_FOUND',
			'INVALID_PASSWORD',
			'INVALID_EMAIL',
			'CREDENTIAL_ACCOUNT_NOT_FOUND',
			''
		];
		const kinds = new Set(
			codes.map((code) => classifyAuthError('sign-in', apiError(401, code))?.kind)
		);
		expect([...kinds]).toEqual(['credentials']);
	});

	test.each([
		['RATE_LIMITED', 429, 'rate'],
		['TURNSTILE_REQUIRED', 400, 'turnstile'],
		['TURNSTILE_FAILED', 403, 'turnstile'],
		['TURNSTILE_UNAVAILABLE', 503, 'unavailable'],
		['RATE_LIMIT_UNAVAILABLE', 503, 'unavailable'],
		['SIGNUP_DISABLED', 403, 'signup_disabled'],
		['INVALID_ORIGIN', 403, 'generic'],
		['EMAIL_NOT_VERIFIED', 403, 'unverified'],
		['BANNED_USER', 403, 'banned']
	] as const)('%s → %s', (code, status, kind) => {
		expect(classifyAuthError('sign-in', apiError(status, code))?.kind).toBe(kind);
	});

	test('resend and reset requests answer "sent" for anything but rate, Turnstile, outage', () => {
		for (const flow of ['resend', 'request-reset'] as const) {
			expect(classifyAuthError(flow, apiError(400, 'USER_NOT_FOUND'))).toBeNull();
			expect(classifyAuthError(flow, apiError(400, 'EMAIL_ALREADY_VERIFIED'))).toBeNull();
			expect(classifyAuthError(flow, apiError(429, 'RATE_LIMITED'))?.kind).toBe('rate');
		}
		expect(classifyAuthError('request-reset', apiError(403, 'TURNSTILE_FAILED'))?.kind).toBe(
			'turnstile'
		);
	});

	test('reset maps token and length problems', () => {
		expect(classifyAuthError('reset', apiError(400, 'INVALID_TOKEN'))?.kind).toBe('token');
		expect(classifyAuthError('reset', apiError(400, 'TOKEN_EXPIRED'))?.kind).toBe('token');
		expect(classifyAuthError('reset', apiError(400, 'PASSWORD_TOO_SHORT'))?.field).toBe('short');
	});

	test('unknown errors are generic', () => {
		expect(classifyAuthError('sign-in', new TypeError('x'))?.kind).toBe('generic');
	});
});

describe('signInFlow', () => {
	test('success redirects to the safe next path', async () => {
		const { api, calls } = fakeApi({});
		const outcome = await signInFlow(
			form({
				email: 'ana@example.com',
				password: 'secret-password',
				next: '/biblioteca',
				[TURNSTILE_FIELD]: 'tok'
			}),
			context(api)
		);
		expect(outcome).toEqual({ type: 'redirect', location: '/biblioteca' });
		expect(calls[0]?.body).toEqual({ email: 'ana@example.com', password: 'secret-password' });
		expect(calls[0]?.init.headers.get(TURNSTILE_HEADER)).toBe('tok');
	});

	test('open-redirect payloads in next fall back to /', async () => {
		const { api } = fakeApi({});
		for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
			const outcome = await signInFlow(
				form({ email: 'ana@example.com', password: 'secret-password', next }),
				context(api)
			);
			expect(outcome).toEqual({ type: 'redirect', location: '/' });
		}
	});

	test('wrong credentials: uniform failure, e-mail echoed, password never echoed', async () => {
		const { api } = fakeApi({
			signIn: () => {
				throw apiError(401, 'INVALID_EMAIL_OR_PASSWORD');
			}
		});
		const outcome = await signInFlow(
			form({ email: 'ana@example.com', password: 'secret-password' }),
			context(api)
		);
		expect(outcome).toEqual({
			type: 'failure',
			status: 400,
			data: { values: { email: 'ana@example.com' }, error: 'credentials' }
		});
		expect(JSON.stringify(outcome)).not.toContain('secret-password');
	});

	test('failures echo a safe next (a no-JS post to ?/signIn drops the query)', async () => {
		const { api } = fakeApi({
			signIn: () => {
				throw apiError(401, 'INVALID_EMAIL_OR_PASSWORD');
			}
		});
		const safe = await signInFlow(
			form({ email: 'ana@example.com', password: 'x', next: '/cabo' }),
			context(api)
		);
		expect(safe).toMatchObject({ data: { next: '/cabo' } });
		const unsafe = await signInFlow(
			form({ email: 'ana@example.com', password: 'x', next: '//evil.example' }),
			context(api)
		);
		expect(unsafe.type === 'failure' && 'next' in unsafe.data).toBe(false);
	});

	test('rate limit carries Retry-After', async () => {
		const { api } = fakeApi({
			signIn: () => {
				throw apiError(429, 'RATE_LIMITED', 9);
			}
		});
		const outcome = await signInFlow(
			form({ email: 'ana@example.com', password: 'x' }),
			context(api)
		);
		expect(outcome).toMatchObject({ status: 429, data: { error: 'rate', retryAfter: 9 } });
	});

	test('two-factor accounts move to the code step', async () => {
		const { api } = fakeApi({ signIn: () => ({ twoFactorRedirect: true }) });
		const outcome = await signInFlow(
			form({ email: 'ana@example.com', password: 'secret-password' }),
			context(api)
		);
		expect(outcome).toEqual({ type: 'success', data: { step: 'two-factor' } });
	});

	test('missing fields do not call the API', async () => {
		const { api, calls } = fakeApi({});
		const outcome = await signInFlow(form({ email: '' }), context(api));
		expect(outcome).toMatchObject({
			type: 'failure',
			status: 400,
			data: { fields: { email: 'required', password: 'required' } }
		});
		expect(calls).toHaveLength(0);
	});

	test('no auth service → unavailable', async () => {
		const outcome = await signInFlow(
			form({ email: 'ana@example.com', password: 'x' }),
			context(null)
		);
		expect(outcome).toMatchObject({ status: 503, data: { error: 'unavailable' } });
	});
});

describe('twoFactorFlow', () => {
	test('verifies TOTP or a backup code and redirects', async () => {
		const { api, calls } = fakeApi({});
		expect(await twoFactorFlow(form({ code: '123456', next: '/cabo' }), context(api))).toEqual({
			type: 'redirect',
			location: '/cabo'
		});
		await twoFactorFlow(form({ code: 'abcde-fghij', method: 'backup' }), context(api));
		expect(calls.map((call) => call.method)).toEqual(['verifyTotp', 'verifyBackupCode']);
	});

	test('a bad code keeps the step', async () => {
		const { api } = fakeApi({
			verifyTotp: () => {
				throw apiError(401, 'INVALID_CODE');
			}
		});
		expect(await twoFactorFlow(form({ code: '000000' }), context(api))).toEqual({
			type: 'failure',
			status: 400,
			data: { step: 'two-factor', error: 'code' }
		});
	});
});

describe('signUpFlow', () => {
	const valid = {
		email: 'ana@example.com',
		password: 'violino-tarde-cobalto',
		confirm: 'violino-tarde-cobalto',
		[TURNSTILE_FIELD]: 'tok'
	};

	test('disabled sign-up refuses without calling the API', async () => {
		const { api, calls } = fakeApi({});
		const outcome = await signUpFlow(form(valid), { ...context(api), signupEnabled: false });
		expect(outcome).toEqual({ type: 'failure', status: 403, data: { error: 'signup_disabled' } });
		expect(calls).toHaveLength(0);
	});

	test('success redirects to the check-your-inbox page and starts the resend wait', async () => {
		const { api, calls } = fakeApi({});
		const outcome = await signUpFlow(form({ ...valid, next: '/biblioteca' }), {
			...context(api),
			signupEnabled: true
		});
		expect(outcome).toEqual({
			type: 'redirect',
			location: '/verificar-email?enviado=1&next=%2Fbiblioteca',
			resendSent: true
		});
		expect(calls[0]?.body).toEqual({
			name: '',
			email: 'ana@example.com',
			password: 'violino-tarde-cobalto',
			callbackURL: '/verificar-email?verificado=1&next=%2Fbiblioteca'
		});
		expect(calls[0]?.init.headers.get(TURNSTILE_HEADER)).toBe('tok');
	});

	test('validates length and confirmation on the server', async () => {
		const { api } = fakeApi({});
		const short = await signUpFlow(form({ ...valid, password: 'short', confirm: 'short' }), {
			...context(api),
			signupEnabled: true
		});
		expect(short).toMatchObject({ data: { fields: { password: 'short' } } });
		const mismatch = await signUpFlow(form({ ...valid, confirm: 'other-password-1' }), {
			...context(api),
			signupEnabled: true
		});
		expect(mismatch).toMatchObject({ data: { fields: { confirm: 'mismatch' } } });
	});

	test('the API switch (SIGNUP_DISABLED) is reported too', async () => {
		const { api } = fakeApi({
			signUp: () => {
				throw apiError(403, 'SIGNUP_DISABLED');
			}
		});
		const outcome = await signUpFlow(form(valid), { ...context(api), signupEnabled: true });
		expect(outcome).toMatchObject({ status: 403, data: { error: 'signup_disabled' } });
	});

	test('verification callback is relative and keeps next', () => {
		expect(verificationCallback(null)).toBe('/verificar-email?verificado=1');
		expect(verificationCallback('//evil.example')).toBe('/verificar-email?verificado=1');
		expect(verificationCallback('/biblioteca?aba=lidos')).toBe(
			'/verificar-email?verificado=1&next=%2Fbiblioteca%3Faba%3Dlidos'
		);
	});

	test('verification callback drops a valid next whose encoded form would pass the cap', () => {
		const landing = '/verificar-email?verificado=1';
		// `${landing}&next=%2F` comes first; `a` is not encoded, so `room` of them reach the cap.
		const room = MAX_NEXT_LENGTH - `${landing}&next=%2F`.length;
		const fits = `/${'a'.repeat(room)}`;
		const over = `/${'a'.repeat(room + 1)}`;
		const nearCap = `/${'a'.repeat(MAX_NEXT_LENGTH - 12)}`;
		for (const next of [fits, over, nearCap]) {
			// Each one is a valid `next` on its own: only the callback length decides.
			expect(next.length).toBeLessThanOrEqual(MAX_NEXT_LENGTH);
			expect(verificationCallback(next).length).toBeLessThanOrEqual(MAX_NEXT_LENGTH);
		}
		expect(verificationCallback(fits)).toBe(`${landing}&next=%2F${'a'.repeat(room)}`);
		expect(verificationCallback(fits)).toHaveLength(MAX_NEXT_LENGTH);
		expect(verificationCallback(over)).toBe(landing);
		expect(verificationCallback(nearCap)).toBe(landing);
	});
});

describe('resend cooldown', () => {
	const now = 1_800_000_000_000;

	test('cookie parsing', () => {
		expect(resendAvailableAt(undefined, now)).toBeNull();
		expect(resendAvailableAt('garbage', now)).toBeNull();
		expect(resendAvailableAt(String(now - 10_000), now)).toBe(now - 10_000 + 300_000);
		expect(resendAvailableAt(String(now - 300_000), now)).toBeNull();
		expect(resendAvailableAt(String(now + 3_600_000), now)).toBeNull();
	});

	test('cookie holds only a timestamp', () => {
		expect(resendCookie(now, true)).toEqual({
			name: RESEND_COOKIE,
			value: String(now),
			options: { path: '/', httpOnly: true, sameSite: 'lax', secure: true, maxAge: 300 }
		});
	});

	test('inside the wait: refused with the remaining time, no API call', async () => {
		const { api, calls } = fakeApi({});
		const outcome = await resendFlow(form({ email: 'ana@example.com' }), {
			...context(api),
			now: () => now,
			cooldownCookie: String(now - 60_000)
		});
		expect(outcome).toMatchObject({
			status: 429,
			data: { error: 'cooldown', retryAfter: 240, resendAvailableAt: now + 240_000 }
		});
		expect(calls).toHaveLength(0);
	});

	test('sends, answers uniformly and starts a new wait', async () => {
		const { api } = fakeApi({
			sendVerification: () => {
				throw apiError(400, 'EMAIL_ALREADY_VERIFIED');
			}
		});
		const outcome = await resendFlow(form({ email: 'ana@example.com' }), {
			...context(api),
			now: () => now,
			cooldownCookie: undefined
		});
		expect(outcome).toEqual({
			type: 'success',
			data: {
				sent: true,
				values: { email: 'ana@example.com' },
				resendAvailableAt: now + 300_000
			},
			resendSent: true
		});
	});

	test('server rate limit still wins', async () => {
		const { api } = fakeApi({
			sendVerification: () => {
				throw apiError(429, 'RATE_LIMITED', 120);
			}
		});
		const outcome = await resendFlow(form({ email: 'ana@example.com' }), {
			...context(api),
			cooldownCookie: undefined
		});
		expect(outcome).toMatchObject({ status: 429, data: { error: 'rate', retryAfter: 120 } });
	});
});

describe('password reset flows', () => {
	const fresh = {
		token: 'tok123456789',
		password: 'nova-senha-longa',
		confirm: 'nova-senha-longa'
	};

	test('request: same answer whether or not the account exists', async () => {
		const exists = fakeApi({});
		const missing = fakeApi({
			requestReset: () => {
				throw apiError(400, 'USER_NOT_FOUND');
			}
		});
		const input = { email: 'ana@example.com', [TURNSTILE_FIELD]: 'tok' };
		const a = await requestResetFlow(form(input), context(exists.api));
		const b = await requestResetFlow(form(input), context(missing.api));
		expect(a).toEqual(b);
		const sent = { sent: true, values: { email: 'ana@example.com' } };
		expect(a).toEqual({ type: 'success', data: sent });
		expect(exists.calls[0]?.init.headers.get(TURNSTILE_HEADER)).toBe('tok');
	});

	test('reset: success sends the user to sign in', async () => {
		const { api, calls } = fakeApi({});
		const outcome = await resetPasswordFlow(form(fresh), context(api));
		expect(outcome).toEqual({ type: 'redirect', location: '/entrar?redefinida=1' });
		expect(calls[0]?.body).toEqual({ newPassword: 'nova-senha-longa', token: 'tok123456789' });
	});

	test('reset: missing or used token', async () => {
		const { api } = fakeApi({
			resetPassword: () => {
				throw apiError(400, 'INVALID_TOKEN');
			}
		});
		expect(await resetPasswordFlow(form({ password: 'x' }), context(api))).toMatchObject({
			data: { error: 'token' }
		});
		expect(await resetPasswordFlow(form(fresh), context(api))).toMatchObject({
			status: 400,
			data: { error: 'token' }
		});
	});
});

test('flows never log credentials', async () => {
	const warn = vi.spyOn(console, 'warn');
	const error = vi.spyOn(console, 'error');
	const { api } = fakeApi({
		signIn: () => {
			throw apiError(401, 'INVALID_EMAIL_OR_PASSWORD');
		}
	});
	await signInFlow(form({ email: 'ana@example.com', password: 'secret-password' }), context(api));
	for (const spy of [warn, error]) {
		expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-password');
	}
	warn.mockRestore();
	error.mockRestore();
});
