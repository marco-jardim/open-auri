import { expect, test } from 'vitest';
import { ANDROID_PLAY_URL, isAndroidBrowser, playStoreHref } from '#lib/cable/android-links.ts';

const intent =
	'intent://details?id=com.openauri.app#Intent;scheme=market;package=com.android.vending;S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.openauri.app;end';

test.each([
	{ userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/141' },
	{ userAgent: 'Mozilla/5.0 (Linux; android 15) Chrome/141' },
	{ userAgent: 'Reduced UA', userAgentData: { platform: 'Android' } },
	{ userAgent: 'Android', userAgentData: { platform: 'Linux' } }
])('Android browser uses the Play intent with encoded web fallback: %j', (nav) => {
	expect(isAndroidBrowser(nav)).toBe(true);
	expect(playStoreHref(isAndroidBrowser(nav))).toBe(intent);
});

test.each([
	{ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141' },
	{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1' },
	{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1' },
	{ userAgent: 'Reduced UA', userAgentData: { platform: 'Windows' } },
	undefined
])('other browsers and missing navigator use the web URL: %j', (nav) => {
	expect(isAndroidBrowser(nav)).toBe(false);
	expect(playStoreHref(isAndroidBrowser(nav))).toBe(ANDROID_PLAY_URL);
});
