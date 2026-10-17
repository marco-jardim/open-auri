// FUX.P7: reading orientation (index, progress, back to top, copyable anchors), anchored
// glossary and figures that trace once. DocsPage never changes the runner URL.
import axe from 'axe-core';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { glossary } from '#lib/comprehension/glossary.ts';
import { explainers } from '#lib/comprehension/explainers.ts';
import { docsContent } from '#lib/content/docs/index.ts';
import DocsPage from '#lib/components/pages/docs/DocsPage.svelte';
import { glossaryEntries, glossaryTerms } from '#lib/components/pages/docs/glossary-entries.ts';
import { docsUi } from '#lib/components/pages/docs/ui.ts';

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(async () => {
	await cleanup();
	if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
	else Reflect.deleteProperty(navigator, 'clipboard');
	window.scrollTo({ top: 0, behavior: 'instant' });
	await setLocale('pt-BR', { reload: false });
});

function stubClipboard(writeText: (text: string) => Promise<void>) {
	const spy = vi.fn(writeText);
	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: spy } });
	return spy;
}

const renderDocs = (props: Partial<{ notify: (message: string, tone: string) => boolean }> = {}) =>
	render(DocsPage, {
		content: docsContent('pt-BR'),
		ui: docsUi(),
		githubUrl: 'https://example.invalid/repository',
		...props
	});

test('the glossary map and the Docs entries cover the same 17 terms', () => {
	expect(glossaryTerms).toEqual(Object.keys(glossary));
	expect(glossaryTerms).toHaveLength(17);
	for (const term of [
		'gate',
		'envelope',
		'q',
		'preamp',
		's1',
		's5',
		's6',
		's7',
		'ab-nivel',
		'teste-cego',
		'checklist',
		'flash',
		'crc',
		'q27',
		'q23',
		'camadas',
		'neutro'
	])
		expect(glossaryTerms).toContain(term);
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`every glossary term has its g-<term> anchor with natural name and explainer text in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const screen = await render(DocsPage, {
			content: docsContent(locale),
			ui: docsUi(),
			githubUrl: 'https://example.invalid/repository'
		});
		const glossarySection = screen.container.querySelector('#glossario')!;
		for (const entry of glossaryEntries()) {
			const anchors = screen.container.querySelectorAll(`[id="${entry.id}"]`);
			expect(anchors, entry.id).toHaveLength(1);
			const anchor = anchors[0];
			expect(glossarySection.contains(anchor), entry.id).toBe(true);
			expect(anchor.querySelector('dt a')?.textContent).toBe(glossary[entry.term].title());
			expect(anchor.querySelector('dt a')?.getAttribute('href')).toBe(`#${entry.id}`);
			expect(anchor.querySelector('dd')?.textContent).toContain(explainers[entry.term].body());
			// Visible names are natural language, never plan codes (S1…S10).
			expect(anchor.querySelector('dt')?.textContent ?? '').not.toMatch(/\bS\d+\b/);
		}
		// The checklist entry keeps the literal loudness warning next to it.
		expect(screen.container.querySelector('#g-checklist dd')?.textContent).toContain(
			explainers.checklist.warning()
		);
		// The original technical glossary stays under its own heading.
		for (const [term] of docsContent(locale).glossary)
			expect(glossarySection.textContent).toContain(term);
		const { violations } = await axe.run(screen.container);
		expect(
			violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')
		).toEqual([]);
	}, 30000);
}

// Regression (e2e on /docs#g-*: the page turned into the 500 page after hydration). The
// layout's `[data-chrome="bar"]` is a wrapper whose in-flow spacer scrolls away while the bar
// inside is `position: fixed`; measuring the wrapper gave a negative offset when the page was
// already scrolled at mount (a deep link), and `rootMargin: '--Npx'` made IntersectionObserver
// throw inside onMount.
test('a deep link mounted while scrolled measures the fixed bar, never a negative offset', async () => {
	const wrapper = document.createElement('div');
	wrapper.dataset.chrome = 'bar';
	const bar = document.createElement('header');
	bar.style.cssText = 'position: fixed; inset: 0 0 auto; height: 56px;';
	const spacer = document.createElement('div');
	spacer.style.height = '56px';
	wrapper.append(bar, spacer);
	const tall = document.createElement('div');
	tall.style.height = '6000px';
	document.body.prepend(wrapper);
	document.body.append(tall);
	try {
		window.scrollTo({ top: 3000, behavior: 'instant' });
		expect(wrapper.getBoundingClientRect().bottom).toBeLessThan(0);
		const screen = await renderDocs();
		const progress = screen.container.querySelector<HTMLElement>('.reading-progress')!;
		await vi.waitFor(() => expect(progress.style.top).toBe('56px'));
		// A later relayout while scrolled rebuilds the reading band with the same, valid offset.
		window.dispatchEvent(new Event('resize'));
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		expect(progress.style.top).toBe('56px');
		expect(
			screen.container.querySelector('main')?.style.getPropertyValue('--docs-scroll-offset')
		).toMatch(/^\d+(?:\.\d+)?px$/);
	} finally {
		wrapper.remove();
		tall.remove();
	}
});

test('the title and chapter headings keep word spaces next to inline markup', async () => {
	await setLocale('pt-BR', { reload: false });
	const content = docsContent('pt-BR');
	const screen = await renderDocs();
	// <br> breaks the line but adds no whitespace: "0xCBe" was the bug.
	expect(screen.container.querySelector('h1')?.textContent?.trim()).toBe(
		'O protocolo 0xCB e seus limites'
	);
	await expect
		.element(page.getByRole('heading', { level: 1 }))
		.toHaveAccessibleName(`${content.titleLead} ${content.titleEmphasis}`);
	const first = content.sections[0];
	await expect
		.element(page.getByRole('heading', { level: 2, name: `01 ${first.title}`, exact: true }))
		.toBeInTheDocument();
});

test('pt-BR checklist warning is the exact literal text', async () => {
	await setLocale('pt-BR', { reload: false });
	const screen = await renderDocs();
	expect(screen.container.querySelector('#g-checklist .literal')?.textContent).toBe(
		'A nova curva pode soar mais alta. Abaixe o volume antes de gravar.'
	);
});

test('copying a heading anchor uses inline feedback when no toast is reachable', async () => {
	const url = window.location.href;
	const writeText = stubClipboard(async () => {});
	const ui = docsUi();
	const notify = vi.fn(() => false);
	const screen = await renderDocs({ notify });
	const title = docsContent('pt-BR').sections.find((section) => section.id === 'protocolo')!.title;
	await page.getByRole('button', { name: ui.copyLink(title), exact: true }).click();
	await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
	expect(writeText).toHaveBeenCalledWith(new URL('#protocolo', url).href);
	expect(notify).toHaveBeenCalledWith(ui.linkCopied, 'success');
	const note = screen.container.querySelector('.copy-note')!;
	expect(note.getAttribute('role')).toBe('status');
	await vi.waitFor(() => expect(note.textContent).toBe(ui.linkCopied));
	expect(window.location.href).toBe(url);
});

test('copying a glossary anchor goes through the toast when the app is mounted', async () => {
	const url = window.location.href;
	const writeText = stubClipboard(async () => {});
	const ui = docsUi();
	const notify = vi.fn(() => true);
	const screen = await renderDocs({ notify });
	const title = glossary.gate.title();
	await page.getByRole('button', { name: ui.copyLink(title), exact: true }).click();
	await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(ui.linkCopied, 'success'));
	expect(writeText).toHaveBeenCalledWith(new URL('#g-gate', url).href);
	expect(screen.container.querySelector('.copy-note')?.textContent).toBe('');
	expect(window.location.href).toBe(url);
});

test('a refused clipboard explains itself instead of failing silently', async () => {
	stubClipboard(async () => {
		throw new DOMException('Denied', 'NotAllowedError');
	});
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const ui = docsUi();
	const screen = await renderDocs();
	const title = docsContent('pt-BR').sections[0].title;
	await page.getByRole('button', { name: ui.copyLink(title), exact: true }).click();
	await vi.waitFor(() =>
		expect(screen.container.querySelector('.copy-note')?.textContent).toBe(ui.linkCopyFailed)
	);
	expect(warn).toHaveBeenCalled();
	warn.mockRestore();
});

test('reading progress, current section and back to top follow real scroll', async () => {
	const ui = docsUi();
	const screen = await renderDocs();
	const bar = screen.container.querySelector<HTMLElement>('.reading-progress')!;
	expect(bar.getAttribute('aria-hidden')).toBe('true');
	expect(bar.style.transform).toBe('scaleX(0)');
	expect(screen.container.querySelector('.to-top')).toBeNull();

	window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
	window.dispatchEvent(new Event('scroll'));
	const scale = () => Number(/scaleX\(([\d.e-]+)\)/.exec(bar.style.transform)?.[1] ?? 'NaN');
	await vi.waitFor(() => expect(scale()).toBeGreaterThan(0.98));
	const last = docsContent('pt-BR').sections.at(-1)!.id;
	await vi.waitFor(() =>
		expect(screen.container.querySelector('a[aria-current="location"]')?.getAttribute('href')).toBe(
			`#${last}`
		)
	);
	const toTop = page.getByRole('button', { name: ui.backToTop });
	await expect.element(toTop).toBeVisible();
	await toTop.click();
	await vi.waitFor(() => expect(window.scrollY).toBe(0), { timeout: 5000 });
	expect(document.activeElement).toBe(screen.container.querySelector('#docs-top'));
	window.dispatchEvent(new Event('scroll'));
	await vi.waitFor(() => expect(screen.container.querySelector('.to-top')).toBeNull());
}, 30000);

test('figures below the fold trace once on entering the viewport; visible ones stay drawn', async () => {
	const screen = await renderDocs();
	const figures = [...screen.container.querySelectorAll<HTMLElement>('#protocolo figure')];
	expect(figures.length).toBeGreaterThanOrEqual(3);
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
		// The runner itself asks for reduced motion: figures must simply stay drawn.
		for (const figure of figures) expect(figure.dataset.trace).toBeUndefined();
		return;
	}
	for (const figure of figures) expect(figure.dataset.trace).toBe('armed');
	const polar = screen.container.querySelector<HTMLElement>('.polar-chart')!;
	if (polar.getBoundingClientRect().top < window.innerHeight)
		expect(polar.dataset.trace).toBeUndefined();

	figures[0].scrollIntoView({ block: 'center', behavior: 'instant' });
	await vi.waitFor(() => expect(['run', 'done']).toContain(figures[0].dataset.trace));
	await vi.waitFor(() => expect(figures[0].dataset.trace).toBe('done'), { timeout: 5000 });
	// Once: leaving and re-entering never re-arms the figure.
	window.scrollTo({ top: 0, behavior: 'instant' });
	figures[0].scrollIntoView({ block: 'center', behavior: 'instant' });
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(figures[0].dataset.trace).toBe('done');
}, 30000);

test('nothing is armed under reduced motion', async () => {
	const real = window.matchMedia.bind(window);
	const reduced = (list: MediaQueryList) =>
		new Proxy(list, {
			get(target, property) {
				if (property === 'matches') return true;
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
	const matchMedia = vi
		.spyOn(window, 'matchMedia')
		.mockImplementation((query: string) =>
			query === '(prefers-reduced-motion: reduce)' ? reduced(real(query)) : real(query)
		);
	const screen = await renderDocs();
	for (const figure of screen.container.querySelectorAll<HTMLElement>('figure, .polar-chart'))
		expect(figure.dataset.trace).toBeUndefined();
	matchMedia.mockRestore();
});
