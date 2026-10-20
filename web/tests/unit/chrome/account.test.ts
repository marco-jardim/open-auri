import { describe, expect, test, vi } from 'vitest';
import {
	POLICY_ACCEPT_ENDPOINT,
	SESSION_ENDPOINT,
	fetchAccount,
	postPolicyAcceptance,
	probeAccount,
	signInHref,
	toAccountSummary,
	type FetchLike
} from '#lib/components/chrome/account.ts';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

describe('toAccountSummary', () => {
	test('keeps only the own id, the nickname and the verification flag (never the e-mail)', () => {
		const summary = toAccountSummary({
			user: {
				id: 'u1',
				email: 'ana@example.com',
				name: '',
				username: 'ana',
				displayUsername: 'Ana',
				emailVerified: true,
				role: 'admin'
			},
			session: { id: 's1' }
		});
		expect(summary).toEqual({ id: 'u1', username: 'Ana', emailVerified: true });
		expect(JSON.stringify(summary)).not.toContain('example.com');
		expect(JSON.stringify(summary)).not.toContain('s1');
	});

	test('falls back to username, then null', () => {
		expect(toAccountSummary({ user: { id: 'u1', username: 'ana', emailVerified: false } })).toEqual(
			{ id: 'u1', username: 'ana', emailVerified: false }
		);
		expect(toAccountSummary({ user: { id: 'u2', displayUsername: '' } })).toEqual({
			id: 'u2',
			username: null,
			emailVerified: false
		});
	});

	test('signed out or malformed bodies are null', () => {
		expect(toAccountSummary(null)).toBeNull();
		expect(toAccountSummary({ user: null })).toBeNull();
		expect(toAccountSummary('x')).toBeNull();
	});

	test('a user without a string id is not a usable session', () => {
		expect(toAccountSummary({ user: { username: 'ana', emailVerified: true } })).toBeNull();
		expect(toAccountSummary({ user: { id: '', emailVerified: true } })).toBeNull();
		expect(toAccountSummary({ user: { id: 42, emailVerified: true } })).toBeNull();
	});

	test('carries only a true admin menu hint for an effective admin session (FUX.2)', () => {
		const admin = {
			id: 'u9',
			username: 'root',
			emailVerified: true,
			role: 'admin',
			banned: false,
			twoFactorEnabled: true
		};
		const session = { id: 's9', twoFactorVerifiedAt: '2026-10-17T10:00:00.000Z' };
		const effective = toAccountSummary({ user: admin, session });
		expect(effective).toStrictEqual({
			id: 'u9',
			username: 'root',
			emailVerified: true,
			admin: true
		});
		expect(JSON.stringify(effective)).not.toContain('role');
		// Anything short of the server rule reads as "no hint" (the key is absent, never false).
		for (const body of [
			{ user: { ...admin, role: 'user' }, session },
			{ user: { ...admin, role: 'admin,user' }, session },
			{ user: { ...admin, banned: true }, session },
			{ user: { ...admin, twoFactorEnabled: false }, session },
			{ user: admin, session: { ...session, impersonatedBy: 'u1' } },
			{ user: admin, session: { id: 's9', twoFactorVerifiedAt: null } },
			{ user: admin, session: { id: 's9', twoFactorVerifiedAt: '' } },
			{ user: admin, session: null },
			{ user: admin }
		]) {
			const summary = toAccountSummary(body);
			expect(summary).not.toBeNull();
			expect(summary && Object.hasOwn(summary, 'admin')).toBe(false);
		}
		expect(
			toAccountSummary({ user: admin, session: { twoFactorVerifiedAt: 1760695200000 } })
		).toEqual(expect.objectContaining({ admin: true }));
	});
});

describe('fetchAccount', () => {
	test('asks the same-origin session endpoint', async () => {
		const fetcher = vi.fn<FetchLike>(async () => json({ user: { id: 'u1', username: 'ana' } }));
		expect(await fetchAccount(fetcher)).toEqual({
			id: 'u1',
			username: 'ana',
			emailVerified: false
		});
		expect(fetcher).toHaveBeenCalledWith(
			SESSION_ENDPOINT,
			expect.objectContaining({ credentials: 'same-origin' })
		);
	});

	test('failed probes stay unknown and only a successful empty session is signed out', async () => {
		expect(await fetchAccount(async () => json({ error: 'x' }, 503))).toBeUndefined();
		expect(await fetchAccount(async () => json(null))).toBeNull();
		expect(await fetchAccount(async () => new Response('not json'))).toBeUndefined();
		expect(
			await fetchAccount(async () => {
				throw new TypeError('offline');
			})
		).toBeUndefined();
	});

	test('aborts propagate so a newer probe wins', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			fetchAccount(async () => {
				throw new DOMException('aborted', 'AbortError');
			}, controller.signal)
		).rejects.toThrow('aborted');
	});
});

describe('probeAccount (FX4.10)', () => {
	test('a successful answer with a user is signed in', async () => {
		expect(await probeAccount(async () => json({ user: { id: 'u1', username: 'ana' } }))).toEqual({
			status: 'signed-in',
			account: { id: 'u1', username: 'ana', emailVerified: false }
		});
	});

	test('only a successful answer without a usable session is a definitive sign-out', async () => {
		expect(await probeAccount(async () => json(null))).toEqual({ status: 'signed-out' });
		expect(await probeAccount(async () => json({ user: null }))).toEqual({ status: 'signed-out' });
		expect(await probeAccount(async () => json({ user: { id: '' } }))).toEqual({
			status: 'signed-out'
		});
	});

	test('failures are errors, never signed out', async () => {
		expect(await probeAccount(async () => json({ error: 'x' }, 503))).toEqual({ status: 'error' });
		expect(await probeAccount(async () => json(null, 404))).toEqual({ status: 'error' });
		expect(await probeAccount(async () => new Response('not json'))).toEqual({ status: 'error' });
		expect(
			await probeAccount(async () => {
				throw new TypeError('offline');
			})
		).toEqual({ status: 'error' });
	});

	test('aborts propagate', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			probeAccount(async () => {
				throw new DOMException('aborted', 'AbortError');
			}, controller.signal)
		).rejects.toThrow('aborted');
	});
});

describe('signInHref', () => {
	test('returns to the current page', () => {
		expect(signInHref('/biblioteca')).toBe('/entrar?next=%2Fbiblioteca');
		expect(signInHref('/')).toBe('/entrar');
	});

	test('no next from the auth pages themselves', () => {
		expect(signInHref('/entrar')).toBe('/entrar');
		expect(signInHref('/redefinir-senha')).toBe('/entrar');
	});
});

describe('postPolicyAcceptance', () => {
	test('POSTs JSON { version } to the account endpoint', async () => {
		const fetcher = vi.fn<FetchLike>(async () => json({ ok: true }));
		await postPolicyAcceptance('2026-10-01', fetcher);
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(url).toBe(POLICY_ACCEPT_ENDPOINT);
		expect(init?.method).toBe('POST');
		expect(init?.credentials).toBe('same-origin');
		expect(init?.body).toBe(JSON.stringify({ version: '2026-10-01' }));
	});

	test('rejects on failure so the banner stays open', async () => {
		await expect(postPolicyAcceptance('2026-10-01', async () => json({}, 403))).rejects.toThrow(
			'HTTP 403'
		);
	});
});
