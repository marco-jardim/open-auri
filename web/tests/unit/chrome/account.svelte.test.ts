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

test('signed in: the nickname opens the user menu, never the e-mail', async () => {
	await render(AccountEntry, {
		user: { id: 'u-ana', username: 'ana', emailVerified: true },
		currentPath: '/conta/seguranca'
	});
	const trigger = page.getByRole('button', { name: /^Conta:\s*ana$/ });
	await expect.element(trigger).toHaveAttribute('aria-haspopup', 'menu');
	await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');
	await expect.element(trigger).toHaveAttribute('data-account', 'signed-in');
	await expect.element(trigger).toMatchTextContent(/\bana\b/);
	await trigger.click();
	const account = page.getByRole('menuitem', { name: 'Minha conta' });
	await expect.element(account).toHaveAttribute('href', '/conta');
	await expect.element(account).toHaveAttribute('aria-current', 'page');
	await expect
		.element(page.getByRole('menuitem', { name: 'Meu perfil público' }))
		.toHaveAttribute('href', '/u/ana');
	await expect
		.element(page.getByRole('menuitem', { name: 'Minha biblioteca' }))
		.toHaveAttribute('href', '/biblioteca');
	expect(page.getByRole('menuitem', { name: 'Admin' }).elements()).toHaveLength(0);
	expect(document.body.textContent).not.toContain('@');
});

test('signed in without a nickname yet, and unverified e-mail', async () => {
	await render(AccountEntry, { user: { id: 'u-x', username: null, emailVerified: false } });
	const trigger = page.getByRole('button', { name: /^Conta\s*\(e-mail não confirmado\)$/ });
	await trigger.click();
	await expect
		.element(page.getByRole('menuitem', { name: 'Minha conta' }))
		.toHaveAttribute('href', '/conta');
	// No nickname, no public profile yet.
	expect(page.getByRole('menuitem', { name: 'Meu perfil público' }).elements()).toHaveLength(0);
});

test('the Admin item appears only when the admin role is effective', async () => {
	await render(AccountEntry, {
		user: { id: 'u-ana', username: 'ana', emailVerified: true },
		admin: true
	});
	await page.getByRole('button', { name: /^Conta:\s*ana$/ }).click();
	await expect
		.element(page.getByRole('menuitem', { name: 'Admin' }))
		.toHaveAttribute('href', '/admin');
});

test('Sair signs out through the given flow, then reloads; failures are shown', async () => {
	const signOut = vi
		.fn<() => Promise<void>>()
		.mockRejectedValueOnce(new Error('offline'))
		.mockResolvedValueOnce(undefined);
	const onSignedOut = vi.fn();
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	await render(AccountEntry, {
		user: { id: 'u-ana', username: 'ana', emailVerified: true },
		currentPath: '/conta/seguranca',
		signOut,
		onSignedOut
	});
	const trigger = page.getByRole('button', { name: /^Conta:\s*ana$/ });
	await trigger.click();
	await page.getByRole('menuitem', { name: 'Sair' }).click();
	await expect
		.element(page.getByRole('status'))
		.toHaveTextContent('Não foi possível sair agora. Tente de novo.');
	await expect.element(trigger).toHaveAttribute('aria-expanded', 'true');
	expect(onSignedOut).not.toHaveBeenCalled();
	await page.getByRole('menuitem', { name: 'Sair' }).click();
	await expect.poll(() => onSignedOut.mock.calls).toEqual([['/']]);
	expect(signOut).toHaveBeenCalledTimes(2);
	warn.mockRestore();
});

test('Sair waits while a cable write sends bytes, and says why', async () => {
	const signOut = vi.fn<() => Promise<void>>(async () => undefined);
	const scope = globalThis as typeof globalThis & { __oaWriteInProgress?: boolean };
	scope.__oaWriteInProgress = true;
	try {
		await render(AccountEntry, {
			user: { id: 'u-ana', username: 'ana', emailVerified: true },
			signOut,
			onSignedOut: vi.fn()
		});
		await page.getByRole('button', { name: /^Conta:\s*ana$/ }).click();
		const item = page.getByRole('menuitem', { name: 'Sair' });
		await expect.element(item).toHaveAttribute('aria-disabled', 'true');
		await expect
			.element(item)
			.toHaveAccessibleDescription('Gravando no cabo. Saia quando a gravação terminar.');
		(item.element() as HTMLElement).click();
		expect(signOut).not.toHaveBeenCalled();
	} finally {
		scope.__oaWriteInProgress = false;
	}
});

test('CableBar renders the account snippet next to the language toggle', async () => {
	// Desktop: on mobile both live in the menu sheet (FUX.NAV).
	await page.viewport(1440, 900);
	await render(CableBar, {
		account: createRawSnippet(() => ({ render: () => '<a href="/entrar">Entrar</a>' }))
	});
	const link = page.getByRole('link', { name: 'Entrar' }).element();
	const toggle = page.getByRole('button', { name: /Switch to English/ }).element();
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
	await expect.element(page.getByRole('button', { name: /^Conta:\s*ana$/ })).toBeVisible();
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
	await expect.element(page.getByRole('button', { name: /^Conta:\s*bia$/ })).toBeVisible();
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
