import { isActionFailure, isRedirect, type Cookies } from '@sveltejs/kit';
import { describe, expect, test, vi } from 'vitest';
import { RESEND_COOKIE } from '#lib/components/auth/actions.server.ts';
import {
	AUTH_PAGE_HEADERS,
	finish,
	flowContext,
	readResendCooldown,
	signupEnabled,
	type AuthEvent
} from '#lib/components/auth/kit.server.ts';

function cookies(initial: Record<string, string> = {}) {
	const jar = new Map(Object.entries(initial));
	const set = vi.fn((name: string, value: string) => {
		jar.set(name, value);
	});
	const store: Cookies = {
		get: (name) => jar.get(name),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set,
		delete: (name) => {
			jar.delete(name);
		},
		parse: vi.fn<Cookies['parse']>(),
		serialize: (name, value) => `${name}=${value}`
	};
	return { store, set };
}

function event(protocol: 'https:' | 'http:' = 'https:', jar = cookies()): AuthEvent {
	return {
		request: new Request(`${protocol}//app.example/entrar`, { method: 'POST' }),
		url: new URL(`${protocol}//app.example/entrar`),
		cookies: jar.store,
		locals: { auth: null, user: null, session: null }
	};
}

function caught(run: () => unknown): unknown {
	try {
		run();
	} catch (thrown) {
		return thrown;
	}
	throw new Error('expected a throw');
}

describe('finish', () => {
	test('redirect outcomes throw a 303 redirect', () => {
		const thrown = caught(() => finish({ type: 'redirect', location: '/cabo' }, event()));
		expect(isRedirect(thrown)).toBe(true);
		if (isRedirect(thrown)) {
			expect(thrown.status).toBe(303);
			expect(thrown.location).toBe('/cabo');
		}
	});

	test('failures become ActionFailure with the same data', () => {
		const result = finish(
			{ type: 'failure', status: 400, data: { error: 'credentials' } },
			event()
		);
		expect(isActionFailure(result)).toBe(true);
		if (isActionFailure(result)) {
			expect(result.status).toBe(400);
			expect(result.data).toEqual({ error: 'credentials' });
		}
	});

	test('a sent verification e-mail starts the resend wait (Secure on https only)', () => {
		const jar = cookies();
		const data = finish(
			{ type: 'success', data: { sent: true }, resendSent: true },
			event('https:', jar)
		);
		expect(data).toEqual({ sent: true });
		expect(jar.set).toHaveBeenCalledWith(
			RESEND_COOKIE,
			expect.stringMatching(/^\d+$/),
			expect.objectContaining({ secure: true, httpOnly: true, maxAge: 300, path: '/' })
		);
		const plain = cookies();
		finish({ type: 'success', data: {}, resendSent: true }, event('http:', plain));
		expect(plain.set).toHaveBeenCalledWith(
			RESEND_COOKIE,
			expect.any(String),
			expect.objectContaining({ secure: false })
		);
	});

	test('failures never start the wait', () => {
		const jar = cookies();
		finish({ type: 'failure', status: 429, data: { error: 'rate' } }, event('https:', jar));
		expect(jar.set).not.toHaveBeenCalled();
	});
});

describe('event helpers', () => {
	test('no platform: auth service unavailable, sign-up closed', () => {
		expect(flowContext(event()).api).toBeNull();
		expect(signupEnabled({ platform: undefined })).toBe(false);
	});

	test('the call builder falls back to the request origin without env', () => {
		const call = flowContext(event()).call('/sign-in/email', 'tok');
		expect(call.headers.get('origin')).toBe('https://app.example');
		expect(call.headers.get('x-turnstile-token')).toBe('tok');
	});

	test('resend wait read from the cookie', () => {
		const now = 1_800_000_000_000;
		const jar = cookies({ [RESEND_COOKIE]: String(now - 100_000) });
		expect(readResendCooldown({ cookies: jar.store }, now)).toBe(now + 200_000);
	});

	test('pages are never cached or indexed', () => {
		expect(AUTH_PAGE_HEADERS).toEqual({
			'cache-control': 'private, no-store',
			'x-robots-tag': 'noindex, nofollow'
		});
	});
});
