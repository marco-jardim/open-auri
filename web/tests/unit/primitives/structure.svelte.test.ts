// Panel, Field and EmptyState (FUX.1, spec §2.6): landmarks and headings, label/hint/error
// wiring with aria-invalid, empty states that explain why and offer the next step.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { EmptyState, Panel } from '#lib/components/primitives/index.ts';
import FieldFixture from './FieldFixture.svelte';
import './design-system.ts';

const html = (markup: string) => createRawSnippet(() => ({ render: () => markup }));

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
});

test('panel: region named by its serif title, eyebrow, explainer slot, variants', async () => {
	const screen = await render(Panel, {
		variant: 'hardware',
		eyebrow: 'Saída',
		title: 'Preamp',
		level: 3,
		explain: html('<button type="button" aria-label="O que é isso?">?</button>'),
		children: html('<p>−3,0 dB</p>')
	});
	const region = page.getByRole('region', { name: 'Preamp' });
	await expect.element(region).toBeVisible();
	await expect.element(page.getByRole('heading', { level: 3, name: 'Preamp' })).toBeVisible();
	await expect.element(page.getByText('Saída')).toBeVisible();
	await expect.element(page.getByRole('button', { name: 'O que é isso?' })).toBeVisible();
	const section = screen.container.querySelector('section');
	expect(section?.classList.contains('panel')).toBe(true);
	expect(section?.classList.contains('panel--hardware')).toBe(true);
});

test('field: label, hint and error wired to the control, aria-invalid, unit spoken', async () => {
	const screen = await render(FieldFixture, { error: null });
	const input = page.getByRole('textbox', { name: 'Preamp (dB)' });
	await expect.element(input).toBeVisible();
	await expect.element(input).toBeRequired();
	await expect.element(input).toHaveAccessibleDescription('De −25,5 a −0,5 dB.');
	await expect.element(input).not.toHaveAttribute('aria-invalid');
	expect(input.element().classList.contains('input')).toBe(true);
	await screen.rerender({ error: 'O preamp precisa ficar entre −25,5 e −0,5 dB.' });
	const invalid = page.getByRole('textbox', { name: 'Preamp (dB)' });
	await expect.element(invalid).toHaveAttribute('aria-invalid', 'true');
	await expect
		.element(invalid)
		.toHaveAccessibleDescription(
			'De −25,5 a −0,5 dB. O preamp precisa ficar entre −25,5 e −0,5 dB.'
		);
});

test('empty state: thematic art, title, why, action and "O que é isso?"', async () => {
	await render(EmptyState, {
		title: 'Sua estante está vazia',
		why: 'Salve a curva do editor ou importe um .txt do EqualizerAPO. Tudo fica neste navegador.',
		action: html('<button type="button">Salvar a curva do editor</button>'),
		explainHref: '/docs#g-biblioteca'
	});
	await expect.element(page.getByRole('region', { name: 'Sua estante está vazia' })).toBeVisible();
	await expect
		.element(page.getByRole('heading', { level: 3, name: 'Sua estante está vazia' }))
		.toBeVisible();
	await expect
		.element(page.getByRole('button', { name: 'Salvar a curva do editor' }))
		.toBeVisible();
	await expect
		.element(page.getByRole('link', { name: 'O que é isso?' }))
		.toHaveAttribute('href', '/docs#g-biblioteca');
	const art = document.querySelector('.empty-state__art');
	expect(art?.getAttribute('aria-hidden')).toBe('true');
	expect(art?.querySelector('svg')).not.toBeNull();
});
