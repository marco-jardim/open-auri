import { expect, test } from '@playwright/test';
import { expectNoSeriousAxe } from './helpers/auth-flow';

// No seeded profile fixture exists in helpers (only account/nickname/publication flows).
// The normal :4173 server has sign-up closed; never depend on a developer's persisted D1 user.
// Capture the honest 404 fallback. The populated wall and teaching empty state use local unit DTOs.
for (const motion of ['no-preference', 'reduce'] as const) {
	test.describe(`public profile (${motion})`, () => {
		test.use({ reducedMotion: motion });

		test('missing profile reference', async ({ page }, testInfo) => {
			// Deliberately outside the accepted nickname length, so this cannot become a real user.
			const response = await page.goto(`/u/${'missing-profile-'.repeat(6)}`);
			expect(response?.status()).toBe(404);
			const main = page.locator('#main-content');
			await expect(main).toBeVisible();
			await expect(main.getByRole('heading', { level: 1 })).toBeVisible();
			await page.evaluate(async () => {
				await document.fonts.ready;
			});
			await expectNoSeriousAxe(page);
			expect(
				await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
			).toBe(motion === 'reduce');
			await expect(main).toHaveScreenshot(`profile-404-${testInfo.project.name}-${motion}.png`, {
				animations: 'disabled',
				caret: 'hide'
			});
		});
	});
}
