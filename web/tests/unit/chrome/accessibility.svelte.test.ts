import axe from 'axe-core';
import { afterEach, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { createToastStore } from '#lib/components/chrome/toast.ts';
import ChromeFixture from './ChromeFixture.svelte';

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

async function expectAccessible(container: HTMLElement) {
	const { violations } = await axe.run(container);
	const blocking = violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
	expect(blocking).toEqual([]);
}

for (const copy of [
	{ locale: 'pt-BR', help: 'Ajuda e atalhos de teclado' },
	{ locale: 'en-US', help: 'Help and keyboard shortcuts' }
] as const) {
	test(`chrome, help, confirmation and toasts have no serious/critical axe violations in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		const store = createToastStore();
		const screen = await render(ChromeFixture, { store });
		store.push('Saved locally', { duration: 0 });
		await tick();
		await expectAccessible(screen.container);
		await page.getByRole('button', { name: copy.help }).click();
		await expectAccessible(screen.container);
		await userEvent.keyboard('{Escape}');
		await page.getByRole('button', { name: 'Open confirmation' }).click();
		await expectAccessible(screen.container);
	}, 15000);
}
