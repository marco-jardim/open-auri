import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { settleRendering } from './helpers/a-app';

// State captures check the page's own UI; the late decorative art is hidden (helpers/no-art.css).
const noArt = fileURLToPath(new URL('./helpers/no-art.css', import.meta.url));
// The strict CSP blocks the style Playwright injects for stylePath; CSP is covered by csp.spec.ts.
test.use({ bypassCSP: true });

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
	// The calculated dials fill in when the gate worker answers: wait for them before capturing.
	await settleRendering(page);
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
			// Every dial carries its own mode chip (BIBVU): all of them read DADOS without audio.
			const chips = console_.locator('.chip');
			await expect(chips).toHaveCount(6);
			for (const chip of await chips.all()) await expect(chip).toHaveAttribute('data-mode', 'data');
			await expect(console_).not.toContainText('S4');
			await expect(console_).toHaveScreenshot(`biblioteca-meters-data-${reducedMotion}.png`, {
				animations: 'disabled',
				stylePath: noArt
			});
		});

		test('empty local shelf teaches, with example boxes', async ({ page }) => {
			await openLibrary(page);
			const shelf = page.locator('[data-tour="biblioteca-shelf"]');
			await expect(shelf.locator('.library-empty')).toBeVisible();
			await expect(shelf.locator('.example-box')).toHaveCount(3);
			await expect(shelf).toHaveScreenshot(`biblioteca-empty-${reducedMotion}.png`, {
				animations: 'disabled',
				stylePath: noArt
			});
		});

		test('open sheet slides out of the shelf and unfolds like paper', async ({ page }) => {
			// The Biblioteca tour auto-opens on a first desktop visit: its panel is also a
			// role="dialog" and its Escape handler would close it instead of the sheet. This case
			// is about the sheet, so the tour starts dismissed (`oa.tour.v1`).
			await page.addInitScript(() => {
				if (!location.protocol.startsWith('http')) return;
				const stored = localStorage.getItem('oa.tour.v1');
				const tours: Record<string, string> = stored ? JSON.parse(stored) : {};
				tours.biblioteca ??= 'dispensado';
				localStorage.setItem('oa.tour.v1', JSON.stringify(tours));
			});
			await openLibrary(page);
			await page.locator('[data-tour="biblioteca-card"]').click();
			// The track sheet is the native modal <dialog> holding the share block.
			const dialog = page
				.locator('dialog[open]')
				.filter({ has: page.locator('[data-tour="biblioteca-share"]') });
			await expect(dialog).toBeVisible();
			// The box slides out (`box-out` on the dialog), then the paper unfolds (`.paper`).
			const animation = await dialog.evaluate((node) => getComputedStyle(node).animationName);
			expect(animation === 'none').toBe(reducedMotion === 'reduce');
			const paper = await dialog
				.locator('.paper')
				.first()
				.evaluate((node) => getComputedStyle(node).animationName);
			expect(paper === 'none').toBe(reducedMotion === 'reduce');
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
			// The runtime's ♪ trigger (AudioLoader), named "Áudio da prévia: <file>"; the bar's
			// "Áudio" fallback before the runtime opens nothing and must not be the one pressed.
			const trigger = page.getByRole('button', { name: /^Áudio da prévia:/ });
			await expect(trigger).toBeVisible({ timeout: 10_000 });
			await trigger.click();
			// One press opens it, once its chunk arrived (also on mobile, where no hover warms it).
			const panel = page.getByRole('dialog', { name: 'Áudio da prévia', exact: true });
			await expect(panel).toBeVisible();
			await expect(trigger).toHaveAttribute('aria-expanded', 'true');
			// The panel itself is the subject; the page behind it carries late decorative art.
			await expect(panel).toHaveScreenshot(`biblioteca-audio-popover-${reducedMotion}.png`, {
				animations: 'disabled',
				stylePath: noArt
			});
		});

		test('shared curve /c/[id] uses the card and sheet look', async ({ page }) => {
			test.skip(SHARED_CURVE_ID === '', 'set OA_E2E_SHARED_CURVE_ID to a seeded public curve');
			await page.goto(`/c/${encodeURIComponent(SHARED_CURVE_ID)}`);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			await expect(page.locator('.paper')).toBeVisible();
			await expect(page).toHaveScreenshot(`shared-curve-${reducedMotion}.png`, {
				animations: 'disabled',
				stylePath: noArt
			});
		});
	});
}
