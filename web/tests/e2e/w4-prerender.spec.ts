import { expect, test } from '@playwright/test';
import { ANDROID_RELEASES_URL } from '../../src/lib/cable/android-links.ts';

test('prerendered docs contain no APK download anchors before hydration; browser hydration reveals them', async ({
	request,
	page
}) => {
	const response = await request.get('/docs');
	expect(response.ok()).toBe(true);
	const html = await response.text();
	expect(html).not.toContain(`href="${ANDROID_RELEASES_URL}"`);
	await page.goto('/docs');
	await expect(page.locator(`#android a[href="${ANDROID_RELEASES_URL}"]`)).toBeVisible();
});
