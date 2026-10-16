import { expect, test } from '@playwright/test';

test('serves the Portuguese home page without console errors', async ({ page }) => {
	const errors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	page.on('pageerror', (error) => errors.push(error.message));

	const response = await page.goto('/');
	expect(response?.status()).toBe(200);
	await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
	await expect(page.getByRole('heading', { name: 'open-auri', level: 1 })).toBeVisible();
	await page.waitForLoadState('networkidle');
	expect(errors).toEqual([]);
});
