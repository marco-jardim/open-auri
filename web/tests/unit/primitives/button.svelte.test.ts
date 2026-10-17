// Button and IconButton (FUX.1, spec §2.6): variants, sizes, disabled WITH a reason (T8),
// loading state, never mono (T4).
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { Button, IconButton } from '#lib/components/primitives/index.ts';
import './design-system.ts';

const label = (text: string) => createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
});

test('renders the recipe classes, a real button and acts on click', async () => {
	const onclick = vi.fn();
	await render(Button, { variant: 'primary', size: 'lg', onclick, children: label('Gravar') });
	const button = page.getByRole('button', { name: 'Gravar' });
	const element = button.element();
	expect(element.tagName).toBe('BUTTON');
	expect(element.getAttribute('type')).toBe('button');
	expect([...element.classList]).toEqual(
		expect.arrayContaining(['btn', 'btn--primary', 'btn--lg'])
	);
	expect(element.getBoundingClientRect().height).toBe(44);
	expect(getComputedStyle(element).fontFamily).not.toMatch(/JetBrains Mono/);
	expect(Number(getComputedStyle(element).fontWeight)).toBeLessThanOrEqual(600);
	await button.click();
	expect(onclick).toHaveBeenCalledOnce();
});

test.each([
	['sm', 28],
	['md', 36],
	['lg', 44]
] as const)('size %s is %d px tall', async (size, height) => {
	await render(Button, { size, children: label('Neutro') });
	expect(
		page.getByRole('button', { name: 'Neutro' }).element().getBoundingClientRect().height
	).toBe(height);
});

test('disabledReason: aria-disabled, focusable, reason announced and shown, no action (T8)', async () => {
	const onclick = vi.fn();
	await render(Button, {
		disabledReason: 'Carregando o motor do cabo…',
		onclick,
		children: label('Gravar no cabo')
	});
	const button = page.getByRole('button', { name: 'Gravar no cabo' });
	await expect.element(button).toHaveAttribute('aria-disabled', 'true');
	expect(button.element().hasAttribute('disabled')).toBe(false);
	await expect.element(button).toHaveAccessibleDescription('Carregando o motor do cabo…');

	// Keyboard: reachable with Tab, the reason opens at once on focus, Escape closes it.
	await userEvent.tab();
	await expect.element(button).toHaveFocus();
	const tooltip = page.getByRole('tooltip', { includeHidden: true });
	await expect.element(tooltip).toBeVisible();
	await expect.element(tooltip).toHaveTextContent('Carregando o motor do cabo…');
	await userEvent.keyboard('{Enter}');
	expect(onclick).not.toHaveBeenCalled();
	await userEvent.keyboard('{Escape}');
	await expect.element(tooltip).not.toBeVisible();
	await expect.element(button).toHaveFocus();

	// Pointer or touch: a click shows the reason instead of acting.
	(button.element() as HTMLElement).click();
	expect(onclick).not.toHaveBeenCalled();
	await expect.element(tooltip).toBeVisible();
});

test('an empty reason means available', async () => {
	const onclick = vi.fn();
	await render(Button, { disabledReason: '  ', onclick, children: label('Neutro') });
	const button = page.getByRole('button', { name: 'Neutro' });
	await expect.element(button).not.toHaveAttribute('aria-disabled');
	await expect.element(button).not.toHaveAttribute('aria-describedby');
	await button.click();
	expect(onclick).toHaveBeenCalledOnce();
});

test('an unavailable submit button cancels the click, so its form never submits', async () => {
	await render(Button, {
		type: 'submit',
		disabledReason: 'Confirme o volume antes.',
		children: label('Enviar')
	});
	const click = new MouseEvent('click', { bubbles: true, cancelable: true });
	page.getByRole('button', { name: 'Enviar' }).element().dispatchEvent(click);
	// Submitting is the click's default action: cancelled here.
	expect(click.defaultPrevented).toBe(true);
});

test('loading: aria-busy, same width, no action', async () => {
	const onclick = vi.fn();
	const screen = await render(Button, { onclick, children: label('Publicar curva') });
	const button = page.getByRole('button', { name: 'Publicar curva' });
	const before = button.element().getBoundingClientRect().width;
	await screen.rerender({ loading: true });
	await expect.element(button).toHaveAttribute('aria-busy', 'true');
	expect(button.element().getBoundingClientRect().width).toBe(before);
	expect(button.element().querySelector('.btn__spinner')).not.toBeNull();
	(button.element() as HTMLElement).click();
	expect(onclick).not.toHaveBeenCalled();
	await screen.rerender({ loading: false });
	await expect.element(button).not.toHaveAttribute('aria-busy');
	await button.click();
	expect(onclick).toHaveBeenCalledOnce();
});

test('key variant: the LED follows the lit prop', async () => {
	const screen = await render(Button, { variant: 'key', lit: false, children: label('SEL') });
	const led = page.getByRole('button', { name: 'SEL' }).element().querySelector('.btn__led');
	expect(led?.getAttribute('data-on')).toBe('false');
	expect(led?.getAttribute('aria-hidden')).toBe('true');
	await screen.rerender({ lit: true });
	await expect.poll(() => led?.getAttribute('data-on')).toBe('true');
});

test('IconButton: mandatory name, hidden glyph, same reason behaviour', async () => {
	await render(IconButton, {
		label: 'Ajuda e atalhos de teclado',
		disabledReason: 'Indisponível agora.',
		children: createRawSnippet(() => ({ render: () => '<span>?</span>' }))
	});
	const button = page.getByRole('button', { name: 'Ajuda e atalhos de teclado' });
	await expect.element(button).toHaveAttribute('aria-disabled', 'true');
	await expect.element(button).toHaveAccessibleDescription('Indisponível agora.');
	const rect = button.element().getBoundingClientRect();
	expect(rect.width).toBe(rect.height);
	expect(button.element().querySelector('.btn__glyph')?.getAttribute('aria-hidden')).toBe('true');
});
