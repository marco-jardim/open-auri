import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import AndroidAppCallout from '#lib/components/cable/AndroidAppCallout.svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { ANDROID_PLAY_URL, ANDROID_RELEASES_URL } from '#lib/cable/android-links.ts';

beforeEach(async () => {
	localStorage.removeItem('oa.androidCallout');
	await setLocale('pt-BR', { reload: false });
});
afterEach(async () => {
	await cleanup();
	localStorage.removeItem('oa.androidCallout');
	vi.restoreAllMocks();
});

for (const clientNavigator of [
	{ userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/141' },
	{ userAgent: 'Reduced UA', userAgentData: { platform: 'Android' } }
]) {
	test(`Android browser offers releases without an unpublished Play listing: ${clientNavigator.userAgent}`, async () => {
		await render(AndroidAppCallout, { clientNavigator, inApp: false, playLive: false });
		await expect.element(page.getByRole('complementary')).toBeVisible();
		await expect.element(page.getByText(m.android_app_callout_untested())).toBeVisible();
		await expect
			.element(page.getByRole('link', { name: m.android_download_github() }))
			.toHaveAttribute('href', ANDROID_RELEASES_URL);
		expect(page.getByRole('link', { name: m.android_download_play() }).elements()).toHaveLength(0);
	});
}

test('published Play link and GitHub both open normally; dismissal persists across mounts', async () => {
	const props = { clientNavigator: { userAgent: 'Android' }, inApp: false, playLive: true };
	await render(AndroidAppCallout, props);
	await expect
		.element(page.getByRole('link', { name: m.android_download_play() }))
		.toHaveAttribute('href', ANDROID_PLAY_URL);
	await expect
		.element(page.getByRole('link', { name: m.android_download_play() }))
		.not.toHaveAttribute('target');
	await page.getByRole('button', { name: m.android_app_callout_dismiss() }).click();
	expect(localStorage.getItem('oa.androidCallout')).toBe('dismissed');
	expect(page.getByRole('complementary').elements()).toHaveLength(0);
	await cleanup();
	await render(AndroidAppCallout, props);
	expect(page.getByRole('complementary').elements()).toHaveLength(0);
});

test.each([
	{ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141', inApp: false },
	{ userAgent: 'Android', inApp: true }
])(
	'never appears on desktop or inside the app: $userAgent, $inApp',
	async ({ userAgent, inApp }) => {
		await render(AndroidAppCallout, { clientNavigator: { userAgent }, inApp });
		expect(page.getByRole('complementary').elements()).toHaveLength(0);
	}
);

test('the default native gate excludes the app even with an Android UA', async () => {
	const capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
	vi.stubGlobal('Capacitor', capacitor);
	try {
		await render(AndroidAppCallout, { clientNavigator: { userAgent: 'Android' } });
		expect(page.getByRole('complementary').elements()).toHaveLength(0);
	} finally {
		vi.unstubAllGlobals();
	}
});

test('unavailable storage neither crashes nor prevents dismissal for this visit', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
		throw new Error('blocked');
	});
	vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
		throw new Error('blocked');
	});
	await render(AndroidAppCallout, { clientNavigator: { userAgent: 'Android' }, inApp: false });
	await expect.element(page.getByRole('complementary')).toBeVisible();
	await page.getByRole('button', { name: m.android_app_callout_dismiss() }).click();
	expect(page.getByRole('complementary').elements()).toHaveLength(0);
});
