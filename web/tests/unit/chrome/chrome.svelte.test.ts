import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import { m } from '#lib/paraglide/messages.js';
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
// The bar's buttons take their recipe from the design system (components.css), loaded here as
// the root layout loads it in the app.
import '../primitives/design-system.ts';

const locales = [
	{
		locale: 'pt-BR',
		curve: 'Curva',
		write: 'Gravar no cabo',
		writeLoading: 'Carregando o motor do cabo…',
		legal: 'Aviso legal completo',
		github: 'Código-fonte no GitHub',
		license: 'Licença AGPL-3.0',
		stats: 'Estatísticas públicas',
		notice:
			'open-auri não é oficial nem endossado pela Kuba, pela TTGK, pela Savitech ou por qualquer fabricante. Tudo aqui foi obtido por estudo do protocolo para fins de interoperabilidade. Use por sua conta e risco: não nos responsabilizamos por danos ao cabo, ao fone ou à sua audição.',
		sales: 'O cabo Kuba Auri é vendido em kuba.audio.',
		salesLink: 'kuba.audio (abre em nova aba)',
		soon: 'Liberado assim que o fone chegar à bancada de testes. Até lá não gravamos nada que a página original da Kuba não grave.'
	},
	{
		locale: 'en-US',
		curve: 'Curve',
		write: 'Write to cable',
		writeLoading: 'Loading the cable engine…',
		legal: 'Full legal notice',
		github: 'Source code on GitHub',
		license: 'AGPL-3.0 license',
		stats: 'Public statistics',
		notice:
			'open-auri is not official or endorsed by Kuba, TTGK, Savitech or any manufacturer. Everything here was obtained by studying the protocol for interoperability purposes. Use at your own risk: we are not responsible for damage to the cable, headphones or your hearing.',
		sales: 'The Kuba Auri cable is sold at kuba.audio.',
		salesLink: 'kuba.audio (opens in a new tab)',
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
	// FUX.NAV: the bar's layout depends on the width; desktop unless a test says otherwise.
	await page.viewport(1440, 900);
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
		// No app yet: unavailable with a reason, still focusable (T8).
		const write = page.getByRole('button', { name: copy.write });
		await expect.element(write).toHaveAttribute('aria-disabled', 'true');
		await expect.element(write).toHaveAccessibleDescription(copy.writeLoading);
		// The disclaimer stays literal; the sales line is its own sentence right after it.
		const notice = page.getByText(copy.notice, { exact: true });
		await expect.element(notice).toBeVisible();
		const sales = page.getByRole('link', { name: copy.salesLink, exact: true });
		await expect.element(sales).toBeVisible();
		const salesLine = sales.element().closest('p');
		expect(notice.element().nextElementSibling).toBe(salesLine);
		await expect.element(page.getByText(copy.soon, { exact: true })).toBeVisible();
		await expect.element(page.getByRole('heading', { name: honoree.name })).toBeVisible();
	});

	test(`links the Kuba Auri sales page in a new tab, saying so, in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		await render(Footer, { honoree });
		const sales = page.getByRole('link', { name: copy.salesLink, exact: true });
		await expect.element(sales).toHaveAttribute('href', 'https://kuba.audio/products/auri');
		await expect.element(sales).toHaveAttribute('target', '_blank');
		const rel = sales.element().getAttribute('rel')?.split(/\s+/);
		expect(rel).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
		// Visible link text is "kuba.audio"; the ↗ marker is hidden, the new-tab hint is spoken.
		const marker = sales.element().querySelector('[aria-hidden="true"]');
		expect(marker?.textContent?.trim()).toBe('↗');
		// Inside running text the link is told apart without colour (axe link-in-text-block).
		expect(getComputedStyle(sales.element()).textDecorationLine).toBe('underline');
		const line = sales.element().closest('p');
		if (!line) throw new Error('Missing sales line');
		const visible = line.cloneNode(true);
		if (!(visible instanceof HTMLElement)) throw new Error('Unexpected sales line');
		for (const hidden of visible.querySelectorAll('[aria-hidden="true"], .sr-only'))
			hidden.remove();
		expect(visible.textContent?.trim()).toBe(copy.sales);
		expect(visible.querySelector('a')?.textContent).toBe('kuba.audio');
		expect(line.textContent).not.toMatch(/[—?]/);
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

	test(`links the public statistics dashboard in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		await render(Footer, { honoree });
		const stats = page.getByRole('link', { name: copy.stats, exact: true });
		await expect.element(stats).toBeVisible();
		await expect
			.element(stats)
			.toHaveAttribute('href', 'https://dashboard.simpleanalytics.com/open-auri.com');
		await expect.element(stats).toHaveAttribute('target', '_blank');
		expect(stats.element().getAttribute('rel')?.split(/\s+/)).toContain('noopener');
		// External marker, hidden from the accessible name like the other ↗ links.
		const marker = stats.element().querySelector('[aria-hidden="true"]');
		expect(marker?.textContent).toBe('↗');
		// Last in the list: legal → GitHub → license → web and Android license files → stats.
		const license = page.getByText(copy.license, { exact: true }).element();
		const thirdParty = license.nextElementSibling;
		expect(thirdParty?.getAttribute('href')).toBe('/third-party-licenses.txt');
		expect(thirdParty?.nextElementSibling?.getAttribute('href')).toBe(
			'/third-party-licenses-android.txt'
		);
		expect(thirdParty?.nextElementSibling?.nextElementSibling).toBe(stats.element());
		expect(stats.element().nextElementSibling).toBeNull();
	});
}

test('marks only the current nav item and accepts custom items', async () => {
	const screen = await render(Nav, { currentPath: '/cabo/?section=status' });
	expect(screen.container.querySelectorAll('a[data-nav-link][aria-current="page"]')).toHaveLength(
		1
	);
	// At 1440 px "Cabo" is folded into "Mais": the trigger carries the mark, the item says page.
	const more = page.getByRole('button', { name: m.fuxnav_more(), exact: true });
	await expect.poll(() => getComputedStyle(more.element(), '::after').opacity).toBe('1');
	// The menu is its own chunk: nothing of it is rendered until the first press opens it.
	await expect.element(more).toHaveAttribute('aria-haspopup', 'menu');
	expect(screen.container.querySelector('[role="menu"]')).toBeNull();
	await more.click();
	await expect
		.element(page.getByRole('menuitem', { name: 'Cabo', exact: true }))
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
	const write = page.getByRole('button', { name: 'Gravar no cabo' });
	await expect.element(write).toHaveAttribute('aria-disabled', 'true');
	await expect
		.element(write)
		.toHaveAccessibleDescription('Gravando no cabo. Espere a gravação terminar.');
	(write.element() as HTMLElement).click();
	expect(onWrite).not.toHaveBeenCalled();
	// The click showed the reason; Escape dismisses it so it does not cover the menu below.
	await expect.element(page.getByRole('tooltip')).toBeVisible();
	await userEvent.keyboard('{Escape}');
	// Below 1600 px the presets live in the "Carregar no editor" menu (FUX.NAV).
	const tools = page.getByRole('button', { name: m.fuxnav_tools(), exact: true });
	await tools.click();
	await page.getByRole('menuitem', { name: 'Neutro', exact: true }).click();
	await tools.click();
	await page.getByRole('menuitem', { name: 'Padrão Auri', exact: true }).click();
	await page.getByRole('button', { name: 'Áudio', exact: true }).click();
	expect(onNeutro).toHaveBeenCalledExactlyOnceWith();
	expect(onPadraoAuri).toHaveBeenCalledExactlyOnceWith();
	expect(onAudio).toHaveBeenCalledExactlyOnceWith();
	expect(onWrite).not.toHaveBeenCalled();
	await screen.rerender({ writeDisabled: false });
	await page.getByRole('button', { name: 'Gravar no cabo' }).click();
	expect(onWrite).toHaveBeenCalledExactlyOnceWith();
	expect(getComputedStyle(page.getByRole('banner').element()).position).toBe('fixed');
	expect(page.getByRole('banner').element().getBoundingClientRect().height).toBe(40);
});

test('wide bars show Neutro and Padrão Auri inline, and they act on click', async () => {
	await page.viewport(1920, 1080);
	const callbacks = barCallbacks();
	await render(CableBar, callbacks);
	await page.getByRole('button', { name: 'Neutro', exact: true }).click();
	await page.getByRole('button', { name: 'Padrão Auri', exact: true }).click();
	expect(callbacks.onNeutro).toHaveBeenCalledExactlyOnceWith();
	expect(callbacks.onPadraoAuri).toHaveBeenCalledExactlyOnceWith();
	expect(page.getByRole('button', { name: m.fuxnav_tools(), exact: true }).elements()).toHaveLength(
		0
	);
	// Every destination is inline: no "Mais".
	expect(page.getByRole('navigation').getByRole('link').elements()).toHaveLength(8);
	expect(page.getByRole('button', { name: m.fuxnav_more(), exact: true }).elements()).toHaveLength(
		0
	);
});

test('unsaved changes put a badge on "Gravar no cabo" and a tooltip when it can act', async () => {
	const screen = await render(CableBar, { ...barCallbacks(), unsavedCount: 3 });
	const write = page.getByRole('button', { name: 'Gravar no cabo', exact: true });
	const badge = screen.container.querySelector('.write-badge');
	expect(badge?.textContent).toBe('3');
	await expect.element(write).toHaveAccessibleDescription('3 alterações não gravadas');
	await screen.rerender({ unsavedCount: 0, unsaved: true });
	await expect.poll(() => screen.container.querySelector('.write-badge')).toBeNull();
	await screen.rerender({ unsavedCount: undefined, unsaved: true });
	await expect.poll(() => screen.container.querySelector('.write-badge')?.textContent).toBe('');
	await expect.element(write).toHaveAccessibleDescription('Alterações não gravadas no cabo');
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
	// Announced text (live region); seen as the dot on "Gravar no cabo".
	await expect
		.element(page.getByText('Unsaved changes on the cable', { exact: true }))
		.toBeInTheDocument();
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
	await expect.element(page.getByText('Local draft')).toBeInTheDocument();
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
		await page.getByRole('button', { name: /Switch to English/ }).click();
		expect(switchLocale).toHaveBeenLastCalledWith('en-US');
		expect(getLocale()).toBe('en-US');
		expect(localStorage.getItem('oa.lang')).toBe('en-US');
		expect(document.cookie).toContain('oa_lang=en-US');
		await page.getByRole('button', { name: /Mudar para português/ }).click();
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

test('counts unsaved changes with the right singular and plural (T2)', async () => {
	const screen = await render(CableBar, { unsavedCount: 1 });
	const indicator = screen.container.querySelector('.dirty');
	if (!(indicator instanceof HTMLElement)) throw new Error('Missing unsaved indicator');
	await expect.element(indicator).toHaveTextContent('1 alteração não gravada');
	expect(indicator.classList.contains('has')).toBe(true);
	await screen.rerender({ unsavedCount: 3 });
	await expect.element(indicator).toHaveTextContent('3 alterações não gravadas');
	await screen.rerender({ unsavedCount: 0 });
	await expect.poll(() => indicator.textContent?.trim()).toBe('');
	expect(indicator.classList.contains('has')).toBe(false);
	await setLocale('en-US', { reload: false });
	await cleanup();
	const english = await render(CableBar, { unsavedCount: 1 });
	const englishIndicator = english.container.querySelector<HTMLElement>('.dirty')!;
	await expect.element(englishIndicator).toHaveTextContent('1 unsaved change');
	await english.rerender({ unsavedCount: 2 });
	await expect.element(englishIndicator).toHaveTextContent('2 unsaved changes');
});

const barCallbacks = () => ({
	onNeutro: vi.fn(),
	onPadraoAuri: vi.fn(),
	onWrite: vi.fn(),
	onAudio: vi.fn()
});

test('bar actions are bordered 32 px bar buttons in Geist, never mono (T1, T4, T6)', async () => {
	await render(CableBar, barCallbacks());
	for (const name of ['Áudio', m.fuxnav_tools(), 'Gravar no cabo', /Switch to English/]) {
		const button = page.getByRole('button', { name }).element();
		const style = getComputedStyle(button);
		const label = String(name);
		expect(button.getBoundingClientRect().height, label).toBe(32);
		expect(style.borderTopStyle, label).toBe('solid');
		expect(style.fontFamily, label).not.toMatch(/JetBrains Mono/);
		expect(Number(style.fontWeight), label).toBeLessThanOrEqual(600);
	}
	// Icon-only controls are square and named (accessible name, plus a tooltip on hover/focus).
	for (const name of ['Áudio', m.fuxnav_tools(), /Switch to English/]) {
		const rect = page.getByRole('button', { name }).element().getBoundingClientRect();
		expect(rect.width, String(name)).toBe(32);
	}
	await page.viewport(1920, 1080);
	for (const name of ['Neutro', 'Padrão Auri']) {
		const button = page.getByRole('button', { name, exact: true }).element();
		expect(button.getBoundingClientRect().height, name).toBe(32);
		expect(getComputedStyle(button).fontFamily, name).not.toMatch(/JetBrains Mono/);
	}
});

test('the tools menu is keyboard-complete and says why a preset waits', async () => {
	await render(CableBar, { onWrite: vi.fn() });
	const tools = page.getByRole('button', { name: m.fuxnav_tools(), exact: true });
	(tools.element() as HTMLElement).focus();
	await userEvent.keyboard('{ArrowDown}');
	const neutro = page.getByRole('menuitem', { name: 'Neutro', exact: true });
	await expect.element(neutro).toHaveFocus();
	await expect.element(neutro).toHaveAttribute('aria-disabled', 'true');
	await expect.element(neutro).toHaveAccessibleDescription('Carregando o editor…');
	await userEvent.keyboard('{ArrowDown}');
	await expect
		.element(page.getByRole('menuitem', { name: 'Padrão Auri', exact: true }))
		.toHaveFocus();
	await userEvent.keyboard('{Escape}');
	await expect.element(tools).toHaveFocus();
	await expect.element(tools).toHaveAttribute('aria-expanded', 'false');
});

test('a lazy bar menu renders no menu before intent; ArrowUp opens it on the last item', async () => {
	const screen = await render(CableBar, barCallbacks());
	expect(screen.container.querySelectorAll('[role="menu"]')).toHaveLength(0);
	const tools = page.getByRole('button', { name: m.fuxnav_tools(), exact: true });
	await expect.element(tools).toHaveAttribute('aria-haspopup', 'menu');
	await expect.element(tools).toHaveAttribute('aria-expanded', 'false');
	(tools.element() as HTMLElement).focus();
	await userEvent.keyboard('{ArrowUp}');
	await expect
		.element(page.getByRole('menuitem', { name: 'Padrão Auri', exact: true }))
		.toHaveFocus();
	await expect.element(tools).toHaveAttribute('aria-expanded', 'true');
	await userEvent.keyboard('{Escape}');
	// Later openings go straight through the Menu primitive.
	await userEvent.keyboard('{Enter}');
	await expect.element(page.getByRole('menuitem', { name: 'Neutro', exact: true })).toHaveFocus();
});

test('renders the help snippet in the bar after the language toggle (T3)', async () => {
	await render(CableBar, {
		help: createRawSnippet(() => ({
			render: () => '<button type="button" aria-label="Ajuda e atalhos de teclado">?</button>'
		}))
	});
	const help = page.getByRole('button', { name: 'Ajuda e atalhos de teclado' }).element();
	const toggle = page.getByRole('button', { name: /Switch to English/ }).element();
	expect(page.getByRole('banner').element().contains(help)).toBe(true);
	expect(toggle.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	expect(getComputedStyle(help).position).not.toBe('fixed');
});

test('on mobile the bar is one row of 44 px targets and the sheet holds the rest', async () => {
	await page.viewport(390, 844);
	const callbacks = barCallbacks();
	const onHelp = vi.fn();
	await render(CableBar, { ...callbacks, onHelp, currentPath: '/cabo' });
	const banner = page.getByRole('banner').element().getBoundingClientRect();
	expect(banner.height).toBe(52);
	expect(page.getByRole('navigation').elements()).toHaveLength(0);
	const menuButton = page.getByRole('button', { name: m.fuxnav_menu_open(), exact: true });
	for (const name of ['Áudio', 'Gravar no cabo', m.fuxnav_menu_open()]) {
		const rect = page.getByRole('button', { name, exact: true }).element().getBoundingClientRect();
		expect(rect.left, name).toBeGreaterThanOrEqual(0);
		expect(rect.right, name).toBeLessThanOrEqual(390);
		expect(rect.top, name).toBeGreaterThanOrEqual(banner.top);
		expect(rect.bottom, name).toBeLessThanOrEqual(banner.bottom);
		expect(rect.height, name).toBeGreaterThanOrEqual(44);
		expect(rect.width, name).toBeGreaterThanOrEqual(44);
	}
	// Short visible label, full accessible name (label in name, WCAG 2.5.3).
	await expect
		.element(page.getByRole('button', { name: 'Gravar no cabo', exact: true }))
		.toMatchTextContent(/Gravar/);

	await menuButton.click();
	const sheet = page.getByRole('dialog', { name: m.fuxnav_sheet_title() });
	await expect.element(sheet).toBeVisible();
	await expect.element(menuButton).toHaveAttribute('aria-expanded', 'true');
	const nav = sheet.getByRole('navigation', { name: 'Principal' });
	expect(nav.getByRole('link').elements()).toHaveLength(8);
	await expect
		.element(nav.getByRole('link', { name: 'Cabo', exact: true }))
		.toHaveAttribute('aria-current', 'page');
	for (const link of nav.getByRole('link').elements()) {
		expect(link.getAttribute('data-sveltekit-preload-code')).toBe('hover');
		expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
	}
	await expect.element(sheet.getByRole('button', { name: /Switch to English/ })).toBeVisible();
	// A preset closes the sheet first, then loads (never writes).
	await sheet.getByRole('button', { name: 'Neutro', exact: true }).click();
	await expect.poll(() => callbacks.onNeutro.mock.calls.length).toBe(1);
	await expect.element(sheet).not.toBeInTheDocument();
	expect(callbacks.onWrite).not.toHaveBeenCalled();
	await expect.element(menuButton).toHaveFocus();
	// Escape closes it too; the help item hands over to the help dialog.
	await menuButton.click();
	await expect.element(sheet).toBeVisible();
	await userEvent.keyboard('{Escape}');
	await expect.element(sheet).not.toBeInTheDocument();
	await menuButton.click();
	await sheet.getByRole('button', { name: 'Ajuda e atalhos de teclado', exact: true }).click();
	await expect.poll(() => onHelp.mock.calls.length).toBe(1);
	await expect.element(sheet).not.toBeInTheDocument();
});

test('the menu sheet closes when the window grows past 720 px', async () => {
	await page.viewport(390, 844);
	await render(CableBar, barCallbacks());
	await page.getByRole('button', { name: m.fuxnav_menu_open(), exact: true }).click();
	const sheet = page.getByRole('dialog', { name: m.fuxnav_sheet_title() });
	await expect.element(sheet).toBeVisible();
	await page.viewport(1024, 844);
	await expect.element(sheet).not.toBeInTheDocument();
});

test('keeps PT · EN on a single mobile line in the sheet', async () => {
	await page.viewport(390, 844);
	await render(LanguageToggle, { variant: 'full' });
	const button = page.getByRole('button', { name: /Switch to English/ }).element();
	const spans = [...button.querySelectorAll('span:not(.sr-only)')];
	expect(getComputedStyle(button).whiteSpace).toBe('nowrap');
	expect(getComputedStyle(button).flexWrap).toBe('nowrap');
	expect(new Set(spans.map((span) => span.getBoundingClientRect().top)).size).toBe(1);
});
