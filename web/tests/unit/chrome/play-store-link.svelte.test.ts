import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import PlayStoreLink from '#lib/components/chrome/PlayStoreLink.svelte';
import { ANDROID_PLAY_URL, playStoreHref } from '#lib/cable/android-links.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import '../primitives/design-system.ts';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
	await page.viewport(1440, 900);
	vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)');
});

afterEach(async () => {
	await cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
	await page.viewport(1440, 900);
});

test('omits the link when the Play listing is not live', async () => {
	const screen = await render(PlayStoreLink, { playLive: false });
	expect(screen.container.querySelector('a')).toBeNull();
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`published desktop link has the translated accessible name and safe web target in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		await render(PlayStoreLink, { playLive: true });
		const link = page.getByRole('link', { name: m.chrome_get_android_app(), exact: true });
		await expect.element(link).toBeVisible();
		await expect.element(link).toHaveAccessibleName(m.chrome_get_android_app());
		await expect.element(link).toHaveAttribute('href', ANDROID_PLAY_URL);
		await expect.element(link).toHaveAttribute('target', '_blank');
		await expect.element(link).toHaveAttribute('rel', 'noopener noreferrer');
		expect(link.element().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
		const rect = link.element().getBoundingClientRect();
		expect(rect.width).toBe(32);
		expect(rect.height).toBe(32);
	});
}

test('Android browser opens the intent without a new-tab target or rel', async () => {
	vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 15)');
	await render(PlayStoreLink, { playLive: true });
	const link = page.getByRole('link', { name: m.chrome_get_android_app(), exact: true });
	await expect.element(link).toHaveAttribute('href', playStoreHref(true));
	await expect.element(link).not.toHaveAttribute('target');
	await expect.element(link).not.toHaveAttribute('rel');
});

test('omits the link inside the native Android app even when the listing is live', async () => {
	vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
	vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android');
	const screen = await render(PlayStoreLink, { playLive: true });
	expect(screen.container.querySelector('a')).toBeNull();
});

test('uses the bar recipe for a 44 px mobile hit target', async () => {
	await page.viewport(390, 844);
	await render(PlayStoreLink, { playLive: true });
	const link = page.getByRole('link', { name: m.chrome_get_android_app(), exact: true });
	await expect.element(link).toBeVisible();
	const rect = link.element().getBoundingClientRect();
	expect(rect.width).toBeGreaterThanOrEqual(44);
	expect(rect.height).toBeGreaterThanOrEqual(44);
});
