import { APIError } from 'better-auth/api';
import { describe, expect, test, vi } from 'vitest';
import { TURNSTILE_HEADER, type Auth } from '#lib/server/auth.ts';
import { TURNSTILE_ACTIONS } from '#lib/server/security/turnstile.ts';
import {
	AUTH_PATHS,
	RESEND_COOLDOWN_SECONDS,
	RESEND_COOKIE,
	authPagesApi,
	buildAuthCall,
	classifyAuthError,
	readAuthError,
	readCode,
	readEmail,
	readNext,
	readPassword,
	readTurnstile,
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
import { MAX_NEXT_LENGTH, afterSignIn } from '#lib/components/auth/next.ts';

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

// --- Branch coverage: adapter, readers, classification and every flow exit -------------------

const ALL_FLOWS = ['sign-in', 'two-factor', 'sign-up', 'resend', 'request-reset', 'reset'] as const;

function throwing(error: unknown) {
	return () => {
		throw error;
	};
}

describe('authPagesApi adapter', () => {
	test('maps each page call to its Better Auth endpoint in plain-result mode', async () => {
		const seen: { endpoint: string; arg: unknown }[] = [];
		const endpoint = (name: string) => async (arg: unknown) => {
			seen.push({ endpoint: name, arg });
			return { from: name };
		};
		const auth = {
			api: {
				signInEmail: endpoint('signInEmail'),
				verifyTOTP: endpoint('verifyTOTP'),
				verifyBackupCode: endpoint('verifyBackupCode'),
				signUpEmail: endpoint('signUpEmail'),
				sendVerificationEmail: endpoint('sendVerificationEmail'),
				requestPasswordReset: endpoint('requestPasswordReset'),
				resetPassword: endpoint('resetPassword')
			}
		} as unknown as Auth;
		const pages = authPagesApi(auth);
		const init = buildAuthCall(incoming, ORIGIN, AUTH_PATHS.signIn, null);
		await expect(pages.signIn({ email: 'ana@example.com', password: 'p' }, init)).resolves.toEqual({
			from: 'signInEmail'
		});
		await pages.verifyTotp({ code: '123456' }, init);
		await pages.verifyBackupCode({ code: 'abcde-fghij' }, init);
		await pages.signUp(
			{ name: '', email: 'ana@example.com', password: 'p', callbackURL: '/verificar-email' },
			init
		);
		await pages.sendVerification({ email: 'ana@example.com', callbackURL: '/x' }, init);
		await pages.requestReset({ email: 'ana@example.com' }, init);
		await expect(pages.resetPassword({ newPassword: 'p', token: 't' }, init)).resolves.toEqual({
			from: 'resetPassword'
		});
		expect(seen.map((entry) => entry.endpoint)).toEqual([
			'signInEmail',
			'verifyTOTP',
			'verifyBackupCode',
			'signUpEmail',
			'sendVerificationEmail',
			'requestPasswordReset',
			'resetPassword'
		]);
		for (const { arg } of seen) {
			expect(arg).toMatchObject({
				asResponse: false,
				headers: init.headers,
				request: init.request
			});
		}
		expect(seen[0]?.arg).toMatchObject({ body: { email: 'ana@example.com', password: 'p' } });
		expect(seen[6]?.arg).toMatchObject({ body: { newPassword: 'p', token: 't' } });
	});
});

describe('form readers: edge inputs', () => {
	test('a file posted in place of a text field reads as empty', () => {
		const data = new FormData();
		data.set('email', new Blob(['ana@example.com']), 'email.txt');
		data.set('code', new Blob(['123456']), 'code.txt');
		data.set('password', new Blob(['secret-password']), 'password.txt');
		expect(readEmail(data)).toEqual({ value: '', issue: 'required' });
		expect(readCode(data)).toEqual({ value: '', issue: 'required' });
		expect(readPassword(data, 'password')).toEqual({ value: '', issue: 'required' });
	});

	test('a blank Turnstile token or next reads as null, a filled one as is', () => {
		expect(readTurnstile(form({}))).toBeNull();
		expect(readTurnstile(form({ [TURNSTILE_FIELD]: '' }))).toBeNull();
		expect(readTurnstile(form({ [TURNSTILE_FIELD]: 'tok' }))).toBe('tok');
		expect(readNext(form({ next: '' }))).toBeNull();
		expect(readNext(form({ next: '/cabo' }))).toBe('/cabo');
	});

	test('a code with characters outside the pattern is refused', () => {
		expect(readCode(form({ code: '1234_56' })).issue).toBe('code');
		expect(readCode(form({ code: 'x'.repeat(33) })).issue).toBe('code');
	});

	test('the Turnstile header is only set for a non-empty token', () => {
		expect(
			buildAuthCall(incoming, ORIGIN, AUTH_PATHS.signUp, '').headers.has(TURNSTILE_HEADER)
		).toBe(false);
		expect(buildAuthCall(incoming, ORIGIN, AUTH_PATHS.signUp).headers.has(TURNSTILE_HEADER)).toBe(
			false
		);
		const call = buildAuthCall(incoming, ORIGIN, AUTH_PATHS.resetPassword, 'tok');
		expect(call.request.url).toBe(`${ORIGIN}/api/auth/reset-password`);
		expect(call.headers.has('referer')).toBe(false);
		expect(call.headers.has('content-length')).toBe(false);
	});
});

describe('readAuthError: structural reading', () => {
	test('Retry-After from a Headers instance', () => {
		expect(
			readAuthError({
				statusCode: 429,
				body: { code: 'RATE_LIMITED' },
				headers: new Headers({ 'Retry-After': '12' })
			})
		).toEqual({ status: 429, code: 'RATE_LIMITED', retryAfter: 12 });
	});

	test('Retry-After from a plain object, whatever the key case', () => {
		expect(
			readAuthError({
				statusCode: 429,
				body: null,
				headers: { 'X-Other': '1', 'RETRY-AFTER': '3' }
			})
		).toEqual({ status: 429, code: '', retryAfter: 3 });
	});

	test('non-string, zero, non-numeric and missing Retry-After are dropped', () => {
		const cases: unknown[] = [
			{ statusCode: 429, body: {}, headers: { 'retry-after': 5 } },
			{ statusCode: 429, body: {}, headers: { 'retry-after': '0' } },
			{ statusCode: 429, body: {}, headers: { 'retry-after': '-4' } },
			{ statusCode: 429, body: {}, headers: { 'retry-after': 'soon' } },
			{ statusCode: 429, body: {}, headers: null },
			{ statusCode: 429, body: {}, headers: 'retry-after: 5' },
			{ statusCode: 429, body: {} }
		];
		for (const error of cases) expect(readAuthError(error)).toEqual({ status: 429, code: '' });
	});

	test('a body without a string code gives an empty code', () => {
		expect(readAuthError({ statusCode: 400, body: { code: 7 } })).toEqual({
			status: 400,
			code: ''
		});
		expect(readAuthError({ statusCode: 400, body: 'RATE_LIMITED' })).toEqual({
			status: 400,
			code: ''
		});
		expect(readAuthError({ statusCode: 400 })).toEqual({ status: 400, code: '' });
	});

	test('anything without a numeric statusCode is not an API error', () => {
		expect(readAuthError({ statusCode: '429', body: { code: 'RATE_LIMITED' } })).toBeNull();
		expect(readAuthError({ body: { code: 'RATE_LIMITED' } })).toBeNull();
		expect(readAuthError(null)).toBeNull();
		expect(readAuthError(undefined)).toBeNull();
		expect(readAuthError(429)).toBeNull();
	});
});

describe('classifyAuthError: every classification', () => {
	test('rate, Turnstile, outage, origin and unknown errors win over the flow mapping', () => {
		for (const flow of ALL_FLOWS) {
			expect(classifyAuthError(flow, apiError(429, 'RATE_LIMITED', 4))).toEqual({
				kind: 'rate',
				status: 429,
				retryAfter: 4
			});
			expect(classifyAuthError(flow, apiError(400, 'TURNSTILE_REQUIRED'))).toEqual({
				kind: 'turnstile',
				status: 400
			});
			expect(classifyAuthError(flow, apiError(403, 'TURNSTILE_FAILED'))).toEqual({
				kind: 'turnstile',
				status: 400
			});
			expect(classifyAuthError(flow, apiError(503, 'TURNSTILE_UNAVAILABLE'))).toEqual({
				kind: 'unavailable',
				status: 503
			});
			expect(classifyAuthError(flow, apiError(503, 'RATE_LIMIT_UNAVAILABLE'))).toEqual({
				kind: 'unavailable',
				status: 503
			});
			expect(classifyAuthError(flow, apiError(403, 'SIGNUP_DISABLED'))).toEqual({
				kind: 'signup_disabled',
				status: 403
			});
			expect(classifyAuthError(flow, apiError(403, 'INVALID_ORIGIN'))).toEqual({
				kind: 'generic',
				status: 500
			});
			expect(classifyAuthError(flow, new Error('boom'))).toEqual({ kind: 'generic', status: 500 });
		}
	});

	test('a bare 429 is a rate limit without Retry-After; RATE_LIMITED wins over any status', () => {
		expect(classifyAuthError('sign-up', apiError(429, ''))).toEqual({ kind: 'rate', status: 429 });
		expect(classifyAuthError('reset', apiError(400, 'RATE_LIMITED'))).toEqual({
			kind: 'rate',
			status: 429
		});
	});

	test('a 503 with any code is unavailable; any other 5xx is generic', () => {
		expect(classifyAuthError('sign-in', apiError(503, 'SOMETHING_ELSE'))).toEqual({
			kind: 'unavailable',
			status: 503
		});
		for (const flow of ALL_FLOWS) {
			expect(classifyAuthError(flow, { statusCode: 500, body: { code: 'INTERNAL' } })).toEqual({
				kind: 'generic',
				status: 500
			});
			expect(classifyAuthError(flow, { statusCode: 502, body: {} })).toEqual({
				kind: 'generic',
				status: 500
			});
		}
	});

	test('sign-in: unverified, banned, everything else is credentials', () => {
		expect(classifyAuthError('sign-in', apiError(403, 'EMAIL_NOT_VERIFIED'))).toEqual({
			kind: 'unverified',
			status: 403
		});
		expect(classifyAuthError('sign-in', apiError(403, 'BANNED_USER'))).toEqual({
			kind: 'banned',
			status: 403
		});
		expect(classifyAuthError('sign-in', apiError(400, 'PASSWORD_TOO_SHORT'))).toEqual({
			kind: 'credentials',
			status: 400
		});
	});

	test('two-factor: every endpoint error is a bad code, even sign-in codes', () => {
		for (const code of ['INVALID_TWO_FACTOR_CODE', 'INVALID_BACKUP_CODE', 'BANNED_USER', '']) {
			expect(classifyAuthError('two-factor', apiError(401, code))).toEqual({
				kind: 'code',
				status: 400
			});
		}
	});

	test('sign-up: length and e-mail problems point at the field, the rest is generic', () => {
		expect(classifyAuthError('sign-up', apiError(400, 'PASSWORD_TOO_SHORT'))).toEqual({
			kind: 'generic',
			status: 400,
			field: 'short'
		});
		expect(classifyAuthError('sign-up', apiError(400, 'PASSWORD_TOO_LONG'))).toEqual({
			kind: 'generic',
			status: 400,
			field: 'long'
		});
		expect(classifyAuthError('sign-up', apiError(400, 'INVALID_EMAIL'))).toEqual({
			kind: 'generic',
			status: 400,
			field: 'email'
		});
		expect(classifyAuthError('sign-up', apiError(400, 'USER_ALREADY_EXISTS'))).toEqual({
			kind: 'generic',
			status: 400
		});
		// Sign-in codes mean nothing here.
		expect(classifyAuthError('sign-up', apiError(403, 'EMAIL_NOT_VERIFIED'))).toEqual({
			kind: 'generic',
			status: 400
		});
	});

	test('reset: token, user, length, and a generic rest', () => {
		for (const code of ['INVALID_TOKEN', 'TOKEN_EXPIRED', 'INVALID_USER']) {
			expect(classifyAuthError('reset', apiError(400, code))).toEqual({
				kind: 'token',
				status: 400
			});
		}
		expect(classifyAuthError('reset', apiError(400, 'PASSWORD_TOO_SHORT'))).toEqual({
			kind: 'generic',
			status: 400,
			field: 'short'
		});
		expect(classifyAuthError('reset', apiError(400, 'PASSWORD_TOO_LONG'))).toEqual({
			kind: 'generic',
			status: 400,
			field: 'long'
		});
		expect(classifyAuthError('reset', apiError(400, 'INVALID_EMAIL'))).toEqual({
			kind: 'generic',
			status: 400
		});
	});

	test('resend and request-reset hide every 4xx endpoint error', () => {
		for (const flow of ['resend', 'request-reset'] as const) {
			for (const code of ['EMAIL_NOT_VERIFIED', 'BANNED_USER', 'INVALID_TOKEN', '']) {
				expect(classifyAuthError(flow, apiError(403, code))).toBeNull();
			}
		}
	});
});

describe('resendAvailableAt: edges', () => {
	const now = 1_800_000_000_000;

	test('empty, too long or signed cookies are ignored', () => {
		expect(resendAvailableAt('', now)).toBeNull();
		expect(resendAvailableAt('1'.repeat(16), now)).toBeNull();
		expect(resendAvailableAt(`-${now}`, now)).toBeNull();
	});

	test('up to one minute of clock skew is tolerated, more is ignored', () => {
		expect(resendAvailableAt(String(now + 60_000), now)).toBe(now + 60_000 + 300_000);
		expect(resendAvailableAt(String(now + 60_001), now)).toBeNull();
	});

	test('the wait ends exactly at sentAt + 300 s', () => {
		expect(resendAvailableAt(String(now - 299_999), now)).toBe(now + 1);
		expect(resendAvailableAt(String(now - 300_000), now)).toBeNull();
	});

	test('insecure cookie for local http', () => {
		expect(resendCookie(now, false).options.secure).toBe(false);
	});
});

describe('signInFlow: every exit', () => {
	test('only the e-mail is wrong: one field issue, safe next kept, no API call', async () => {
		const { api, calls } = fakeApi({});
		const outcome = await signInFlow(
			form({ email: 'ana', password: 'x', next: '/cabo' }),
			context(api)
		);
		expect(outcome).toEqual({
			type: 'failure',
			status: 400,
			data: { values: { email: 'ana' }, fields: { email: 'email' }, next: '/cabo' }
		});
		expect(calls).toHaveLength(0);
	});

	test('only the password is missing: one field issue', async () => {
		const { api } = fakeApi({});
		const outcome = await signInFlow(form({ email: 'ana@example.com' }), context(api));
		expect(outcome).toEqual({
			type: 'failure',
			status: 400,
			data: { values: { email: 'ana@example.com' }, fields: { password: 'required' } }
		});
	});

	test('no auth service keeps the e-mail and the safe next', async () => {
		const outcome = await signInFlow(
			form({ email: 'ana@example.com', password: 'x', next: '/cabo' }),
			context(null)
		);
		expect(outcome).toEqual({
			type: 'failure',
			status: 503,
			data: { values: { email: 'ana@example.com' }, next: '/cabo', error: 'unavailable' }
		});
	});

	test('the two-factor step keeps the safe next', async () => {
		const { api } = fakeApi({ signIn: () => ({ twoFactorRedirect: true }) });
		const outcome = await signInFlow(
			form({ email: 'ana@example.com', password: 'secret-password', next: '/cabo' }),
			context(api)
		);
		expect(outcome).toEqual({ type: 'success', data: { step: 'two-factor', next: '/cabo' } });
	});

	test('only a literal twoFactorRedirect: true asks for the code', async () => {
		for (const result of [null, undefined, 'ok', { twoFactorRedirect: 'true' }, {}]) {
			const { api } = fakeApi({ signIn: () => result });
			const outcome = await signInFlow(
				form({ email: 'ana@example.com', password: 'secret-password' }),
				context(api)
			);
			expect(outcome).toEqual({ type: 'redirect', location: afterSignIn(null) });
		}
	});

	test.each([
		[apiError(403, 'EMAIL_NOT_VERIFIED'), 403, 'unverified'],
		[apiError(403, 'BANNED_USER'), 403, 'banned'],
		[apiError(400, 'TURNSTILE_REQUIRED'), 400, 'turnstile'],
		[apiError(503, 'TURNSTILE_UNAVAILABLE'), 503, 'unavailable'],
		[apiError(403, 'INVALID_ORIGIN'), 500, 'generic'],
		[new TypeError('network'), 500, 'generic']
	] as const)('API failure %# → %i %s, e-mail echoed', async (error, status, kind) => {
		const { api } = fakeApi({ signIn: throwing(error) });
		const outcome = await signInFlow(
			form({ email: 'ana@example.com', password: 'secret-password' }),
			context(api)
		);
		expect(outcome).toEqual({
			type: 'failure',
			status,
			data: { values: { email: 'ana@example.com' }, error: kind }
		});
	});

	test('a rate limit without Retry-After carries no wait', async () => {
		const { api } = fakeApi({ signIn: throwing(apiError(429, 'RATE_LIMITED')) });
		const outcome = await signInFlow(
			form({ email: 'ana@example.com', password: 'x' }),
			context(api)
		);
		expect(outcome).toEqual({
			type: 'failure',
			status: 429,
			data: { values: { email: 'ana@example.com' }, error: 'rate' }
		});
	});

	test('posts to the sign-in path without a Turnstile header when none was solved', async () => {
		const { api, calls } = fakeApi({});
		await signInFlow(form({ email: 'ana@example.com', password: 'x' }), context(api));
		expect(calls[0]?.init.request.url).toBe(`${ORIGIN}/api/auth/sign-in/email`);
		expect(calls[0]?.init.headers.has(TURNSTILE_HEADER)).toBe(false);
	});
});

describe('twoFactorFlow: every exit', () => {
	test('a malformed code keeps the step and the safe next, without an API call', async () => {
		const { api, calls } = fakeApi({});
		const outcome = await twoFactorFlow(form({ code: '12', next: '/cabo' }), context(api));
		expect(outcome).toEqual({
			type: 'failure',
			status: 400,
			data: { step: 'two-factor', fields: { code: 'code' }, next: '/cabo' }
		});
		expect(calls).toHaveLength(0);
	});

	test('a missing code is required', async () => {
		const { api } = fakeApi({});
		expect(await twoFactorFlow(form({}), context(api))).toMatchObject({
			data: { fields: { code: 'required' } }
		});
	});

	test('no auth service → unavailable on the code step', async () => {
		expect(await twoFactorFlow(form({ code: '123456', next: '/cabo' }), context(null))).toEqual({
			type: 'failure',
			status: 503,
			data: { step: 'two-factor', next: '/cabo', error: 'unavailable' }
		});
	});

	test('a bad backup code keeps the step and calls the backup endpoint', async () => {
		const { api, calls } = fakeApi({
			verifyBackupCode: throwing(apiError(401, 'INVALID_BACKUP_CODE'))
		});
		const outcome = await twoFactorFlow(
			form({ code: 'abcde-fghij', method: 'backup' }),
			context(api)
		);
		expect(outcome).toEqual({
			type: 'failure',
			status: 400,
			data: { step: 'two-factor', error: 'code' }
		});
		expect(calls.map((call) => call.method)).toEqual(['verifyBackupCode']);
		expect(calls[0]?.init.request.url).toBe(`${ORIGIN}/api/auth/two-factor/verify-backup-code`);
	});

	test('any method other than "backup" verifies TOTP', async () => {
		const { api, calls } = fakeApi({});
		await twoFactorFlow(form({ code: '123456', method: 'sms' }), context(api));
		expect(calls.map((call) => call.method)).toEqual(['verifyTotp']);
		expect(calls[0]?.init.request.url).toBe(`${ORIGIN}/api/auth/two-factor/verify-totp`);
	});

	test('a rate-limited code attempt carries the wait and keeps next', async () => {
		const { api } = fakeApi({ verifyTotp: throwing(apiError(429, 'RATE_LIMITED', 30)) });
		const outcome = await twoFactorFlow(form({ code: '123456', next: '/cabo' }), context(api));
		expect(outcome).toEqual({
			type: 'failure',
			status: 429,
			data: { step: 'two-factor', next: '/cabo', error: 'rate', retryAfter: 30 }
		});
	});
});

describe('signUpFlow: every exit', () => {
	const valid = {
		email: 'ana@example.com',
		password: 'violino-tarde-cobalto',
		confirm: 'violino-tarde-cobalto'
	};
	const enabled = (api: AuthPagesApi | null) => ({ ...context(api), signupEnabled: true });

	test('a bad e-mail alone is reported alone', async () => {
		const { api, calls } = fakeApi({});
		const outcome = await signUpFlow(form({ ...valid, email: 'nope' }), enabled(api));
		expect(outcome).toEqual({
			type: 'failure',
			status: 400,
			data: { values: { email: 'nope' }, fields: { email: 'email' } }
		});
		expect(calls).toHaveLength(0);
	});

	test('a password issue hides the confirmation check', async () => {
		const { api } = fakeApi({});
		const outcome = await signUpFlow(
			form({ ...valid, password: 'x'.repeat(129), confirm: 'other' }),
			enabled(api)
		);
		expect(outcome).toMatchObject({ data: { fields: { password: 'long' } } });
		expect(outcome.type === 'failure' && outcome.data.fields?.confirm).toBeFalsy();
	});

	test('an empty confirmation is required, not a mismatch', async () => {
		const { api } = fakeApi({});
		const outcome = await signUpFlow(form({ ...valid, confirm: '' }), enabled(api));
		expect(outcome).toEqual({
			type: 'failure',
			status: 400,
			data: { values: { email: 'ana@example.com' }, fields: { confirm: 'required' } }
		});
	});

	test('no auth service → unavailable with the e-mail kept', async () => {
		expect(await signUpFlow(form(valid), enabled(null))).toEqual({
			type: 'failure',
			status: 503,
			data: { values: { email: 'ana@example.com' }, error: 'unavailable' }
		});
	});

	test('an e-mail the server refuses marks the e-mail field', async () => {
		const { api } = fakeApi({ signUp: throwing(apiError(400, 'INVALID_EMAIL')) });
		expect(await signUpFlow(form(valid), enabled(api))).toEqual({
			type: 'failure',
			status: 400,
			data: { values: { email: 'ana@example.com' }, fields: { email: 'email' } }
		});
	});

	test('server length rules mark the password field', async () => {
		for (const [code, issue] of [
			['PASSWORD_TOO_SHORT', 'short'],
			['PASSWORD_TOO_LONG', 'long']
		] as const) {
			const { api } = fakeApi({ signUp: throwing(apiError(400, code)) });
			expect(await signUpFlow(form(valid), enabled(api))).toEqual({
				type: 'failure',
				status: 400,
				data: { values: { email: 'ana@example.com' }, fields: { password: issue } }
			});
		}
	});

	test.each([
		[apiError(400, 'USER_ALREADY_EXISTS'), 400, 'generic'],
		[apiError(400, 'TURNSTILE_FAILED'), 400, 'turnstile'],
		[apiError(503, 'RATE_LIMIT_UNAVAILABLE'), 503, 'unavailable'],
		[new Error('boom'), 500, 'generic']
	] as const)('API failure %# → %i %s', async (error, status, kind) => {
		const { api } = fakeApi({ signUp: throwing(error) });
		expect(await signUpFlow(form(valid), enabled(api))).toEqual({
			type: 'failure',
			status,
			data: { values: { email: 'ana@example.com' }, error: kind }
		});
	});

	test('a rate limit carries the wait', async () => {
		const { api } = fakeApi({ signUp: throwing(apiError(429, 'RATE_LIMITED', 45)) });
		expect(await signUpFlow(form(valid), enabled(api))).toEqual({
			type: 'failure',
			status: 429,
			data: { values: { email: 'ana@example.com' }, error: 'rate', retryAfter: 45 }
		});
	});

	test('success without next lands on the plain check-your-inbox page', async () => {
		const { api, calls } = fakeApi({});
		expect(await signUpFlow(form(valid), enabled(api))).toEqual({
			type: 'redirect',
			location: '/verificar-email?enviado=1',
			resendSent: true
		});
		expect(calls[0]?.init.request.url).toBe(`${ORIGIN}/api/auth/sign-up/email`);
		expect(calls[0]?.init.headers.has(TURNSTILE_HEADER)).toBe(false);
	});
});

describe('resendFlow: every exit', () => {
	const now = 1_800_000_000_000;
	const ctx = (api: AuthPagesApi | null, cooldownCookie?: string) => ({
		...context(api),
		now: () => now,
		cooldownCookie
	});

	test('a bad e-mail outside the wait is a field issue, no API call', async () => {
		const { api, calls } = fakeApi({});
		expect(await resendFlow(form({ email: '' }), ctx(api))).toEqual({
			type: 'failure',
			status: 400,
			data: { values: { email: '' }, fields: { email: 'required' } }
		});
		expect(calls).toHaveLength(0);
	});

	test('the wait is checked before the e-mail', async () => {
		const { api } = fakeApi({});
		expect(await resendFlow(form({ email: 'nope' }), ctx(api, String(now - 1000)))).toMatchObject({
			status: 429,
			data: { error: 'cooldown', retryAfter: 299 }
		});
	});

	test('no auth service → unavailable', async () => {
		expect(await resendFlow(form({ email: 'ana@example.com' }), ctx(null))).toEqual({
			type: 'failure',
			status: 503,
			data: { values: { email: 'ana@example.com' }, error: 'unavailable' }
		});
	});

	test('an expired wait sends with the callback keeping next and no Turnstile header', async () => {
		const { api, calls } = fakeApi({});
		const outcome = await resendFlow(
			form({ email: 'ana@example.com', next: '/cabo', [TURNSTILE_FIELD]: 'tok' }),
			ctx(api, String(now - 400_000))
		);
		expect(outcome).toMatchObject({ type: 'success', resendSent: true });
		expect(calls[0]?.body).toEqual({
			email: 'ana@example.com',
			callbackURL: '/verificar-email?verificado=1&next=%2Fcabo'
		});
		expect(calls[0]?.init.request.url).toBe(`${ORIGIN}/api/auth/send-verification-email`);
		expect(calls[0]?.init.headers.has(TURNSTILE_HEADER)).toBe(false);
	});

	test.each([
		[apiError(400, 'TURNSTILE_REQUIRED'), 400, 'turnstile'],
		[apiError(503, 'TURNSTILE_UNAVAILABLE'), 503, 'unavailable'],
		[apiError(403, 'INVALID_ORIGIN'), 500, 'generic'],
		[new Error('boom'), 500, 'generic']
	] as const)('surfaced failure %# → %i %s', async (error, status, kind) => {
		const { api } = fakeApi({ sendVerification: throwing(error) });
		expect(await resendFlow(form({ email: 'ana@example.com' }), ctx(api))).toEqual({
			type: 'failure',
			status,
			data: { values: { email: 'ana@example.com' }, error: kind }
		});
	});
});

describe('requestResetFlow: every exit', () => {
	test('a bad e-mail is a field issue, no API call', async () => {
		const { api, calls } = fakeApi({});
		expect(await requestResetFlow(form({ email: 'nope' }), context(api))).toEqual({
			type: 'failure',
			status: 400,
			data: { values: { email: 'nope' }, fields: { email: 'email' } }
		});
		expect(calls).toHaveLength(0);
	});

	test('no auth service → unavailable', async () => {
		expect(await requestResetFlow(form({ email: 'ana@example.com' }), context(null))).toEqual({
			type: 'failure',
			status: 503,
			data: { values: { email: 'ana@example.com' }, error: 'unavailable' }
		});
	});

	test.each([
		[apiError(429, 'RATE_LIMITED', 60), 429, { error: 'rate', retryAfter: 60 }],
		[apiError(503, 'RATE_LIMIT_UNAVAILABLE'), 503, { error: 'unavailable' }],
		[apiError(400, 'TURNSTILE_REQUIRED'), 400, { error: 'turnstile' }],
		[new Error('boom'), 500, { error: 'generic' }]
	] as const)('surfaced failure %# → %i', async (error, status, extra) => {
		const { api } = fakeApi({ requestReset: throwing(error) });
		expect(await requestResetFlow(form({ email: 'ana@example.com' }), context(api))).toEqual({
			type: 'failure',
			status,
			data: { values: { email: 'ana@example.com' }, ...extra }
		});
	});

	test('posts to the reset-request path', async () => {
		const { api, calls } = fakeApi({});
		await requestResetFlow(form({ email: 'ana@example.com' }), context(api));
		expect(calls[0]?.init.request.url).toBe(`${ORIGIN}/api/auth/request-password-reset`);
		expect(calls[0]?.body).toEqual({ email: 'ana@example.com' });
	});
});

describe('resetPasswordFlow: every exit', () => {
	const fresh = {
		token: 'tok123456789',
		password: 'nova-senha-longa',
		confirm: 'nova-senha-longa'
	};

	test('an oversized token is refused before anything else', async () => {
		const { api, calls } = fakeApi({});
		expect(
			await resetPasswordFlow(form({ ...fresh, token: 't'.repeat(513) }), context(api))
		).toEqual({ type: 'failure', status: 400, data: { error: 'token' } });
		expect(calls).toHaveLength(0);
		await resetPasswordFlow(form({ ...fresh, token: 't'.repeat(512) }), context(api));
		expect(calls).toHaveLength(1);
	});

	test('password issues hide the confirmation check', async () => {
		const { api } = fakeApi({});
		expect(
			await resetPasswordFlow(form({ ...fresh, password: 'short', confirm: '' }), context(api))
		).toEqual({ type: 'failure', status: 400, data: { fields: { password: 'short' } } });
	});

	test('empty confirmation is required, different one is a mismatch', async () => {
		const { api, calls } = fakeApi({});
		expect(await resetPasswordFlow(form({ ...fresh, confirm: '' }), context(api))).toEqual({
			type: 'failure',
			status: 400,
			data: { fields: { confirm: 'required' } }
		});
		expect(
			await resetPasswordFlow(form({ ...fresh, confirm: 'outra-senha-longa' }), context(api))
		).toEqual({ type: 'failure', status: 400, data: { fields: { confirm: 'mismatch' } } });
		expect(calls).toHaveLength(0);
	});

	test('no auth service → unavailable', async () => {
		expect(await resetPasswordFlow(form(fresh), context(null))).toEqual({
			type: 'failure',
			status: 503,
			data: { error: 'unavailable' }
		});
	});

	test('server length rules mark the password field', async () => {
		for (const [code, issue] of [
			['PASSWORD_TOO_SHORT', 'short'],
			['PASSWORD_TOO_LONG', 'long']
		] as const) {
			const { api } = fakeApi({ resetPassword: throwing(apiError(400, code)) });
			expect(await resetPasswordFlow(form(fresh), context(api))).toEqual({
				type: 'failure',
				status: 400,
				data: { fields: { password: issue } }
			});
		}
	});

	test.each([
		[apiError(400, 'TOKEN_EXPIRED'), 400, { error: 'token' }],
		[apiError(400, 'INVALID_USER'), 400, { error: 'token' }],
		[apiError(400, 'SOMETHING_ELSE'), 400, { error: 'generic' }],
		[apiError(429, 'RATE_LIMITED', 20), 429, { error: 'rate', retryAfter: 20 }],
		[apiError(503, 'TURNSTILE_UNAVAILABLE'), 503, { error: 'unavailable' }],
		[new Error('boom'), 500, { error: 'generic' }]
	] as const)('API failure %# → %i', async (error, status, data) => {
		const { api } = fakeApi({ resetPassword: throwing(error) });
		expect(await resetPasswordFlow(form(fresh), context(api))).toEqual({
			type: 'failure',
			status,
			data
		});
	});

	test('posts to the reset path without a Turnstile header', async () => {
		const { api, calls } = fakeApi({});
		await resetPasswordFlow(form({ ...fresh, [TURNSTILE_FIELD]: 'tok' }), context(api));
		expect(calls[0]?.init.request.url).toBe(`${ORIGIN}/api/auth/reset-password`);
		expect(calls[0]?.init.headers.has(TURNSTILE_HEADER)).toBe(false);
	});
});
