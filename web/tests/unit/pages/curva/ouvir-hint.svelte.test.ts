import axe from 'axe-core';
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { m } from '#lib/paraglide/messages.js';
import ScopePanel from '#lib/components/pages/curva/ScopePanel.svelte';
import type { Layer } from '#lib/components/pages/curva/layers.ts';
import type { Band, Curve } from '#lib/components/pages/curva/model.ts';
import '../../primitives/design-system.ts';

const OFF: Band = { kind: 'OFF' };
/** Neutro: every section OFF, so the scope parks its ten points and shows a hint. */
const neutral: Curve = { bands: Array.from({ length: 10 }, () => OFF), preampDb: 0 };

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

async function setup(layer: Layer) {
	const onlayer = vi.fn();
	const screen = await render(ScopePanel, {
		curve: neutral,
		layer,
		locale: 'pt-BR',
		spectrumMode: 'data',
		analyser: null,
		playing: false,
		side: 'B',
		referenceName: 'Reference',
		ondrag: vi.fn(),
		oncommit: vi.fn(),
		onpark: vi.fn(),
		onlayer,
		onpreview: vi.fn(),
		onside: vi.fn()
	});
	return { screen, onlayer };
}

const dragHint = () => page.getByText(m.empty_neutral_body(), { exact: true });
const editButton = () => page.getByRole('button', { name: m.curva_ouvir_hint_action() });

test('Ouvir explains the layer and how to edit, without the drag hint', async () => {
	const { screen } = await setup('ouvir');
	const hint = page.getByTestId('ouvir-hint');
	await expect.element(hint).toBeVisible();
	await expect.element(hint.getByText(m.curva_ouvir_hint_title(), { exact: true })).toBeVisible();
	await expect.element(hint.getByText(m.curva_ouvir_hint_body(), { exact: true })).toBeVisible();
	await expect.element(editButton()).toBeVisible();
	await expect.element(dragHint()).not.toBeInTheDocument();
	// Nothing can be dragged here: the parked points are decoration, not sliders.
	expect(screen.container.querySelectorAll('[data-parked]')).toHaveLength(0);
});

test.each(['ajustar', 'engenharia'] as const)('%s keeps the drag hint', async (layer) => {
	const { screen } = await setup(layer);
	await expect.element(dragHint()).toBeVisible();
	await expect.element(page.getByTestId('ouvir-hint')).not.toBeInTheDocument();
	await expect.element(editButton()).not.toBeInTheDocument();
	expect(screen.container.querySelectorAll('[data-parked]')).toHaveLength(10);
});

test('the button switches to Ajustar through the layer callback, by pointer and keyboard', async () => {
	const { onlayer } = await setup('ouvir');
	const button = editButton();
	await button.click();
	expect(onlayer).toHaveBeenCalledExactlyOnceWith('ajustar');

	onlayer.mockClear();
	const element = button.element();
	if (!(element instanceof HTMLButtonElement)) throw new Error('expected a button');
	element.focus();
	expect(document.activeElement).toBe(element);
	await userEvent.keyboard('{Enter}');
	expect(onlayer).toHaveBeenCalledExactlyOnceWith('ajustar');

	onlayer.mockClear();
	await userEvent.keyboard(' ');
	expect(onlayer).toHaveBeenCalledExactlyOnceWith('ajustar');
	// Touch-friendly target (WCAG 2.5.8 minimum).
	expect(element.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
});

test('the Ouvir hint is never cut: over a wide plot, below a phone-sized one', async () => {
	await page.viewport(1200, 900);
	const { screen } = await setup('ouvir');
	const glass = screen.container.querySelector('.screen');
	const hint = page.getByTestId('ouvir-hint').element();
	if (!glass) throw new Error('expected the scope screen');
	// Outside the clipped screen (overflow: hidden), so no part of it can be cut off.
	expect(hint.closest('.screen')).toBeNull();
	// Wide: over the plot, inside the screen's box, as before.
	const plot = glass.getBoundingClientRect();
	const over = hint.getBoundingClientRect();
	expect(over.top).toBeGreaterThanOrEqual(plot.top);
	expect(over.bottom).toBeLessThanOrEqual(plot.bottom);
	expect(over.right).toBeLessThanOrEqual(plot.right);
	// Phone: the plot is shorter than the hint; it follows the screen, title included.
	await page.viewport(390, 844);
	const below = () => hint.getBoundingClientRect().top - glass.getBoundingClientRect().bottom;
	await expect.poll(below).toBeGreaterThanOrEqual(0);
	await expect.element(page.getByText(m.curva_ouvir_hint_title(), { exact: true })).toBeVisible();
});

test.each(['ouvir', 'ajustar', 'engenharia'] as const)(
	'%s hint has no axe violations',
	async (layer) => {
		const { screen } = await setup(layer);
		const hint = screen.container.querySelector('.park-hint');
		if (!(hint instanceof HTMLElement)) throw new Error('expected the scope hint');
		// The hint itself; the whole page is covered by the e2e axe pass.
		expect((await axe.run(hint)).violations).toEqual([]);
	}
);
