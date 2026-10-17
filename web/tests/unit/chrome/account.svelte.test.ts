import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { AccountEntry, CableBar, type AccountProbe } from '#lib/components/chrome/index.ts';
import AccountSessionFixture from './AccountSessionFixture.svelte';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

test('anonymous: "Entrar" returns to the current page', async () => {
	await render(AccountEntry, { user: null, currentPath: '/biblioteca' });
	await expect
		.element(page.getByRole('link', { name: 'Entrar' }))
		.toHaveAttribute('href', '/entrar?next=%2Fbiblioteca');
});

test('signed in: the nickname links to the account, never the e-mail', async () => {
	await render(AccountEntry, {
		user: { id: 'u-ana', username: 'ana', emailVerified: true },
		currentPath: '/conta/seguranca'
	});
	const link = page.getByRole('link', { name: /^Conta:\s*ana$/ });
	await expect.element(link).toHaveAttribute('href', '/conta');
	await expect.element(link).toHaveAttribute('aria-current', 'page');
	await expect.element(link).toMatchTextContent(/\bana\b/);
	expect(document.body.textContent).not.toContain('@');
});

test('signed in without a nickname yet, and unverified e-mail', async () => {
	await render(AccountEntry, { user: { id: 'u-x', username: null, emailVerified: false } });
	await expect
		.element(page.getByRole('link', { name: /^Conta\s*\(e-mail não confirmado\)$/ }))
		.toHaveAttribute('href', '/conta');
});

test('CableBar renders the account snippet next to the language toggle', async () => {
	await render(CableBar, {
		account: createRawSnippet(() => ({ render: () => '<a href="/entrar">Entrar</a>' }))
	});
	const link = page.getByRole('link', { name: 'Entrar' }).element();
	const toggle = page.getByRole('button', { name: 'Switch to English' }).element();
	expect(link.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('CableBar without the snippet keeps its previous content', async () => {
	await render(CableBar);
	expect(page.getByRole('link', { name: 'Entrar' }).elements()).toHaveLength(0);
});

test('resolved session data is used as is, without probing', async () => {
	const probe = vi.fn<AccountProbe>(async () => null);
	await render(AccountSessionFixture, {
		user: { id: 'u-ana', username: 'ana', emailVerified: true },
		resolved: true,
		path: '/conta',
		probe
	});
	await expect.element(page.getByRole('link', { name: /^Conta:\s*ana$/ })).toBeVisible();
	expect(probe).not.toHaveBeenCalled();
});

test('prerendered pages probe the session and show the answer', async () => {
	const probe = vi.fn<AccountProbe>(async () => ({
		id: 'u-bia',
		username: 'bia',
		emailVerified: true
	}));
	const screen = await render(AccountSessionFixture, {
		user: null,
		resolved: false,
		path: '/biblioteca',
		probe
	});
	await expect.element(page.getByRole('link', { name: /^Conta:\s*bia$/ })).toBeVisible();
	expect(probe).toHaveBeenCalledTimes(1);
	await screen.rerender({ path: '/cabo' });
	await expect.poll(() => probe.mock.calls.length).toBe(2);
});

test('a failed probe reads as anonymous', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	await render(AccountSessionFixture, {
		user: null,
		resolved: false,
		path: '/',
		probe: async () => {
			throw new Error('boom');
		}
	});
	await expect.element(page.getByRole('link', { name: 'Entrar' })).toBeVisible();
	await expect.poll(() => document.querySelector('output')?.dataset.known).toBe('true');
	warn.mockRestore();
});
