import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import ProtocolWidgets from '#lib/components/pages/docs/ProtocolWidgets.svelte';
import SearchDialog from '#lib/components/pages/docs/SearchDialog.svelte';
import { docsContent } from '#lib/content/docs/index.ts';
import { docsUi } from '#lib/components/pages/docs/ui.ts';
import { q23Example } from '#lib/components/pages/docs/model.ts';
import { setLocale } from '#lib/paraglide/runtime.js';

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`protocol inputs reject invalid Q23, recover and recompute CRC/alias in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const ui = docsUi();
		const screen = await render(ProtocolWidgets, { ui, content: docsContent(locale) });
		const preamp = page.getByRole('textbox', { name: ui.preamp, exact: true });
		for (const invalid of ['', 'not a number', '1', 'Infinity']) {
			await preamp.fill(invalid);
			await expect.element(preamp).toHaveAttribute('aria-invalid', 'true');
			await expect.element(page.getByText(ui.preampInvalid, { exact: true })).toBeVisible();
			expect(screen.container.textContent).toContain('·· ·· ·· ··');
		}
		await preamp.fill('−6,5');
		await expect.element(preamp).toHaveAttribute('aria-invalid', 'false');
		expect(screen.container.textContent).toContain(q23Example('−6,5')?.bytes);
		const crc = page.getByRole('textbox', { name: ui.crcInput, exact: true });
		await crc.fill('');
		expect(screen.container.textContent).toContain('0xFFFF');
		await crc.fill('123456789');
		expect(screen.container.textContent).toContain('0x29B1');
		const slider = page.getByRole('slider', { name: ui.frequency });
		const input = slider.element();
		if (!(input instanceof HTMLInputElement)) throw new Error('Missing sampling slider');
		input.value = '90';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await tick();
		expect(screen.container.textContent).toContain(`90 kHz → ${ui.alias} 6 kHz`);
		await page.getByText(ui.reports, { exact: true }).click();
		const reports = page.getByRole('region', { name: ui.reports });
		await expect.element(reports).toBeVisible();
		// Read the preformatted text directly so its report boundaries remain significant.
		const lines = reports.element().textContent?.trim().split('\n');
		expect(lines).toHaveLength(9);
		expect(lines?.[0]).toMatch(/^0: 00 45 51 31 23/);
	});

	test(`search dialog ignores unrelated keys, closes on Escape and navigates locally in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const ui = docsUi();
		const onNavigate = vi.fn();
		const screen = await render(SearchDialog, {
			content: docsContent(locale),
			ui,
			open: true,
			returnFocus: () => null,
			onNavigate
		});
		const search = page.getByRole('searchbox', { name: ui.searchInput });
		await search.fill('CRC');
		const event = new KeyboardEvent('keydown', {
			key: 'ArrowDown',
			bubbles: true,
			cancelable: true
		});
		search.element().dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		const address = location.href;
		await page.getByRole('dialog').getByRole('link').first().click();
		expect(onNavigate).toHaveBeenCalledOnce();
		expect(location.href).toBe(address);
		await screen.rerender({ open: true });
		await expect.element(search).toBeVisible();
		search
			.element()
			.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
			);
		await tick();
		expect(screen.container.querySelector('dialog[open]')).toBeNull();
	});
}
