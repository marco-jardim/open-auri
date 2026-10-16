import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import { setLocale } from '#lib/paraglide/runtime.js';
import { createToastStore, Toast } from '#lib/components/chrome/index.ts';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	vi.useRealTimers();
	await setLocale('pt-BR', { reload: false });
});

/**
 * The real (CDP) pointer stays where the last `locator.click()` left it — over the dismiss button
 * of the bottom-centred toast region in the tests above. A new toast rendered under it receives a
 * real `mouseenter` from Chromium on the next frame (real time, not faked), pausing the timer at an
 * arbitrary moment. Timed tests drive hover synthetically, so take the toast out of hit-testing.
 * Must run in the same task as the render (before any frame) to be effective.
 */
function shieldFromRealPointer(container: HTMLElement): HTMLLIElement {
	const item = container.querySelector('li')!;
	item.style.pointerEvents = 'none';
	return item;
}

for (const copy of [
	{ locale: 'pt-BR', dismiss: 'Dispensar notificação' },
	{ locale: 'en-US', dismiss: 'Dismiss notification' }
] as const) {
	test(`announces politely and dismisses manually in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		const store = createToastStore();
		const screen = await render(Toast, { store });
		await expect.element(page.getByRole('status')).toHaveAttribute('aria-live', 'polite');
		store.push('Saved <script>not markup</script>', { duration: 0, tone: 'success' });
		await tick();
		await expect.element(page.getByText('Saved <script>not markup</script>')).toBeVisible();
		expect(screen.container.querySelector('script')).toBeNull();
		await page.getByRole('button', { name: copy.dismiss }).click();
		expect(get(store)).toEqual([]);
		await expect.element(page.getByRole('status')).toBeInTheDocument();
	});
}

test('auto-dismisses after the configured visible duration', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
	const store = createToastStore();
	const screen = await render(Toast, { store });
	store.push('Temporary message', { duration: 1000 });
	await tick();
	shieldFromRealPointer(screen.container);
	await vi.advanceTimersByTimeAsync(999);
	expect(get(store)).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(1);
	await tick();
	expect(get(store)).toEqual([]);
	expect(page.getByText('Temporary message').elements()).toHaveLength(0);
});

test('preserves remaining time across overlapping hover and keyboard-focus pauses', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
	const store = createToastStore();
	const screen = await render(Toast, { store });
	store.push('Paused message', { duration: 1000 });
	await tick();
	const item = shieldFromRealPointer(screen.container);
	await vi.advanceTimersByTimeAsync(400);
	item.dispatchEvent(new MouseEvent('mouseenter'));
	const dismiss = page.getByRole('button', { name: 'Dispensar notificação' }).element();
	// Headless pages are not focused, so focus()/blur() do not emit focusin/focusout; dispatch them.
	dismiss.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
	await vi.advanceTimersByTimeAsync(2000);
	expect(get(store)).toHaveLength(1);
	item.dispatchEvent(new MouseEvent('mouseleave'));
	await vi.advanceTimersByTimeAsync(2000);
	expect(get(store)).toHaveLength(1);
	dismiss.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
	await vi.advanceTimersByTimeAsync(599);
	expect(get(store)).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(get(store)).toEqual([]);
});

test('persistent notifications stay visible and unmount cancels outstanding timers', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
	const store = createToastStore();
	const screen = await render(Toast, { store });
	store.push('Persistent', { duration: 0 });
	await tick();
	await vi.advanceTimersByTimeAsync(60000);
	expect(get(store)).toHaveLength(1);
	store.push('Timer is cancelled on unmount', { duration: 1000 });
	await tick();
	await screen.unmount();
	await vi.advanceTimersByTimeAsync(2000);
	expect(get(store)).toHaveLength(2);
});
