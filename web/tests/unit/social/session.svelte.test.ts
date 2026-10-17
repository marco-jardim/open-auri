import { describe, expect, it } from 'vitest';
import { SESSION_ENDPOINT, signInHref, type FetchLike } from '#lib/components/chrome/account.ts';
import { createSocialSession, requireLoginHref } from '#lib/social/index.ts';

function sessionFetch(respond: () => Response | Promise<Response>) {
	const urls: string[] = [];
	const fetch: FetchLike = async (input) => {
		urls.push(input);
		return respond();
	};
	return { fetch, urls };
}

function body(user: Record<string, unknown> | null) {
	return new Response(JSON.stringify(user === null ? null : { user, session: {} }), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

describe('createSocialSession', () => {
	it('starts unknown and signed out without an initial summary', () => {
		const session = createSocialSession({ fetch: sessionFetch(() => body(null)).fetch });
		expect([session.known, session.signedIn, session.verified, session.nickname]).toEqual([
			false,
			false,
			false,
			null
		]);
		expect(session.accountId).toBeNull();
	});

	it('derives signedIn, verified, accountId and nickname from the account summary', async () => {
		const { fetch, urls } = sessionFetch(() =>
			body({
				id: 'u-ana',
				username: 'ana',
				displayUsername: 'Ana',
				emailVerified: true,
				email: 'x@y.z'
			})
		);
		const session = createSocialSession({ fetch });
		const summary = await session.refresh();
		expect(urls).toEqual([SESSION_ENDPOINT]);
		expect(summary).toEqual({ id: 'u-ana', username: 'Ana', emailVerified: true });
		expect([session.known, session.signedIn, session.verified, session.nickname]).toEqual([
			true,
			true,
			true,
			'Ana'
		]);
		expect(session.accountId).toBe('u-ana');
		expect(JSON.stringify(session.account)).not.toContain('x@y.z');
	});

	it('is signed in but not verified before the e-mail is confirmed', () => {
		const session = createSocialSession({
			initial: { id: 'u1', username: null, emailVerified: false }
		});
		expect([session.signedIn, session.verified, session.nickname]).toEqual([true, false, null]);
	});

	it('follows set(): sign-out clears the accountId, a switch replaces it', () => {
		const session = createSocialSession({
			initial: { id: 'u-ana', username: 'Ana', emailVerified: true }
		});
		session.set({ id: 'u-bia', username: 'Bia', emailVerified: true });
		expect(session.accountId).toBe('u-bia');
		session.set(null);
		expect(session.accountId).toBeNull();
	});

	it('reads any failure as signed out', async () => {
		const unauthorized = createSocialSession({
			initial: { id: 'u1', username: 'ana', emailVerified: true },
			fetch: sessionFetch(() => new Response('', { status: 401 })).fetch
		});
		await unauthorized.refresh();
		expect(unauthorized.signedIn).toBe(false);

		const offline = createSocialSession({
			initial: { id: 'u1', username: 'ana', emailVerified: true },
			fetch: sessionFetch(() => Promise.reject(new TypeError('Failed to fetch'))).fetch
		});
		await offline.refresh();
		expect([offline.known, offline.signedIn, offline.verified]).toEqual([true, false, false]);
	});

	it('lets set() win over a refresh still in flight', async () => {
		let resolve: (response: Response) => void = () => undefined;
		const pending = new Promise<Response>((done) => {
			resolve = done;
		});
		const session = createSocialSession({ fetch: sessionFetch(() => pending).fetch });
		const refreshing = session.refresh();
		session.set(null);
		resolve(body({ id: 'u1', username: 'ana', emailVerified: true }));
		await refreshing;
		expect(session.signedIn).toBe(false);
		expect(session.known).toBe(true);
	});
});

describe('requireLoginHref', () => {
	it('reuses the header sign-in link that returns to the page', () => {
		for (const path of ['/c/abc?s=1', '/comunidade', '/entrar']) {
			expect(requireLoginHref(path)).toBe(signInHref(path));
		}
		expect(requireLoginHref('/c/abc')).toMatch(/^\/entrar/);
	});
});
