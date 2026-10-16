import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createRawSnippet, tick } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { ConfirmDialog, createToastStore, HelpOverlay } from '#lib/components/chrome/index.ts';
import ChromeFixture from './ChromeFixture.svelte';

const locales = [
	{
		locale: 'pt-BR',
		help: 'Atalhos de teclado',
		close: 'Fechar',
		cancel: 'Cancelar',
		confirm: 'Confirmar'
	},
	{
		locale: 'en-US',
		help: 'Keyboard shortcuts',
		close: 'Close',
		cancel: 'Cancel',
		confirm: 'Confirm'
	}
] as const;

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

for (const copy of locales) {
	test(`? opens help, Tab stays inside, and Escape restores focus in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		const onOpenChange = vi.fn();
		await render(HelpOverlay, {
			shortcuts: [{ keys: 'Space', description: 'Preview playback' }],
			onOpenChange
		});
		const trigger = page.getByRole('button');
		trigger.element().focus();
		await userEvent.keyboard('?');
		await expect.element(page.getByRole('dialog', { name: copy.help })).toBeVisible();
		await expect.element(page.getByText('Space', { exact: true })).toBeVisible();
		await expect.element(page.getByText('Preview playback')).toBeVisible();
		const close = page.getByRole('button', { name: copy.close });
		await expect.element(close).toHaveFocus();
		await userEvent.tab();
		await expect.element(close).toHaveFocus();
		await userEvent.tab({ shift: true });
		await expect.element(close).toHaveFocus();
		await userEvent.keyboard('{Escape}');
		await expect.element(page.getByRole('dialog', { name: copy.help })).not.toBeInTheDocument();
		await expect.element(trigger).toHaveFocus();
		expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
		await trigger.click();
		await page.getByRole('button', { name: copy.close }).click();
		expect(onOpenChange.mock.calls).toEqual([[true], [false], [true], [false]]);
	});

	test(`confirmation traps focus, Escape cancels once, and confirm reports true in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		const onResult = vi.fn();
		await render(ChromeFixture, { store: createToastStore(), onResult });
		const opener = page.getByRole('button', { name: 'Open confirmation' });
		await opener.click();
		const dialog = page.getByRole('dialog', { name: 'Confirm action' });
		await expect.element(dialog).toBeVisible();
		const cancel = dialog.getByRole('button', { name: copy.cancel });
		const confirm = dialog.getByRole('button', { name: copy.confirm });
		await expect.element(cancel).toHaveFocus();
		await userEvent.tab({ shift: true });
		await expect.element(confirm).toHaveFocus();
		await userEvent.tab();
		await expect.element(cancel).toHaveFocus();
		await userEvent.tab();
		await expect.element(confirm).toHaveFocus();
		await userEvent.keyboard('{Escape}');
		await expect.element(dialog).not.toBeInTheDocument();
		await expect.element(opener).toHaveFocus();
		expect(onResult).toHaveBeenCalledExactlyOnceWith(false);
		await opener.click();
		await dialog.getByRole('button', { name: copy.confirm }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		expect(onResult.mock.calls).toEqual([[false], [true]]);
	});
}

test('does not open help when typing ?, using modifiers, composing, or another modal is open', async () => {
	await render(ChromeFixture, { store: createToastStore() });
	const input = page.getByRole('textbox', { name: 'Curve name' });
	await input.click();
	await userEvent.keyboard('?');
	await expect.element(input).toHaveValue('?');
	expect(page.getByRole('dialog').elements()).toHaveLength(0);
	input.element().blur();
	for (const options of [
		{ ctrlKey: true },
		{ metaKey: true },
		{ altKey: true },
		{ isComposing: true }
	]) {
		window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', ...options }));
	}
	const prevented = new KeyboardEvent('keydown', { key: '?', cancelable: true });
	prevented.preventDefault();
	window.dispatchEvent(prevented);
	await tick();
	expect(page.getByRole('dialog').elements()).toHaveLength(0);
	await page.getByRole('button', { name: 'Open confirmation' }).click();
	await userEvent.keyboard('?');
	expect(page.getByRole('dialog').elements()).toHaveLength(1);
	await expect.element(page.getByRole('dialog', { name: 'Confirm action' })).toBeVisible();
});

test('ignores ? in contenteditable fields and when the keyboard shortcut is disabled', async () => {
	const screen = await render(HelpOverlay, { shortcuts: [], enabled: false });
	await userEvent.keyboard('?');
	expect(page.getByRole('dialog').elements()).toHaveLength(0);
	await screen.rerender({ enabled: true });
	const editor = document.createElement('div');
	editor.contentEditable = 'true';
	editor.textContent = 'Editable';
	screen.container.append(editor);
	editor.focus();
	editor.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
	await tick();
	expect(page.getByRole('dialog').elements()).toHaveLength(0);
});

test('supports confirmation content, disabled confirmation, custom labels and cancellation', async () => {
	const onResult = vi.fn();
	const screen = await render(ConfirmDialog, {
		open: true,
		title: 'Experimental filters',
		description: 'Review the coefficients.',
		confirmLabel: 'Continue',
		cancelLabel: 'Go back',
		confirmDisabled: true,
		children: createRawSnippet(() => ({ render: () => '<p>Coefficient details</p>' })),
		onResult
	});
	await expect.element(page.getByRole('dialog', { name: 'Experimental filters' })).toBeVisible();
	await expect.element(page.getByText('Coefficient details')).toBeVisible();
	await expect.element(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
	await expect.element(page.getByRole('button', { name: 'Go back' })).toHaveFocus();
	expect(onResult).not.toHaveBeenCalled();
	await screen.rerender({ confirmDisabled: false });
	await page.getByRole('button', { name: 'Continue' }).click();
	expect(onResult).toHaveBeenCalledExactlyOnceWith(true);
	await screen.rerender({ open: true });
	await page.getByRole('button', { name: 'Go back' }).click();
	expect(onResult.mock.calls).toEqual([[true], [false]]);
});
