// Tooltip (FUX.1, spec §2.6): 400 ms hover delay, opens on keyboard focus, Escape closes,
// described-by wiring, top layer (never clipped by the scrolling bar).
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NATIVE_BACK_EVENT } from '#lib/components/chrome/native-back.ts';
import TooltipFixture from './TooltipFixture.svelte';
import PinnedTooltipFixture from './PinnedTooltipFixture.svelte';
import './design-system.ts';

afterEach(async () => {
	await cleanup();
	vi.unstubAllGlobals();
});

const TEXT = 'Q é a largura do filtro.';

function pressBack(): boolean {
	return !window.dispatchEvent(new CustomEvent(NATIVE_BACK_EVENT, { cancelable: true }));
}

test('Android Back closes a Tooltip pinned by an unavailable button touch press and unregisters', async () => {
	vi.stubGlobal('Capacitor', {
		isNativePlatform: () => true,
		getPlatform: () => 'android'
	});
	await render(PinnedTooltipFixture, { text: TEXT });
	const trigger = page.getByRole('button', { name: 'Unavailable' }).element() as HTMLButtonElement;
	const tooltip = page.getByRole('tooltip', { includeHidden: true });
	const touch = { bubbles: true, pointerType: 'touch' };
	trigger.dispatchEvent(new PointerEvent('pointerdown', touch));
	trigger.dispatchEvent(new PointerEvent('pointerup', touch));
	// Button explicitly pins its unavailable-action reason on click, even without focus/hover.
	trigger.click();
	await expect.element(tooltip).toBeVisible();
	expect(pressBack()).toBe(true);
	await expect.element(tooltip).not.toBeVisible();
	expect(pressBack()).toBe(false);
	trigger.click();
	await expect.element(tooltip).toBeVisible();
	expect(pressBack()).toBe(true);
	await expect.element(tooltip).not.toBeVisible();
	trigger.click();
	await expect.element(tooltip).toBeVisible();
	await cleanup();
	expect(pressBack()).toBe(false);
});

test('outside Android a focused Tooltip does not register Back', async () => {
	vi.stubGlobal('Capacitor', undefined);
	await render(TooltipFixture, { text: TEXT });
	page.getByRole('button', { name: 'Q' }).element().focus();
	const tooltip = page.getByRole('tooltip', { includeHidden: true });
	await expect.element(tooltip).toBeVisible();
	expect(pressBack()).toBe(false);
	await expect.element(tooltip).toBeVisible();
});

test('Android Back ignores a Tooltip opened by keyboard or restored focus', async () => {
	vi.stubGlobal('Capacitor', {
		isNativePlatform: () => true,
		getPlatform: () => 'android'
	});
	await render(TooltipFixture, { text: TEXT });
	const trigger = page.getByRole('button', { name: 'Q' });
	const tooltip = page.getByRole('tooltip', { includeHidden: true });
	await page.getByText('Before').click();
	await userEvent.tab();
	await expect.element(trigger).toHaveFocus();
	await expect.element(tooltip).toBeVisible();
	expect(pressBack()).toBe(false);
	await expect.element(tooltip).toBeVisible();
	page.getByRole('button', { name: 'After' }).element().focus();
	await expect.element(tooltip).not.toBeVisible();
	// The same programmatic focus used when a modal restores its trigger.
	trigger.element().focus();
	await expect.element(tooltip).toBeVisible();
	expect(pressBack()).toBe(false);
	await expect.element(tooltip).toBeVisible();
});

test('Android Back ignores a hover-open Tooltip', async () => {
	vi.stubGlobal('Capacitor', {
		isNativePlatform: () => true,
		getPlatform: () => 'android'
	});
	await render(TooltipFixture, { text: TEXT, delay: 0 });
	const tooltip = page.getByRole('tooltip', { includeHidden: true });
	await page.getByRole('button', { name: 'Q' }).hover();
	await expect.element(tooltip).toBeVisible();
	expect(pressBack()).toBe(false);
	await expect.element(tooltip).toBeVisible();
});

test('pressing an already focus-open unavailable reason pins it for Android Back', async () => {
	vi.stubGlobal('Capacitor', {
		isNativePlatform: () => true,
		getPlatform: () => 'android'
	});
	await render(PinnedTooltipFixture, { text: TEXT });
	const trigger = page.getByRole('button', { name: 'Unavailable' });
	const tooltip = page.getByRole('tooltip', { includeHidden: true });
	trigger.element().focus();
	await expect.element(tooltip).toBeVisible();
	expect(pressBack()).toBe(false);
	(trigger.element() as HTMLElement).click();
	await tick();
	expect(pressBack()).toBe(true);
	await expect.element(tooltip).not.toBeVisible();
	expect(pressBack()).toBe(false);
	// Blur also clears a pin; restoring focus afterward must remain passive.
	(trigger.element() as HTMLElement).click();
	await tick();
	trigger.element().blur();
	await expect.element(tooltip).not.toBeVisible();
	trigger.element().focus();
	await expect.element(tooltip).toBeVisible();
	expect(pressBack()).toBe(false);
});

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
	// Re-focus Q from "After", never from before it: Q is the first focusable element in the
	// test frame, so Shift+Tab from Q leaves the frame and the next Tab lands wherever the
	// runner's top page puts it, which may not be Q (it timed out in headless Chromium on CI).
	await userEvent.tab();
	await expect.element(page.getByRole('button', { name: 'After' })).toHaveFocus();
	await expect.element(tooltip).not.toBeVisible();
	await userEvent.tab({ shift: true });
	await expect.element(page.getByRole('button', { name: 'Q' })).toHaveFocus();
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
