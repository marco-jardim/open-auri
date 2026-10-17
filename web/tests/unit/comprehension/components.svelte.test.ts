import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { createTour, TOUR_STORAGE_KEY } from '#lib/comprehension/tour.svelte.ts';
import { explainers } from '#lib/comprehension/explainers.ts';
import { glossary } from '#lib/comprehension/glossary.ts';
import { tourSteps } from '#lib/comprehension/steps.ts';
import Explainer from '#lib/components/comprehension/Explainer.svelte';
import GlossaryLink from '#lib/components/comprehension/GlossaryLink.svelte';
import Tour from '#lib/components/comprehension/Tour.svelte';
import Fixture from './ComprehensionFixture.svelte';

beforeEach(async () => {
	localStorage.removeItem(TOUR_STORAGE_KEY);
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	localStorage.removeItem(TOUR_STORAGE_KEY);
	await setLocale('pt-BR', { reload: false });
});

const controller = (desktop = false) =>
	createTour({ storage: () => undefined, isDesktop: () => desktop });

test('tour manages keyboard focus, next/back, counter, Escape, reopen and skip', async () => {
	const state = controller();
	await render(Fixture, { controller: state });
	const trigger = page.getByRole('button', { name: 'Como funciona esta página' });
	trigger.element().focus();
	await userEvent.keyboard('{Enter}');
	const dialog = page.getByRole('dialog');
	await expect.element(dialog).toHaveAttribute('aria-modal', 'false');
	await expect.element(dialog.getByRole('heading')).toHaveFocus();
	await expect.element(dialog).toMatchTextContent('1 de 4');
	await dialog.getByRole('button', { name: 'Próximo' }).click();
	await expect.element(dialog).toMatchTextContent('2 de 4');
	await expect.element(dialog.getByRole('heading')).toHaveFocus();
	await expect
		.poll(() => document.querySelector('[data-tour-active]')?.getAttribute('data-tour'), {
			timeout: 5000
		})
		.toBe('curva-chart');
	await dialog.getByRole('button', { name: 'Voltar' }).click();
	await expect.element(dialog).toMatchTextContent('1 de 4');
	await expect
		.poll(() => document.querySelector('[data-tour-active]')?.getAttribute('data-tour'), {
			timeout: 5000
		})
		.toBe('curva-layers');
	await userEvent.keyboard('{Escape}');
	await expect.element(dialog).not.toBeInTheDocument();
	await expect.element(trigger).toHaveFocus();
	expect(state.history.curva).toBe('dispensado');
	await trigger.click();
	await expect.element(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Pular tour' }).click();
	await expect.element(trigger).toHaveFocus();
});

test('tour leaves background usable, is not a focus trap, highlights targets and completes', async () => {
	const state = controller();
	await render(Fixture, { controller: state });
	await page.getByRole('button', { name: 'Como funciona esta página' }).click();
	const dialog = page.getByRole('dialog');
	await expect
		.poll(() => document.querySelector('[data-tour-active]')?.getAttribute('data-tour'), {
			timeout: 5000
		})
		.toBe('curva-layers');
	await page.getByRole('button', { name: 'Background 0' }).click();
	await expect.element(page.getByRole('button', { name: 'Background 1' })).toHaveFocus();
	await expect.element(dialog).toBeVisible();
	for (let i = 0; i < 3; i++) await dialog.getByRole('button', { name: 'Próximo' }).click();
	await expect.element(dialog).toMatchTextContent('4 de 4');
	const finish = dialog.getByRole('button', { name: 'Concluir' });
	finish.element().focus();
	await userEvent.tab();
	expect(dialog.element().contains(document.activeElement)).toBe(false);
	await finish.click();
	await expect.element(dialog).not.toBeInTheDocument();
	expect(state.history.curva).toBe('visto');
	expect(document.querySelector('[data-tour-active]')).toBeNull();
});

test('missing target centres the tour and unmount dismisses the active page', async () => {
	const state = controller();
	state.open('biblioteca');
	const screen = await render(Tour, { page: 'biblioteca', controller: state, autoOpen: false });
	const dialog = page.getByRole('dialog');
	await expect.element(dialog).toBeVisible();
	await expect
		.poll(
			() => {
				const rect = dialog.element().getBoundingClientRect();
				return Math.abs(rect.left + rect.width / 2 - document.documentElement.clientWidth / 2);
			},
			{ timeout: 5000 }
		)
		.toBeLessThan(2);
	await screen.unmount();
	expect(state.activePage).toBeNull();
	expect(state.history.biblioteca).toBe('dispensado');
});

test('default viewport rule is desktop only at 1024px and respects stored dismissal', async () => {
	let width = 1023;
	const match = vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
		matches: width >= 1024,
		media: query,
		onchange: null,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		dispatchEvent: () => true
	}));
	const state = createTour();
	expect(state.shouldAutoOpen('curva')).toBe(false);
	expect(match).toHaveBeenCalledWith('(min-width: 1024px)');
	width = 1024;
	expect(state.shouldAutoOpen('curva')).toBe(true);
	await render(Fixture, { controller: state, autoOpen: true });
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await userEvent.keyboard('{Escape}');
	expect(localStorage.getItem(TOUR_STORAGE_KEY)).toBe('{"curva":"dispensado"}');
	expect(createTour().shouldAutoOpen('curva')).toBe(false);
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`explainer keyboard, ARIA, glossary and focus return in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		await render(Explainer, { term: 'gate' });
		const trigger = page.getByRole('button', { name: /^(O que é isso\?|What is this\?)/ });
		await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');
		trigger.element().focus();
		await userEvent.keyboard(' ');
		const dialog = page.getByRole('dialog', { name: explainers.gate.title() });
		await expect.element(dialog).toBeVisible();
		await expect.element(dialog).toHaveFocus();
		await expect.element(trigger).toHaveAttribute('aria-expanded', 'true');
		expect(trigger.element().getAttribute('aria-controls')).toBe(dialog.element().id);
		expect(dialog.element().getAttribute('aria-labelledby')).toBeTruthy();
		await expect.element(dialog.getByRole('link')).toHaveAttribute('href', '/docs#g-gate');
		expect(getComputedStyle(dialog.element()).position).toBe('fixed');
		await userEvent.keyboard('{Escape}');
		await expect.element(dialog).not.toBeInTheDocument();
		await expect.element(trigger).toHaveFocus();
		await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');
	});

	test(`every registry getter and step resolves in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		for (const entry of Object.values(explainers)) {
			expect(entry.title().trim()).not.toBe('');
			expect(entry.body().trim()).not.toBe('');
			expect(entry.preview().trim()).not.toBe('');
		}
		for (const steps of Object.values(tourSteps))
			for (const step of steps) {
				expect(step.title().trim()).not.toBe('');
				expect(step.body().trim()).not.toBe('');
			}
		for (const entry of Object.values(glossary)) expect(entry.title()).not.toMatch(/\bS\d+\b/);
	});
}

test('click outside and close button close the fixed popover inside an overflow container', async () => {
	const screen = await render(Explainer, { term: 'q' });
	screen.container.style.overflow = 'hidden';
	screen.container.style.height = '44px';
	screen.container.style.transform = 'translateZ(0)';
	const trigger = page.getByRole('button', { name: /^O que é isso\?/ });
	await trigger.click();
	const dialog = page.getByRole('dialog');
	await expect.element(dialog).toBeVisible();
	expect(dialog.element().matches(':popover-open')).toBe(true);
	document.body.click();
	await expect.element(dialog).not.toBeInTheDocument();
	await expect.element(trigger).toHaveFocus();
	await trigger.click();
	await dialog.getByRole('button', { name: 'Fechar explicação' }).click();
	await expect.element(trigger).toHaveFocus();
});

test('checklist explanation keeps the literal loudness warning visible', async () => {
	await render(Explainer, { term: 'checklist' });
	await page.getByRole('button').click();
	await expect
		.element(page.getByRole('dialog'))
		.toMatchTextContent('A nova curva pode soar mais alta. Abaixe o volume antes de gravar.');
});

test('long explainers start concise while retaining the complete official wording', async () => {
	await render(Explainer, { term: 'q' });
	await page.getByRole('button').click();
	const dialog = page.getByRole('dialog');
	await expect.element(dialog).toMatchTextContent(explainers.q.preview());
	const disclosure = dialog.getByText('Ver explicação completa', { exact: true });
	await disclosure.click();
	await expect.element(dialog.getByText(explainers.q.body(), { exact: true })).toBeVisible();
});

test('glossary link uses natural language and the stable technical anchor', async () => {
	await render(GlossaryLink, { term: 's6' });
	await expect
		.element(page.getByRole('link', { name: 'Preferência anônima' }))
		.toHaveAttribute('href', '/docs#g-s6');
});
