// Tooltip (FUX.1, spec §2.6): 400 ms hover delay, opens on keyboard focus, Escape closes,
// described-by wiring, top layer (never clipped by the scrolling bar).
import { afterEach, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import TooltipFixture from './TooltipFixture.svelte';
import './design-system.ts';

afterEach(async () => {
	await cleanup();
});

const TEXT = 'Q é a largura do filtro.';

test('the trigger is described by the tooltip text, closed at first', async () => {
	await render(TooltipFixture, { text: TEXT });
	const trigger = page.getByRole('button', { name: 'Q' });
	await expect.element(trigger).toHaveAccessibleDescription(TEXT);
	expect(document.querySelector('[role="tooltip"]')?.matches(':popover-open')).toBe(false);
});

test('keyboard: focus opens at once, Escape closes, blur closes', async () => {
	await render(TooltipFixture, { text: TEXT });
	const tooltip = page.getByRole('tooltip', { includeHidden: true });
	// Give the test frame focus first; otherwise the first Tab lands outside it.
	await page.getByText('Before').click();
	await userEvent.tab();
	await expect.element(page.getByRole('button', { name: 'Q' })).toHaveFocus();
	await expect.element(tooltip).toBeVisible();
	await expect.element(tooltip).toHaveTextContent(TEXT);
	await userEvent.keyboard('{Escape}');
	await expect.element(tooltip).not.toBeVisible();
	await expect.element(page.getByRole('button', { name: 'Q' })).toHaveFocus();
	await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
	await userEvent.tab();
	await expect.element(tooltip).toBeVisible();
	await userEvent.tab();
	await expect.element(page.getByRole('button', { name: 'After' })).toHaveFocus();
	await expect.element(tooltip).not.toBeVisible();
});

test('hover opens after the 400 ms delay and the tooltip sits in the top layer, fixed', async () => {
	await render(TooltipFixture, { text: TEXT });
	const element = document.querySelector('[role="tooltip"]');
	if (!(element instanceof HTMLElement)) throw new Error('Missing tooltip');
	const started = performance.now();
	await page.getByRole('button', { name: 'Q' }).hover();
	if (performance.now() - started < 300) expect(element.matches(':popover-open')).toBe(false);
	await expect.poll(() => element.matches(':popover-open'), { timeout: 5000 }).toBe(true);
	expect(performance.now() - started).toBeGreaterThanOrEqual(390);
	expect(getComputedStyle(element).position).toBe('fixed');
	await page.getByRole('button', { name: 'After' }).hover();
	await expect.poll(() => element.matches(':popover-open'), { timeout: 5000 }).toBe(false);
});
