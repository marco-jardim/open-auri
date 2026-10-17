// Menu button (FUX.1, spec §2.6, user menu): roles, aria, keyboard, outside click, fixed
// positioning, unavailable items with a reason.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { Menu, type MenuItem } from '#lib/components/primitives/index.ts';
import './design-system.ts';

const trigger = createRawSnippet(() => ({ render: () => '<span>Conta: ana</span>' }));

function items(onLeave = vi.fn()): MenuItem[] {
	return [
		{ id: 'account', label: 'Minha conta', href: '#conta', current: true },
		{ id: 'library', label: 'Minha biblioteca', href: '#biblioteca' },
		{ id: 'busy', label: 'Exportar', disabledReason: 'Espere a gravação terminar.' },
		{ id: 'signout', label: 'Sair', separated: true, onselect: onLeave }
	];
}

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
});

const menuitem = (name: string) => page.getByRole('menuitem', { name, exact: true });

test('trigger and menu roles and aria', async () => {
	await render(Menu, { items: items(), trigger, class: 'btn btn--plate btn--sm' });
	const button = page.getByRole('button', { name: 'Conta: ana' });
	await expect.element(button).toHaveAttribute('aria-haspopup', 'menu');
	await expect.element(button).toHaveAttribute('aria-expanded', 'false');
	const controls = button.element().getAttribute('aria-controls');
	expect(controls).toBeTruthy();
	expect(page.getByRole('menu').elements()).toHaveLength(0);

	await button.click();
	await expect.element(button).toHaveAttribute('aria-expanded', 'true');
	const menu = page.getByRole('menu', { name: 'Conta: ana' });
	await expect.element(menu).toBeVisible();
	expect(menu.element().id).toBe(controls);
	expect(page.getByRole('menuitem').elements()).toHaveLength(4);
	await expect.element(menuitem('Minha conta')).toHaveAttribute('aria-current', 'page');
	await expect.element(menuitem('Minha conta')).toHaveFocus();
	for (const element of page.getByRole('menuitem').elements()) {
		expect(element.getAttribute('tabindex')).toBe('-1');
	}
});

test('keyboard: Enter opens on the first item, arrows wrap, Home/End, Escape returns focus', async () => {
	await render(Menu, { items: items(), trigger });
	const button = page.getByRole('button', { name: 'Conta: ana' });
	await userEvent.tab();
	await expect.element(button).toHaveFocus();
	await userEvent.keyboard('{Enter}');
	await expect.element(menuitem('Minha conta')).toHaveFocus();
	await userEvent.keyboard('{ArrowDown}');
	await expect.element(menuitem('Minha biblioteca')).toHaveFocus();
	await userEvent.keyboard('{ArrowDown}');
	// Unavailable items stay reachable (they explain themselves).
	await expect.element(page.getByRole('menuitem', { name: 'Exportar' })).toHaveFocus();
	await userEvent.keyboard('{End}');
	await expect.element(menuitem('Sair')).toHaveFocus();
	await userEvent.keyboard('{ArrowDown}');
	await expect.element(menuitem('Minha conta')).toHaveFocus();
	await userEvent.keyboard('{ArrowUp}');
	await expect.element(menuitem('Sair')).toHaveFocus();
	await userEvent.keyboard('{Home}');
	await expect.element(menuitem('Minha conta')).toHaveFocus();
	await userEvent.keyboard('{Escape}');
	await expect.element(button).toHaveAttribute('aria-expanded', 'false');
	await expect.element(button).toHaveFocus();
});

test('keyboard: Space and ArrowDown open on the first item, ArrowUp on the last', async () => {
	await render(Menu, { items: items(), trigger });
	const button = page.getByRole('button', { name: 'Conta: ana' });
	await userEvent.tab();
	await userEvent.keyboard(' ');
	await expect.element(menuitem('Minha conta')).toHaveFocus();
	await userEvent.keyboard('{Escape}');
	await userEvent.keyboard('{ArrowDown}');
	await expect.element(menuitem('Minha conta')).toHaveFocus();
	await userEvent.keyboard('{Escape}');
	await expect.element(button).toHaveFocus();
	await userEvent.keyboard('{ArrowUp}');
	await expect.element(menuitem('Sair')).toHaveFocus();
});

test('Tab closes the menu and lets focus move on', async () => {
	await render(Menu, { items: items(), trigger });
	const button = page.getByRole('button', { name: 'Conta: ana' });
	await button.click();
	await expect.element(menuitem('Minha conta')).toHaveFocus();
	await userEvent.tab();
	await expect.element(button).toHaveAttribute('aria-expanded', 'false');
	expect(page.getByRole('menu').elements()).toHaveLength(0);
});

test('a click outside closes it; a click on the trigger toggles it', async () => {
	await render(Menu, { items: items(), trigger });
	const button = page.getByRole('button', { name: 'Conta: ana' });
	await button.click();
	await expect.element(button).toHaveAttribute('aria-expanded', 'true');
	document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
	await expect.element(button).toHaveAttribute('aria-expanded', 'false');
	await button.click();
	await expect.element(button).toHaveAttribute('aria-expanded', 'true');
	await button.click();
	await expect.element(button).toHaveAttribute('aria-expanded', 'false');
});

test('actions run on Enter and give focus back; unavailable items say why and never run', async () => {
	const onLeave = vi.fn();
	await render(Menu, { items: items(onLeave), trigger });
	const button = page.getByRole('button', { name: 'Conta: ana' });
	await button.click();
	const busy = page.getByRole('menuitem', { name: 'Exportar' });
	await expect.element(busy).toHaveAttribute('aria-disabled', 'true');
	await expect.element(busy).toHaveAccessibleDescription('Espere a gravação terminar.');
	(busy.element() as HTMLElement).click();
	await expect.element(button).toHaveAttribute('aria-expanded', 'true');
	await userEvent.keyboard('{End}');
	await userEvent.keyboard('{Enter}');
	expect(onLeave).toHaveBeenCalledOnce();
	await expect.element(button).toHaveAttribute('aria-expanded', 'false');
	await expect.element(button).toHaveFocus();
});

test('the popup is fixed below the trigger, inside the viewport, and follows scrolling', async () => {
	await render(Menu, { items: items(), trigger, align: 'end' });
	const button = page.getByRole('button', { name: 'Conta: ana' });
	await button.click();
	const popup = page.getByRole('menu').element().parentElement;
	if (!(popup instanceof HTMLElement)) throw new Error('Missing popup');
	expect(getComputedStyle(popup).position).toBe('fixed');
	const triggerRect = button.element().getBoundingClientRect();
	const rect = popup.getBoundingClientRect();
	expect(rect.top).toBeGreaterThanOrEqual(triggerRect.bottom);
	expect(rect.left).toBeGreaterThanOrEqual(0);
	expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
	// A scroll anywhere (capture) re-places it from the trigger's new rect.
	button.element().style.marginTop = '40px';
	window.dispatchEvent(new Event('scroll'));
	const moved = button.element().getBoundingClientRect();
	await expect
		.poll(() => Math.round(popup.getBoundingClientRect().top))
		.toBe(Math.round(moved.bottom + 6));
});
