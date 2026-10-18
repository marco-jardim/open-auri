// AccountEntry edges: current-page markers, monogram, compact bar tooltip, the default
// Better Auth sign-out, the busy guard and the live cable-write flag.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { withWriteFlag } from '#lib/cable/write-flag.ts';
import AccountEntry, { SIGN_OUT_ENDPOINT } from '#lib/components/chrome/AccountEntry.svelte';
import AccountCompactFixture from './AccountCompactFixture.svelte';

const ana = { id: 'u-ana', username: 'ana', emailVerified: true };
const trigger = () => page.getByRole('button', { name: /^Conta:\s*ana$/ });

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

async function openMenu() {
	const button = trigger();
	if (button.element().getAttribute('aria-expanded') !== 'true') await button.click();
	await expect.element(page.getByRole('menuitem', { name: 'Sair' })).toBeVisible();
}

describe('anonymous entry', () => {
	test('"Entrar" is the current page on /entrar, even with a query or a hash', async () => {
		for (const currentPath of ['/entrar', '/entrar?next=%2Fcabo', '/entrar#form']) {
			await render(AccountEntry, { user: null, currentPath });
			await expect
				.element(page.getByRole('link', { name: 'Entrar' }))
				.toHaveAttribute('aria-current', 'page');
			await cleanup();
		}
		await render(AccountEntry, { user: null, currentPath: '/entrar-agora' });
		await expect
			.element(page.getByRole('link', { name: 'Entrar' }))
			.not.toHaveAttribute('aria-current');
	});

	test('while the session is being asked, the link says it is pending', async () => {
		await render(AccountEntry, { user: null, pending: true });
		await expect
			.element(page.getByRole('link', { name: 'Entrar' }))
			.toHaveAttribute('data-account', 'pending');
		await cleanup();
		await render(AccountEntry, { user: null });
		await expect
			.element(page.getByRole('link', { name: 'Entrar' }))
			.toHaveAttribute('data-account', 'anonymous');
	});
});

describe('signed-in markers', () => {
	test('the public profile is current on /u/<name>, query and hash ignored', async () => {
		await render(AccountEntry, {
			user: { id: 'u-x', username: 'ana b', emailVerified: true },
			currentPath: '/u/ana%20b?aba=curvas#topo'
		});
		await page.getByRole('button', { name: /^Conta:\s*ana b$/ }).click();
		const profile = page.getByRole('menuitem', { name: 'Meu perfil público' });
		await expect.element(profile).toHaveAttribute('href', '/u/ana%20b');
		await expect.element(profile).toHaveAttribute('aria-current', 'page');
		await expect
			.element(page.getByRole('menuitem', { name: 'Minha conta' }))
			.not.toHaveAttribute('aria-current');
		await expect
			.element(page.getByRole('menuitem', { name: 'Minha biblioteca' }))
			.not.toHaveAttribute('aria-current');
	});

	test('the library is current on /biblioteca', async () => {
		await render(AccountEntry, { user: ana, currentPath: '/biblioteca' });
		await trigger().click();
		await expect
			.element(page.getByRole('menuitem', { name: 'Minha biblioteca' }))
			.toHaveAttribute('aria-current', 'page');
		await expect.element(trigger()).not.toHaveClass('is-current');
	});

	test('Admin is current anywhere under /admin', async () => {
		await render(AccountEntry, { user: ana, admin: true, currentPath: '/admin/usuarios' });
		await trigger().click();
		await expect
			.element(page.getByRole('menuitem', { name: 'Admin' }))
			.toHaveAttribute('aria-current', 'page');
	});

	test('the trigger is current under /conta, but not on a path that only starts alike', async () => {
		await render(AccountEntry, { user: ana, currentPath: '/conta/seguranca' });
		await expect.element(trigger()).toHaveClass('is-current');
		await cleanup();
		await render(AccountEntry, { user: ana, currentPath: '/contador' });
		await expect.element(trigger()).not.toHaveClass('is-current');
		await trigger().click();
		await expect
			.element(page.getByRole('menuitem', { name: 'Minha conta' }))
			.not.toHaveAttribute('aria-current');
	});

	test('the avatar shows the upper-case first letter, or a person glyph without a nickname', async () => {
		const screen = await render(AccountEntry, {
			user: { id: 'u-e', username: 'élan', emailVerified: true }
		});
		const avatar = screen.container.querySelector('.avatar');
		expect(avatar?.textContent?.trim()).toBe('É');
		expect(avatar?.querySelector('svg')).toBeNull();
		expect(avatar?.querySelector('.dot.warn')).toBeNull();
		await cleanup();
		const anonymous = await render(AccountEntry, {
			user: { id: 'u-x', username: null, emailVerified: false }
		});
		const glyph = anonymous.container.querySelector('.avatar');
		expect(glyph?.querySelector('svg')).not.toBeNull();
		expect(glyph?.querySelector('.dot.warn')).not.toBeNull();
	});
});

describe('compact bar', () => {
	test('the signed-in trigger keeps its name in a tooltip', async () => {
		const screen = await render(AccountCompactFixture, { user: ana });
		await userEvent.tab();
		await expect
			.poll(() => document.querySelector('[role="tooltip"]')?.textContent?.trim())
			.toBe('ana');
		expect(screen.container.querySelector('.bar-compact .account-trigger')).not.toBeNull();
	});

	test('without a nickname the tooltip says "Conta"', async () => {
		await render(AccountCompactFixture, {
			user: { id: 'u-x', username: null, emailVerified: true }
		});
		await userEvent.tab();
		await expect
			.poll(() => document.querySelector('[role="tooltip"]')?.textContent?.trim())
			.toBe('Conta');
	});

	test('the anonymous link keeps "Entrar" in a tooltip', async () => {
		await render(AccountCompactFixture, { user: null });
		await userEvent.tab();
		await expect
			.poll(() => document.querySelector('[role="tooltip"]')?.textContent?.trim())
			.toBe('Entrar');
	});

	test('outside the compact bar there is no tooltip', async () => {
		await render(AccountEntry, { user: ana });
		await userEvent.tab();
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
	});
});

describe('sign-out', () => {
	test('the default flow POSTs to Better Auth and stays on a public page', async () => {
		const onSignedOut = vi.fn();
		await render(AccountEntry, { user: ana, currentPath: '/biblioteca?aba=1', onSignedOut });
		await openMenu();
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}', { status: 200 }));
		await page.getByRole('menuitem', { name: 'Sair' }).click();
		await expect.poll(() => onSignedOut.mock.calls).toEqual([['/biblioteca?aba=1']]);
		expect(fetchSpy).toHaveBeenCalledWith(
			SIGN_OUT_ENDPOINT,
			expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: '{}' })
		);
		expect(SIGN_OUT_ENDPOINT).toBe('/api/auth/sign-out');
	});

	test('a refused default sign-out is shown and keeps the menu open', async () => {
		const onSignedOut = vi.fn();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await render(AccountEntry, { user: ana, currentPath: '/', onSignedOut });
		await openMenu();
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 500 }));
		await page.getByRole('menuitem', { name: 'Sair' }).click();
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent('Não foi possível sair agora. Tente de novo.');
		await expect.element(trigger()).toHaveAttribute('aria-expanded', 'true');
		expect(onSignedOut).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
	});

	test('signing out of an admin page goes home', async () => {
		const onSignedOut = vi.fn();
		await render(AccountEntry, {
			user: ana,
			admin: true,
			currentPath: '/admin/auditoria',
			signOut: async () => undefined,
			onSignedOut
		});
		await openMenu();
		await page.getByRole('menuitem', { name: 'Sair' }).click();
		await expect.poll(() => onSignedOut.mock.calls).toEqual([['/']]);
	});

	test('while a sign-out is running the trigger is busy and a second Sair does nothing', async () => {
		let finish: () => void = () => undefined;
		const signOut = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		const onSignedOut = vi.fn();
		await render(AccountEntry, { user: ana, currentPath: '/cabo', signOut, onSignedOut });
		await openMenu();
		await page.getByRole('menuitem', { name: 'Sair' }).click();
		await expect.element(trigger()).toHaveAttribute('aria-busy', 'true');
		await openMenu();
		await page.getByRole('menuitem', { name: 'Sair' }).click();
		expect(signOut).toHaveBeenCalledTimes(1);
		finish();
		await expect.poll(() => onSignedOut.mock.calls).toEqual([['/cabo']]);
		await expect.element(trigger()).not.toHaveAttribute('aria-busy');
	});

	test('Sair follows the cable-write flag live', async () => {
		await render(AccountEntry, { user: ana, signOut: async () => undefined, onSignedOut: vi.fn() });
		await openMenu();
		const item = page.getByRole('menuitem', { name: 'Sair' });
		await expect.element(item).not.toHaveAttribute('aria-disabled', 'true');
		let release: () => void = () => undefined;
		const writing = withWriteFlag(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		await expect.element(item).toHaveAttribute('aria-disabled', 'true');
		await expect
			.element(item)
			.toHaveAccessibleDescription('Gravando no cabo. Saia quando a gravação terminar.');
		release();
		await writing;
		await expect.element(item).not.toHaveAttribute('aria-disabled', 'true');
	});
});
