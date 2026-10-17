import { describe, expect, test, vi } from 'vitest';
import {
	POLICY_ACCEPT_ENDPOINT,
	SESSION_ENDPOINT,
	fetchAccount,
	postPolicyAcceptance,
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

	test('any failure reads as signed out', async () => {
		expect(await fetchAccount(async () => json({ error: 'x' }, 503))).toBeNull();
		expect(await fetchAccount(async () => json(null))).toBeNull();
		expect(await fetchAccount(async () => new Response('not json'))).toBeNull();
		expect(
			await fetchAccount(async () => {
				throw new TypeError('offline');
			})
		).toBeNull();
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
