import type { Locator, Page } from '@playwright/test';

/** Mask changing measurements, not the static chart or the DATA/LIVE mode labels. */
export function dynamicRegions(page: Page): Locator[] {
	return [
		page.locator('[data-mode][data-dark], canvas[data-mode]'),
		page.locator('time, [role="timer"], [data-testid*="clock"], [data-visual-dynamic]'),
		page.getByTestId('pwa-update-prompt'),
		page.getByTestId('pwa-offline-notice')
	];
}
