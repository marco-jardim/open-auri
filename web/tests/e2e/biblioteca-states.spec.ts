import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { settleRendering } from './helpers/a-app';

// State captures check the page's own UI; the late decorative art is hidden (helpers/no-art.css).
const noArt = fileURLToPath(new URL('./helpers/no-art.css', import.meta.url));
// The audio popover lives inside the bar: its capture keeps the bar visible (QA round 2, A).
const noArtPanel = fileURLToPath(new URL('./helpers/no-art-panel.css', import.meta.url));

// FUX.P1: states of the Biblioteca that the shared visual spec does not capture (spec §1.4b):
// open sheet, empty local shelf with example boxes, meters in DATA, audio popover and /c/[id].
// Default and reduced motion; screenshots freeze animations, the motion itself is checked by
// reading the computed animation of the sheet.

const SHARED_CURVE_ID = process.env.OA_E2E_SHARED_CURVE_ID ?? '';

test.beforeEach(async ({ page }) => {
	// These cases exercise the library, not its first-visit tour (which also owns a dialog).
	await page.addInitScript(() => {
		if (!location.protocol.startsWith('http')) return;
		const stored = localStorage.getItem('oa.tour.v1');
		const tours: Record<string, string> = stored ? JSON.parse(stored) : {};
		tours.biblioteca ??= 'dispensado';
		localStorage.setItem('oa.tour.v1', JSON.stringify(tours));
	});
});

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

async function openSheet(page: Page, reducedMotion: 'no-preference' | 'reduce') {
	await openLibrary(page);
	await page.locator('[data-tour="biblioteca-card"]').click();
	const dialog = page
		.locator('dialog[open]')
		.filter({ has: page.locator('[data-tour="biblioteca-share"]') });
	await expect(dialog).toBeVisible();
	// The box slides out, then its paper unfolds, except with reduced motion.
	const animation = await dialog.evaluate((node) => getComputedStyle(node).animationName);
	expect(animation === 'none').toBe(reducedMotion === 'reduce');
	const paper = await dialog
		.locator('.paper')
		.first()
		.evaluate((node) => getComputedStyle(node).animationName);
	expect(paper === 'none').toBe(reducedMotion === 'reduce');
	await expect(dialog.locator('[data-tour="biblioteca-share"]')).toBeVisible();
	return dialog;
}

async function openAudioPanel(page: Page, touch = false) {
	await openLibrary(page);
	// Wait for the runtime's trigger, not the inert pre-runtime "Áudio" fallback.
	const trigger = page.getByRole('button', { name: /^Áudio da prévia:/ });
	await expect(trigger).toBeVisible({ timeout: 10_000 });
	if (touch) await trigger.tap();
	else await trigger.click();
	const panel = page.getByRole('dialog', { name: 'Áudio da prévia', exact: true });
	await expect(panel).toBeVisible();
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	await expect(panel.getByRole('heading').first()).toBeVisible();
	expect(await panel.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
	return { trigger, panel };
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
	test.describe(`biblioteca states (${reducedMotion} motion)`, () => {
		test.beforeEach(async ({ page }) => {
			await page.emulateMedia({ reducedMotion });
		});

		test.describe('captures', () => {
			// Only captures bypass the strict CSP, for Playwright's injected screenshot styles.
			test.use({ bypassCSP: true });

			test('meters show DATA without audio, never AO VIVO', async ({ page }) => {
				await openLibrary(page);
				const console_ = page.locator('.console');
				await expect(console_).toHaveAttribute('data-mode', 'data');
				// Every dial carries its own mode chip (BIBVU): all of them read DADOS without audio.
				const chips = console_.locator('.chip');
				await expect(chips).toHaveCount(6);
				for (const chip of await chips.all())
					await expect(chip).toHaveAttribute('data-mode', 'data');
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
				await openSheet(page, reducedMotion);
				await expect(page).toHaveScreenshot(`biblioteca-sheet-open-${reducedMotion}.png`, {
					animations: 'disabled',
					fullPage: false
				});
			});

			test('audio popover', async ({ page }) => {
				const { panel } = await openAudioPanel(page);
				// The panel itself is the subject; the page behind it carries late decorative art.
				// Its own title must be in the capture, so the shot can only pass with the panel drawn.
				await expect(panel).toHaveScreenshot(`biblioteca-audio-popover-${reducedMotion}.png`, {
					animations: 'disabled',
					stylePath: noArtPanel
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

		test.describe('behaviour under the real CSP', () => {
			test.use({ bypassCSP: false });

			test('sheet opens, respects motion preferences and closes with Escape', async ({ page }) => {
				const dialog = await openSheet(page, reducedMotion);
				await page.keyboard.press('Escape');
				await expect(dialog).toHaveCount(0);
				await expect(page.locator('[data-tour="biblioteca-card"]')).toBeFocused();
			});

			test('audio panel opens and closes on its trigger', async ({ page }) => {
				const { trigger, panel } = await openAudioPanel(page);
				await trigger.click();
				await expect(panel).not.toBeVisible();
				await expect(trigger).toHaveAttribute('aria-expanded', 'false');
			});
		});

		test.describe('touch-only mobile audio panel', () => {
			test.use({ hasTouch: true, viewport: { width: 412, height: 839 }, bypassCSP: false });

			test('one tap opens the cold panel without a hover', async ({ page }) => {
				const { trigger, panel } = await openAudioPanel(page, true);
				// Tap outside: a point of the page below the open panel (the panel may cover the title).
				const box = await panel.boundingBox();
				if (!box) throw new Error('The open audio panel must have a bounding box');
				const viewport = page.viewportSize();
				if (!viewport) throw new Error('The touch project must set a viewport');
				await page.touchscreen.tap(
					viewport.width / 2,
					Math.min(viewport.height - 8, box.y + box.height + 40)
				);
				await expect(panel).not.toBeVisible();
				await expect(trigger).toHaveAttribute('aria-expanded', 'false');
				await trigger.tap();
				await expect(panel).toBeVisible();
				await expect(trigger).toHaveAttribute('aria-expanded', 'true');
			});
		});
	});
}
