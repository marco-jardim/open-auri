import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { m } from '#lib/paraglide/messages.js';
import { getLocale, overwriteSetLocale, setLocale } from '#lib/paraglide/runtime.js';
import { withWriteFlag } from '#lib/cable/write-flag.ts';
import { LanguageToggle } from '#lib/components/chrome/index.ts';

const original = setLocale;

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	overwriteSetLocale(original);
	await original('pt-BR', { reload: false });
});

test('the language toggle never switches (and reloads) while a cable write sends bytes', async () => {
	const switchLocale = vi.fn((locale: 'pt-BR' | 'en-US') => original(locale, { reload: false }));
	overwriteSetLocale(switchLocale);
	await render(LanguageToggle);
	const toggle = page.getByRole('button', { name: /Switch to English/ });
	await expect.element(toggle).not.toHaveAttribute('aria-disabled');

	let finish!: () => void;
	const writing = withWriteFlag(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			})
	);
	await expect.element(toggle).toHaveAttribute('aria-disabled', 'true');
	// The reason is announced (aria-describedby) and shown in a tooltip, not only in a title (T8).
	await expect.element(toggle).toHaveAccessibleDescription(m.chrome_language_blocked());
	// aria-disabled keeps it focusable; a click (or Enter) must still do nothing.
	(toggle.element() as HTMLElement).click();
	expect(switchLocale).not.toHaveBeenCalled();
	expect(getLocale()).toBe('pt-BR');
	await expect.element(page.getByRole('tooltip')).toHaveTextContent(m.chrome_language_blocked());

	finish();
	await writing;
	await expect.element(toggle).not.toHaveAttribute('aria-disabled');
	await expect.element(toggle).not.toHaveAttribute('aria-describedby');
	await toggle.click();
	expect(switchLocale).toHaveBeenLastCalledWith('en-US');
	expect(getLocale()).toBe('en-US');
});

test('a write flag set outside the event (PWA contract) still refuses the click', async () => {
	const switchLocale = vi.fn((locale: 'pt-BR' | 'en-US') => original(locale, { reload: false }));
	overwriteSetLocale(switchLocale);
	const scope = globalThis as typeof globalThis & { __oaWriteInProgress?: boolean };
	scope.__oaWriteInProgress = true;
	try {
		await render(LanguageToggle);
		const toggle = page.getByRole('button', { name: /Switch to English/ });
		await expect.element(toggle).toHaveAttribute('aria-disabled', 'true');
		(toggle.element() as HTMLElement).click();
		expect(switchLocale).not.toHaveBeenCalled();
		expect(getLocale()).toBe('pt-BR');
	} finally {
		scope.__oaWriteInProgress = false;
	}
});
