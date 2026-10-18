// DocsPage edges: deep links (on mount, percent-encoded, malformed, outside the page, hash
// changes, the reader steering), custom content with missing chapters, search over it, the
// preset picker, the credits link, the chrome measurement and the search shortcut while
// another dialog is open, in both locales. The runner URL is restored after every test.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { OFFICIAL_PRESETS } from 'open-auri/catalog';
import { setLocale } from '#lib/paraglide/runtime.js';
import { docsContent } from '#lib/content/docs/index.ts';
import type { DocSection, DocsContent, DocsLocale } from '#lib/content/docs/types.ts';
import DocsPage from '#lib/components/pages/docs/DocsPage.svelte';
import { docsUi } from '#lib/components/pages/docs/ui.ts';

const startUrl = window.location.href;
const GITHUB = 'https://example.invalid/repository';
/** No `[data-chrome="bar"]` in these tests: 56 px default bar + 24 px reading margin. */
const DEFAULT_OFFSET = 80;

afterEach(async () => {
	await cleanup();
	history.replaceState(history.state, '', startUrl);
	window.scrollTo({ top: 0, behavior: 'instant' });
	await setLocale('pt-BR', { reload: false });
});

function withHash(hash: string) {
	history.replaceState(history.state, '', `${startUrl.split('#')[0]}${hash}`);
}

function frames(count: number): Promise<void> {
	return new Promise((resolve) => {
		let left = count;
		const step = () => {
			left -= 1;
			if (left <= 0) resolve();
			else requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});
}

function renderDocs(locale: DocsLocale = 'pt-BR', extra: { githubUrl?: string } = {}) {
	return render(DocsPage, {
		content: docsContent(locale),
		ui: docsUi(),
		githubUrl: GITHUB,
		...extra
	});
}

function customContent(locale: DocsLocale): DocsContent {
	const extra: DocSection = {
		id: 'extra',
		title: 'Extra',
		paragraphs: ['Um parágrafo.'],
		items: ['Primeiro item', 'Segundo item'],
		links: [{ label: 'Fonte', href: 'https://example.invalid/fonte' }]
	};
	const plain: DocSection = { id: 'simples', title: 'Simples', paragraphs: ['Só texto.'] };
	return { ...docsContent(locale), sections: [extra, plain] };
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	describe(`deep links in ${locale}`, () => {
		test('a glossary deep link on mount is marked and placed under the chrome', async () => {
			await setLocale(locale, { reload: false });
			withHash('#g-camadas');
			const screen = await renderDocs(locale);
			const term = screen.container.querySelector<HTMLElement>('#g-camadas');
			expect(term).not.toBeNull();
			await expect.poll(() => term?.classList.contains('is-target')).toBe(true);
			expect(screen.container.querySelectorAll('.term.is-target')).toHaveLength(1);
			await vi.waitFor(
				() =>
					expect(
						Math.abs((term?.getBoundingClientRect().top ?? 0) - DEFAULT_OFFSET)
					).toBeLessThanOrEqual(3),
				{ timeout: 5000 }
			);
		});

		test('a percent-encoded fragment is decoded before lookup', async () => {
			await setLocale(locale, { reload: false });
			withHash('#%67-crc');
			const screen = await renderDocs(locale);
			await expect
				.poll(() => screen.container.querySelector('#g-crc')?.classList.contains('is-target'))
				.toBe(true);
		});
	});

	describe(`custom content in ${locale}`, () => {
		test('missing chapters render nothing special; items and links still show', async () => {
			await setLocale(locale, { reload: false });
			withHash('#g-camadas');
			const ui = docsUi();
			const screen = await render(DocsPage, {
				content: customContent(locale),
				ui,
				githubUrl: GITHUB
			});
			expect(screen.container.querySelector('main')?.getAttribute('lang')).toBe(locale);
			expect(screen.container.querySelector('.toc-label')?.textContent).toBe(`${ui.contents} / 2`);
			const sections = [...screen.container.querySelectorAll<HTMLElement>('section.chapter')];
			expect(sections.map((section) => section.id)).toEqual(['extra', 'simples']);
			expect(sections.map((section) => section.dataset.folio)).toEqual(['002', '003']);
			const [extra, plain] = sections;
			expect(
				[...(extra?.querySelectorAll('.columns li') ?? [])].map((li) => li.textContent)
			).toEqual(['Primeiro item', 'Segundo item']);
			const source = extra?.querySelector('.links a');
			expect(source?.getAttribute('href')).toBe('https://example.invalid/fonte');
			expect(source?.textContent).toBe('Fonte ↗');
			expect(plain?.querySelector('ul')).toBeNull();
			expect(plain?.querySelector('.links')).toBeNull();
			// None of the special chapters: limit tables, protocol widgets, erase, glossary, credits.
			for (const selector of [
				'[data-threshold]',
				'.inset',
				'.erase',
				'.glossary-terms',
				'.official-presets',
				'.credits',
				'details'
			]) {
				expect(screen.container.querySelector(selector), selector).toBeNull();
			}
			// The deep link points at a chapter this content does not have: nothing is marked.
			expect(document.getElementById('g-camadas')).toBeNull();
			expect(screen.container.querySelector('.is-target')).toBeNull();
			// The index still navigates to the chapters that exist.
			const toc = page.getByRole('navigation', { name: ui.contents });
			await toc.getByRole('link', { name: /Simples$/ }).click();
			await vi.waitFor(() => expect(document.activeElement).toBe(plain));
		});

		test('search finds a custom chapter and moves focus there', async () => {
			await setLocale(locale, { reload: false });
			const ui = docsUi();
			const screen = await render(DocsPage, {
				content: customContent(locale),
				ui,
				githubUrl: GITHUB
			});
			await page.getByRole('button', { name: ui.search }).click();
			const dialog = page.getByRole('dialog', { name: ui.search });
			await page.getByRole('searchbox', { name: ui.searchInput }).fill('Simples');
			await dialog.getByRole('link', { name: /Simples/ }).click();
			const plain = screen.container.querySelector('#simples');
			await vi.waitFor(() => expect(document.activeElement).toBe(plain));
		});
	});
}

describe('deep links: what is ignored', () => {
	test('a malformed fragment is used as is and matches nothing', async () => {
		withHash('#%E0%A4%A');
		const screen = await renderDocs();
		await frames(3);
		expect(screen.container.querySelector('.is-target')).toBeNull();
		expect(window.scrollY).toBe(0);
		expect(screen.container.querySelector('h1')).not.toBeNull();
	});

	test('an element outside the page with the same id is not a target', async () => {
		const outside = document.createElement('div');
		outside.id = 'fora-da-pagina';
		outside.style.height = '4000px';
		document.body.append(outside);
		try {
			withHash('#fora-da-pagina');
			const screen = await renderDocs();
			await frames(3);
			expect(window.scrollY).toBe(0);
			expect(screen.container.querySelector('.is-target')).toBeNull();
		} finally {
			outside.remove();
		}
	});
});

describe('deep links after mount', () => {
	test('hash changes move the mark; a chapter or an empty hash marks no term', async () => {
		const screen = await renderDocs();
		const marked = () =>
			[...screen.container.querySelectorAll('.term.is-target')].map((element) => element.id);
		expect(marked()).toEqual([]);
		withHash('#g-crc');
		window.dispatchEvent(new HashChangeEvent('hashchange'));
		await expect.poll(marked).toEqual(['g-crc']);
		withHash('#g-q');
		window.dispatchEvent(new HashChangeEvent('hashchange'));
		await expect.poll(marked).toEqual(['g-q']);
		withHash('#protocolo');
		window.dispatchEvent(new HashChangeEvent('hashchange'));
		await expect.poll(marked).toEqual([]);
		withHash('');
		window.dispatchEvent(new HashChangeEvent('hashchange'));
		await tick();
		expect(marked()).toEqual([]);
	});

	test('layout changes re-align the target until the reader steers', async () => {
		withHash('#g-q');
		const screen = await renderDocs();
		const main = screen.container.querySelector<HTMLElement>('main');
		expect(main).not.toBeNull();
		await vi.waitFor(() => expect(window.scrollY).toBeGreaterThan(0), { timeout: 5000 });
		// Growing content resizes the observed page (a padding change would not: content box).
		const growth = document.createElement('div');
		growth.style.height = '300px';

		// A layout change while settling brings the target back.
		window.scrollTo({ top: 0, behavior: 'instant' });
		main?.append(growth);
		await vi.waitFor(() => expect(window.scrollY).toBeGreaterThan(0), { timeout: 2000 });

		// The reader steers (keyboard): later layout changes leave the scroll alone.
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
		window.scrollTo({ top: 0, behavior: 'instant' });
		growth.style.height = '600px';
		await frames(4);
		expect(window.scrollY).toBe(0);
		growth.remove();
	});
});

describe('page controls', () => {
	test('the preset picker redraws the curve label and CRC', async () => {
		const ui = docsUi();
		const screen = await renderDocs();
		const last = OFFICIAL_PRESETS[OFFICIAL_PRESETS.length - 1];
		expect(last).toBeDefined();
		if (!last) return;
		await page.getByRole('combobox', { name: ui.preset }).selectOptions(last.id);
		const output = screen.container.querySelector('output[for="polar-preset"]');
		await vi.waitFor(() => expect(output?.textContent).toContain(last.label));
		expect(output?.textContent).toContain(
			`CRC 0x${last.crc.toString(16).toUpperCase().padStart(4, '0')}`
		);
	});

	test('the AutoEQ link never doubles the slash of the repository URL', async () => {
		const ui = docsUi();
		for (const githubUrl of [`${GITHUB}/`, GITHUB]) {
			const screen = await renderDocs('pt-BR', { githubUrl });
			const link = [...screen.container.querySelectorAll('a')].find(
				(anchor) => anchor.textContent === `${ui.autoeq} ↗`
			);
			expect(link?.getAttribute('href')).toBe(`${GITHUB}/blob/main/docs/autoeq-data.md`);
			await cleanup();
		}
	});

	test('Ctrl+K does nothing while another dialog is open, and other keys never open search', async () => {
		const ui = docsUi();
		await renderDocs();
		const plain = new KeyboardEvent('keydown', { key: 'k', cancelable: true });
		window.dispatchEvent(plain);
		await tick();
		expect(plain.defaultPrevented).toBe(false);
		expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);

		await page.getByRole('button', { name: ui.clear, exact: true }).click();
		await expect.element(page.getByRole('dialog', { name: ui.clearTitle })).toBeVisible();
		const shortcut = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
		window.dispatchEvent(shortcut);
		await tick();
		expect(shortcut.defaultPrevented).toBe(false);
		expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
	});

	test('the reading band follows a sticky chrome bar, else an in-flow one', async () => {
		const wrapper = document.createElement('div');
		wrapper.dataset.chrome = 'bar';
		const bar = document.createElement('div');
		bar.style.cssText = 'position: sticky; top: 0; height: 30px;';
		wrapper.append(bar);
		document.body.prepend(wrapper);
		try {
			const sticky = await renderDocs();
			const stickyProgress = sticky.container.querySelector<HTMLElement>('.reading-progress');
			await vi.waitFor(() =>
				expect(Number.parseFloat(stickyProgress?.style.top ?? '')).toBeCloseTo(
					bar.getBoundingClientRect().bottom,
					0
				)
			);
			expect(Number.parseFloat(stickyProgress?.style.top ?? '')).not.toBe(56);
			await cleanup();

			bar.style.position = 'static';
			const inFlow = await renderDocs();
			const inFlowProgress = inFlow.container.querySelector<HTMLElement>('.reading-progress');
			await vi.waitFor(() =>
				expect(Number.parseFloat(inFlowProgress?.style.top ?? '')).toBeCloseTo(
					wrapper.getBoundingClientRect().bottom,
					0
				)
			);
		} finally {
			wrapper.remove();
		}
	});
});
