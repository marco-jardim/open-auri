import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import { getLocale, overwriteSetLocale, setLocale } from '#lib/paraglide/runtime.js';
import { DEFAULT_GITHUB_URL } from '#lib/components/chrome/Footer.svelte';
import {
	CableBar,
	EmBreve,
	Footer,
	LANG_BOOT_ATTRIBUTE,
	LanguageToggle,
	Nav,
	revealLocale
} from '#lib/components/chrome/index.ts';

const locales = [
	{
		locale: 'pt-BR',
		curve: 'Curva',
		write: 'Gravar no cabo',
		legal: 'Aviso legal completo',
		github: 'Código-fonte no GitHub',
		license: 'Licença AGPL-3.0',
		notice:
			'open-auri não é oficial nem endossado pela Kuba, pela TTGK, pela Savitech ou por qualquer fabricante. Tudo aqui foi obtido por estudo do protocolo para fins de interoperabilidade. Use por sua conta e risco: não nos responsabilizamos por danos ao cabo, ao fone ou à sua audição.',
		soon: 'Liberado assim que o fone chegar à bancada de testes. Até lá não gravamos nada que a página original da Kuba não grave.'
	},
	{
		locale: 'en-US',
		curve: 'Curve',
		write: 'Write to cable',
		legal: 'Full legal notice',
		github: 'Source code on GitHub',
		license: 'AGPL-3.0 license',
		notice:
			'open-auri is not official or endorsed by Kuba, TTGK, Savitech or any manufacturer. Everything here was obtained by studying the protocol for interoperability purposes. Use at your own risk: we are not responsible for damage to the cable, headphones or your hearing.',
		soon: 'Available as soon as the headphones reach the test bench. Until then, we do not write anything that Kuba’s original page does not write.'
	}
] as const;

const honoree = {
	name: 'Robert Moog',
	years: '1934–2005',
	curiosity: 'A transistor ladder filter patent was filed in 1966.',
	sources: [{ label: 'US 3.475.623', href: 'https://patents.google.com/patent/US3475623A/en' }]
};

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
	await page.viewport(1440, 900);
});

for (const copy of locales) {
	test(`renders the chrome and literal notices in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		await render(CableBar);
		await render(Footer, { honoree });
		await render(EmBreve);
		await expect.element(page.getByRole('link', { name: copy.curve, exact: true })).toBeVisible();
		await expect.element(page.getByRole('button', { name: copy.write })).toBeDisabled();
		await expect.element(page.getByText(copy.notice, { exact: true })).toBeVisible();
		await expect.element(page.getByText(copy.soon, { exact: true })).toBeVisible();
		await expect.element(page.getByRole('heading', { name: honoree.name })).toBeVisible();
	});

	test(`keeps the GitHub link immediately below the legal link in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		await render(Footer, { honoree });
		const legal = page.getByRole('link', { name: copy.legal }).element();
		const github = page.getByRole('link', { name: copy.github }).element();
		expect(legal.getAttribute('href')).toBe('/docs#aviso-legal');
		expect(legal.nextElementSibling).toBe(github);
		expect(github.getAttribute('href')).toBe(
			DEFAULT_GITHUB_URL || 'https://github.com/marco-jardim/open-auri'
		);
		expect(github.nextElementSibling?.textContent).toBe(copy.license);
		expect(getComputedStyle(legal.parentElement!).flexDirection).toBe('column');
		expect(github.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			legal.getBoundingClientRect().bottom
		);
	});
}

test('marks only the current nav item and accepts custom items', async () => {
	const screen = await render(Nav, { currentPath: '/cabo/?section=status' });
	expect(screen.container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
	await expect
		.element(page.getByRole('link', { name: 'Cabo', exact: true }))
		.toHaveAttribute('aria-current', 'page');
	await screen.rerender({ currentPath: '/custom', items: [{ href: '/custom', label: 'Custom' }] });
	await expect
		.element(page.getByRole('link', { name: 'Custom' }))
		.toHaveAttribute('aria-current', 'page');
	expect(page.getByRole('link').elements()).toHaveLength(1);
});

test('only invokes cable/audio callbacks on explicit clicks and honors writeDisabled', async () => {
	const onNeutro = vi.fn();
	const onPadraoAuri = vi.fn();
	const onWrite = vi.fn();
	const onAudio = vi.fn();
	const screen = await render(CableBar, {
		unsaved: true,
		onNeutro,
		onPadraoAuri,
		onWrite,
		onAudio,
		writeDisabled: true
	});
	expect(onWrite).not.toHaveBeenCalled();
	await expect
		.element(page.getByText('Alterações não gravadas no cabo', { exact: true }))
		.toBeVisible();
	await expect.element(page.getByRole('button', { name: 'Gravar no cabo' })).toBeDisabled();
	await page.getByRole('button', { name: 'Neutro' }).click();
	await page.getByRole('button', { name: 'Padrão Auri' }).click();
	await page.getByRole('button', { name: 'Áudio' }).click();
	expect(onNeutro).toHaveBeenCalledExactlyOnceWith();
	expect(onPadraoAuri).toHaveBeenCalledExactlyOnceWith();
	expect(onAudio).toHaveBeenCalledExactlyOnceWith();
	expect(onWrite).not.toHaveBeenCalled();
	await screen.rerender({ writeDisabled: false });
	await page.getByRole('button', { name: 'Gravar no cabo' }).click();
	expect(onWrite).toHaveBeenCalledExactlyOnceWith();
	expect(getComputedStyle(page.getByRole('banner').element()).position).toBe('fixed');
	expect(page.getByRole('banner').element().getBoundingClientRect().height).toBe(56);
});

test('renders the unsaved indicator as a boolean, never as a count', async () => {
	const screen = await render(CableBar);
	const indicator = screen.container.querySelector('.dirty');
	if (!(indicator instanceof HTMLElement)) throw new Error('Missing unsaved indicator');
	expect(indicator.textContent?.trim()).toBe('');
	expect(indicator.classList.contains('has')).toBe(false);
	await screen.rerender({ unsaved: true });
	await expect.element(indicator).toHaveTextContent('Alterações não gravadas no cabo');
	expect(indicator.classList.contains('has')).toBe(true);
	expect(indicator.textContent).not.toMatch(/\d/);
	await setLocale('en-US', { reload: false });
	await cleanup();
	await render(CableBar, { unsaved: true });
	await expect
		.element(page.getByText('Unsaved changes on the cable', { exact: true }))
		.toBeVisible();
});

test('renders navigation, status, unsaved, audio and actions snippets instead of fallbacks', async () => {
	const snippet = (html: string) => createRawSnippet(() => ({ render: () => html }));
	await render(CableBar, {
		navigation: snippet('<nav aria-label="Custom navigation"><a href="/docs">Manual</a></nav>'),
		status: snippet('<span>USB DSP Audio</span>'),
		unsavedIndicator: snippet('<span>Local draft</span>'),
		audio: snippet('<button type="button">Preview audio</button>'),
		actions: snippet('<button type="button">Custom action</button>')
	});
	await expect.element(page.getByRole('navigation', { name: 'Custom navigation' })).toBeVisible();
	await expect.element(page.getByRole('status')).toHaveTextContent('USB DSP Audio');
	await expect.element(page.getByText('Local draft')).toBeVisible();
	await expect.element(page.getByRole('button', { name: 'Preview audio' })).toBeVisible();
	await expect.element(page.getByRole('button', { name: 'Custom action' })).toBeVisible();
	expect(page.getByRole('button', { name: 'Gravar no cabo' }).elements()).toHaveLength(0);
});

test('switches locale through Paraglide and lets its runtime persist both preferences', async () => {
	const original = setLocale;
	const switchLocale = vi.fn((locale: 'pt-BR' | 'en-US') => original(locale, { reload: false }));
	overwriteSetLocale(switchLocale);
	try {
		await render(LanguageToggle);
		await page.getByRole('button', { name: 'Switch to English' }).click();
		expect(switchLocale).toHaveBeenLastCalledWith('en-US');
		expect(getLocale()).toBe('en-US');
		expect(localStorage.getItem('oa.lang')).toBe('en-US');
		expect(document.cookie).toContain('oa_lang=en-US');
		await page.getByRole('button', { name: 'Mudar para português' }).click();
		expect(switchLocale).toHaveBeenLastCalledWith('pt-BR');
		expect(getLocale()).toBe('pt-BR');
	} finally {
		overwriteSetLocale(original);
	}
});

test('revealLocale syncs lang/dir and clears the lang-boot hide only when it was set', () => {
	const root = document.createElement('div');
	revealLocale(root, 'pt-BR', 'ltr');
	expect(root.lang).toBe('pt-BR');
	expect(root.dir).toBe('ltr');
	expect(root.getAttribute('style')).toBeNull();
	root.setAttribute(LANG_BOOT_ATTRIBUTE, 'en-US');
	root.style.visibility = 'hidden';
	revealLocale(root, 'en-US', 'ltr');
	expect(root.lang).toBe('en-US');
	expect(root.hasAttribute(LANG_BOOT_ATTRIBUTE)).toBe(false);
	expect(root.style.visibility).toBe('');
});

test('keeps PT · EN on a single mobile line', async () => {
	await page.viewport(390, 844);
	await render(CableBar);
	const button = page.getByRole('button', { name: 'Switch to English' }).element();
	const spans = [...button.querySelectorAll('span')];
	expect(getComputedStyle(button).whiteSpace).toBe('nowrap');
	expect(getComputedStyle(button).flexWrap).toBe('nowrap');
	expect(new Set(spans.map((span) => span.getBoundingClientRect().top)).size).toBe(1);
});
