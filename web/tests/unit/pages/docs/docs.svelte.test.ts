import axe from 'axe-core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { docsContent } from '#lib/content/docs/index.ts';
import { legalContent } from '#lib/content/docs/legal-content.ts';
import type { PublicLegalValues } from '#lib/content/docs/legal.ts';
import DocsPage from '#lib/components/pages/docs/DocsPage.svelte';
import LegalPage from '#lib/components/pages/docs/LegalPage.svelte';
import { thresholdRows } from '#lib/components/pages/docs/model.ts';
import { docsUi } from '#lib/components/pages/docs/ui.ts';

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

const values: PublicLegalValues = {
	PUBLIC_ORIGIN: 'https://example.invalid',
	PUBLIC_LGPD_CONTROLLER: 'TEST_CONTROLLER',
	PUBLIC_LGPD_CONTACT_EMAIL: 'privacy@example.invalid',
	PUBLIC_LGPD_CNPJ: 'TEST_REGISTRATION',
	PUBLIC_LGPD_ADDRESS: 'TEST_ADDRESS',
	PUBLIC_LGPD_DPO_NAME: 'TEST_DPO',
	PUBLIC_POLICY_EFFECTIVE_DATE: '2026-10-15'
};

async function expectAccessible(container: HTMLElement) {
	const { violations } = await axe.run(container);
	expect(violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')).toEqual(
		[]
	);
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`Docs renders exact limits, legal anchor and local Ctrl+K search accessibly in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const content = docsContent(locale);
		const ui = docsUi();
		const screen = await render(DocsPage, {
			content,
			ui,
			githubUrl: 'https://example.invalid/repository'
		});
		expect(screen.container.querySelector('#aviso-legal')?.textContent).toContain(
			content.sections.find((section) => section.id === 'aviso-legal')!.paragraphs[0]
		);
		for (const row of thresholdRows(content))
			expect(screen.container.querySelector(`[data-threshold="${row.id}"] td`)?.textContent).toBe(
				row.value
			);
		await expectAccessible(screen.container);
		const opener = page.getByRole('button', { name: ui.search });
		await expect.element(opener).toHaveAccessibleName(ui.search);
		opener.element().focus();
		expect(document.activeElement).toBe(opener.element());
		const shortcut = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
		window.dispatchEvent(shortcut);
		await tick();
		expect(shortcut.defaultPrevented).toBe(true);
		const dialog = page.getByRole('dialog', { name: ui.search });
		await expect.element(dialog).toBeVisible();
		await expect.element(page.getByRole('searchbox', { name: ui.searchInput })).toHaveFocus();
		await page.getByRole('searchbox', { name: ui.searchInput }).fill('CRC');
		await expect
			.element(
				dialog.getByRole('link', {
					name: new RegExp(content.sections.find((section) => section.id === 'protocolo')!.title)
				})
			)
			.toBeVisible();
		await expectAccessible(screen.container);
		await userEvent.keyboard('{Escape}');
		await expect.element(opener).toHaveFocus();
		await opener.click();
		await page.getByRole('searchbox', { name: ui.searchInput }).fill('zzzznotfound');
		await expect.element(page.getByText(ui.noResults)).toBeVisible();
	}, 30000);

	test(`search returns focus to its origin, with opener fallback, in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const ui = docsUi();
		const screen = await render(DocsPage, {
			content: docsContent(locale),
			ui,
			githubUrl: 'https://example.invalid/repository'
		});
		const opener = page.getByRole('button', { name: ui.search });
		const dialog = page.getByRole('dialog', { name: ui.search });
		const searchbox = page.getByRole('searchbox', { name: ui.searchInput });
		const shortcut = () => {
			const event = new KeyboardEvent('keydown', {
				key: 'k',
				ctrlKey: true,
				cancelable: true
			});
			window.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
		};

		// Click opening uses the focused opener, without relying on OS/page focus.
		opener.element().focus();
		expect(document.activeElement).toBe(opener.element());
		await opener.click();
		await expect.element(searchbox).toHaveFocus();
		await dialog.getByRole('button', { name: ui.close }).click();
		await expect.element(opener).toHaveFocus();

		// Ctrl+K from another control must return there, not unconditionally to the button.
		const origin = page.getByRole('combobox', { name: ui.preset });
		origin.element().focus();
		expect(document.activeElement).toBe(origin.element());
		shortcut();
		await expect.element(searchbox).toHaveFocus();
		await searchbox.fill('CRC');
		await userEvent.keyboard('{Escape}');
		await expect.element(origin).toHaveFocus();

		// Body is not a useful return target; the opener is the documented fallback.
		origin.element().blur();
		expect(document.activeElement).toBe(document.body);
		shortcut();
		await expect.element(searchbox).toHaveFocus();
		await userEvent.keyboard('{Escape}');
		await expect.element(opener).toHaveFocus();

		// An origin removed while the dialog is open must also fall back to the opener.
		const removed = document.createElement('button');
		removed.textContent = 'Temporary focus origin';
		screen.container.append(removed);
		removed.focus();
		expect(document.activeElement).toBe(removed);
		shortcut();
		await expect.element(searchbox).toHaveFocus();
		removed.remove();
		await userEvent.keyboard('{Escape}');
		await expect.element(opener).toHaveFocus();
		expect(screen.container.querySelector('dialog[open]')).toBeNull();
	}, 30000);

	test(`privacy and terms fill props without HTML injection and pass axe in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		for (const kind of ['privacy', 'terms'] as const) {
			const screen = await render(LegalPage, {
				document: legalContent(kind, locale),
				values: { ...values, PUBLIC_LGPD_CONTROLLER: '<img src=x onerror=alert(1)>' },
				ui: docsUi()
			});
			expect(screen.container.textContent).toContain('<img src=x onerror=alert(1)>');
			expect(screen.container.querySelector('img')).toBeNull();
			expect(screen.container.textContent).not.toContain('{{PUBLIC_');
			expect(screen.container.textContent).toContain(values.PUBLIC_LGPD_CONTACT_EMAIL);
			await expectAccessible(screen.container);
			await cleanup();
		}
	}, 30000);
}

test('TOC follows scrolling and direct navigation without writing to a cable', async () => {
	await setLocale('pt-BR', { reload: false });
	const url = window.location.href;
	const content = docsContent('pt-BR');
	const screen = await render(DocsPage, {
		content,
		ui: docsUi(),
		githubUrl: 'https://example.invalid/repository'
	});
	const section = screen.container.querySelector<HTMLElement>('#protocolo')!;
	section.scrollIntoView({ block: 'start', behavior: 'instant' });
	window.dispatchEvent(new Event('scroll'));
	await vi.waitFor(() =>
		expect(screen.container.querySelector('a[aria-current="location"]')?.getAttribute('href')).toBe(
			'#protocolo'
		)
	);
	const toc = page.getByRole('navigation', { name: docsUi().contents });
	await toc.getByRole('link', { name: '12 Aviso legal', exact: true }).click();
	await vi.waitFor(() =>
		expect(screen.container.querySelector('a[aria-current="location"]')?.getAttribute('href')).toBe(
			'#aviso-legal'
		)
	);
	expect(document.activeElement).toBe(screen.container.querySelector('#aviso-legal'));
	expect(window.location.href).toBe(url);

	const opener = page.getByRole('button', { name: docsUi().search });
	await opener.click();
	const dialog = page.getByRole('dialog', { name: docsUi().search });
	await page.getByRole('searchbox', { name: docsUi().searchInput }).fill('Protocolo 0xCB');
	await dialog.getByRole('link', { name: /^Protocolo 0xCB/ }).click();
	await vi.waitFor(() =>
		expect(screen.container.querySelector('a[aria-current="location"]')?.getAttribute('href')).toBe(
			'#protocolo'
		)
	);
	expect(document.activeElement).toBe(section);
	expect(window.location.href).toBe(url);
});

test('overflowing named regions remain keyboard accessible without pretending to be controls', async () => {
	await setLocale('pt-BR', { reload: false });
	const screen = await render(DocsPage, {
		content: docsContent('pt-BR'),
		ui: docsUi(),
		githubUrl: 'https://example.invalid/repository'
	});
	const tape = screen.container.querySelector<HTMLElement>('.tape')!;
	expect(tape.getAttribute('role')).toBe('region');
	expect(tape.tabIndex).toBe(0);
	tape.focus();
	await expect.element(tape).toHaveFocus();

	const polar = screen.container.querySelector<HTMLElement>('.polar-scroll')!;
	polar.style.width = '300px';
	await vi.waitFor(() => expect(polar.tabIndex).toBe(0));
	polar.focus();
	await expect.element(polar).toHaveFocus();
	polar.style.width = '600px';
	await vi.waitFor(() => expect(polar.tabIndex).toBe(-1));
	await expectAccessible(screen.container);
}, 30000);

test('erase flow cancels without accessing storage, confirms once, and preserves unrelated data', async () => {
	const url = window.location.href;
	const ui = docsUi();
	const factory = new IDBFactory();
	const localData = new Map([
		['oa.current', 'curve'],
		['other.app', 'keep']
	]);
	const sessionData = new Map([['oa.flash.session', '2']]);
	const area = (data: Map<string, string>) => ({
		get length() {
			return data.size;
		},
		key: (index: number) => [...data.keys()][index] ?? null,
		removeItem: (key: string) => {
			data.delete(key);
		}
	});
	const getBackends = vi.fn(() => ({
		local: area(localData),
		session: area(sessionData),
		indexedDB: factory
	}));
	const prepareClear = vi.fn();
	const onCleared = vi.fn();
	const screen = await render(DocsPage, {
		content: docsContent('pt-BR'),
		ui,
		githubUrl: 'https://example.invalid/repository',
		getBackends,
		prepareClear,
		onCleared
	});
	const opener = page.getByRole('button', { name: ui.clear, exact: true });
	await opener.click();
	let dialog = page.getByRole('dialog', { name: ui.clearTitle });
	await expectAccessible(screen.container);
	await dialog.getByRole('button', { name: ui.cancel }).click();
	expect(getBackends).not.toHaveBeenCalled();
	expect(prepareClear).not.toHaveBeenCalled();
	await opener.click();
	dialog = page.getByRole('dialog', { name: ui.clearTitle });
	await dialog.getByRole('button', { name: ui.clear }).click();
	await vi.waitFor(() => expect(onCleared).toHaveBeenCalledOnce());
	expect(prepareClear).toHaveBeenCalledOnce();
	expect([...localData.entries()]).toEqual([['other.app', 'keep']]);
	expect(sessionData.size).toBe(0);
	await expect.element(page.getByText(ui.cleared)).toBeVisible();
	expect(window.location.href).toBe(url);
}, 30000);

test('erase failure is visible and writing state disables the destructive action', async () => {
	const ui = docsUi();
	const onCleared = vi.fn();
	const screen = await render(DocsPage, {
		content: docsContent('pt-BR'),
		ui,
		githubUrl: 'https://example.invalid/repository',
		getBackends: () => {
			throw new Error('Storage unavailable');
		},
		onCleared
	});
	await page.getByRole('button', { name: ui.clear, exact: true }).click();
	await page
		.getByRole('dialog', { name: ui.clearTitle })
		.getByRole('button', { name: ui.clear })
		.click();
	await expect.element(page.getByText(ui.clearError)).toBeVisible();
	expect(onCleared).not.toHaveBeenCalled();
	await screen.rerender({ clearDisabled: true });
	await expect.element(page.getByRole('button', { name: ui.clear, exact: true })).toBeDisabled();
});
