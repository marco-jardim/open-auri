import { expect, test, type Page } from '@playwright/test';

// FUX.P1: states of the Biblioteca that the shared visual spec does not capture (spec §1.4b):
// open sheet, empty local shelf with example boxes, meters in DATA, audio popover and /c/[id].
// Default and reduced motion; screenshots freeze animations, the motion itself is checked by
// reading the computed animation of the sheet.

const SHARED_CURVE_ID = process.env.OA_E2E_SHARED_CURVE_ID ?? '';

async function openLibrary(page: Page) {
	await page.goto('/biblioteca');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	// The app runtime may mount after the first paint (FUX.2): wait for the local shelf to settle.
	await expect(page.locator('[data-tour="biblioteca-shelf"] [aria-busy="true"]')).toHaveCount(0, {
		timeout: 10_000
	});
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
	test.describe(`biblioteca states (${reducedMotion} motion)`, () => {
		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ reducedMotion });
		});

		test('meters show DATA without audio, never AO VIVO', async ({ page }) => {
			await openLibrary(page);
			const console_ = page.locator('.console');
			await expect(console_).toHaveAttribute('data-mode', 'data');
			await expect(console_.locator('.chip')).toHaveAttribute('data-mode', 'data');
			await expect(console_).not.toContainText('S4');
			await expect(console_).toHaveScreenshot(`biblioteca-meters-data-${reducedMotion}.png`, {
				animations: 'disabled'
			});
		});

		test('empty local shelf teaches, with example boxes', async ({ page }) => {
			await openLibrary(page);
			const shelf = page.locator('[data-tour="biblioteca-shelf"]');
			await expect(shelf.locator('.library-empty')).toBeVisible();
			await expect(shelf.locator('.example-box')).toHaveCount(3);
			await expect(shelf).toHaveScreenshot(`biblioteca-empty-${reducedMotion}.png`, {
				animations: 'disabled'
			});
		});

		test('open sheet slides out of the shelf and unfolds like paper', async ({ page }) => {
			await openLibrary(page);
			await page.locator('[data-tour="biblioteca-card"]').click();
			const dialog = page.getByRole('dialog');
			await expect(dialog).toBeVisible();
			const animation = await dialog.evaluate((node) => getComputedStyle(node).animationName);
			expect(animation === 'none').toBe(reducedMotion === 'reduce');
			await expect(dialog.locator('[data-tour="biblioteca-share"]')).toBeVisible();
			await expect(page).toHaveScreenshot(`biblioteca-sheet-open-${reducedMotion}.png`, {
				animations: 'disabled',
				fullPage: false
			});
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
		});

		test('audio popover', async ({ page }) => {
			await openLibrary(page);
			const trigger = page.getByRole('button', { name: /^(Áudio|Audio)\b/ }).first();
			test.skip((await trigger.count()) === 0, 'audio trigger not rendered in this build');
			await trigger.click();
			await expect(page).toHaveScreenshot(`biblioteca-audio-popover-${reducedMotion}.png`, {
				animations: 'disabled'
			});
		});

		test('shared curve /c/[id] uses the card and sheet look', async ({ page }) => {
			test.skip(SHARED_CURVE_ID === '', 'set OA_E2E_SHARED_CURVE_ID to a seeded public curve');
			await page.goto(`/c/${encodeURIComponent(SHARED_CURVE_ID)}`);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			await expect(page.locator('.paper')).toBeVisible();
			await expect(page).toHaveScreenshot(`shared-curve-${reducedMotion}.png`, {
				animations: 'disabled'
			});
		});
	});
}
