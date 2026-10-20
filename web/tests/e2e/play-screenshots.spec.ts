import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect, cableInfo } from './fixtures/capacitor-bridge';
import { settleRendering, waitForApp } from './helpers/a-app';
import { rgbPng, validateAsset } from '../../../tools/play-assets.mjs';

// Opt-in only. From web, set CI=1, PLAY_SCREENSHOTS=1 and
// NODE_OPTIONS=--max-old-space-size=6144, then run:
// npx playwright test tests/e2e/play-screenshots.spec.ts --project=mobile --workers=1
// Follow with node tools/play-assets.mjs from the repository root.
test.skip(process.env.PLAY_SCREENSHOTS !== '1', 'Store capture requires PLAY_SCREENSHOTS=1');
test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'Store capture uses the Pixel 7 mobile project');
});
test.use({
	// Keep Pixel 7 touch/UA emulation, with a Play-friendly 9:16, 1080x1920 capture.
	viewport: { width: 360, height: 640 },
	deviceScaleFactor: 3,
	reducedMotion: 'reduce',
	colorScheme: 'dark',
	nativeOptions: { devices: [], appVersion: '1.0.0' }
});
test.setTimeout(120_000);

const routes = [
	['/', '1-editor'],
	['/cabo', '2-cabo'],
	['/comparar', '3-comparar'],
	['/soe-como-x', '4-soe-como-x'],
	['/comunidade', '5-comunidade'],
	['/teste-cego', '6-teste-cego']
] as const;
// Orchestrator: review the overlapping controls in 3-comparar in both locales before
// regenerating/approving PNGs. The seventh capture below uses fake native USB, not hardware.

for (const locale of ['pt-BR', 'en-US'] as const) {
	test.describe(locale, () => {
		test.use({ locale });
		test('capture phone store screenshots', async ({ page, context, baseURL, nativeBridge }) => {
			if (!baseURL) throw new Error('Store capture requires Playwright use.baseURL');
			await context.addCookies([{ name: 'oa_lang', value: locale, url: baseURL }]);
			const directory = fileURLToPath(
				new URL(`../../../docs/android/play-assets/screenshots/${locale}/`, import.meta.url)
			);
			await mkdir(directory, { recursive: true });
			const title =
				locale === 'pt-BR'
					? 'Gravação pelo app ainda não testada num cabo'
					: 'Writing from the app has not been tested on a cable yet';
			for (const [route, name] of routes) {
				const response = await page.goto(route);
				expect(response?.status(), `${route} must return HTTP 200`).toBe(200);
				await waitForApp(page);
				await expect(page.locator('html')).toHaveAttribute('lang', locale);
				if (route === '/') {
					const notice = page.getByRole('dialog', { name: title, exact: true });
					await expect(notice).toBeVisible();
					await notice
						.getByRole('button', { name: locale === 'pt-BR' ? 'Entendi' : 'Got it', exact: true })
						.click();
					await expect(notice).not.toBeVisible();
				}
				if (route === '/cabo') {
					// Preserve the real app's untested-writing banner, not a browser-only view.
					await expect(page.getByRole('complementary', { name: title, exact: true })).toBeVisible();
				}
				await settleRendering(page);
				await page.evaluate(async () => {
					await document.fonts.ready;
					await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => {})));
					window.scrollTo(0, 0);
				});
				const png = rgbPng(await page.screenshot({ animations: 'disabled', fullPage: false }));
				validateAsset(png, `${name}.png`);
				await writeFile(`${directory}${name}.png`, png);
			}
			// The six browsing captures must not request even simulated USB permission.
			expect(nativeBridge.reports).toEqual([]);
			expect(
				nativeBridge.calls.filter(({ methodName }) =>
					['requestDevice', 'open', 'sendReport'].includes(methodName)
				)
			).toEqual([]);

			// Seventh capture: the real Capacitor bridge flow with a fake connected cable.
			// Never use real hardware or send reports, and leave every confirmation unchecked.
			await nativeBridge.connect(cableInfo());
			const response = await page.goto('/cabo');
			expect(response?.status()).toBe(200);
			await waitForApp(page);
			await expect(page.locator('html')).toHaveAttribute('lang', locale);
			await expect(
				page.getByText(
					locale === 'pt-BR'
						? 'App Android v1.0.0, USB host OK'
						: 'Android app v1.0.0, USB host OK',
					{ exact: true }
				)
			).toBeVisible();
			await page
				.getByRole('button', {
					name: locale === 'pt-BR' ? 'Conectar pelo USB do Android' : 'Connect over Android USB',
					exact: true
				})
				.click();
			await expect(page.locator('[data-state="connected"]')).toHaveAttribute('aria-current', 'step');
			await page
				.getByRole('button', {
					name: locale === 'pt-BR' ? 'Levantar tampa do checklist' : 'Lift checklist cover',
					exact: true
				})
				.click();
			await page
				.getByRole('button', {
					name: locale === 'pt-BR' ? 'Revisar e gravar' : 'Review and write',
					exact: true
				})
				.click();
			const checklist = page.getByRole('dialog', {
				name: locale === 'pt-BR' ? 'Antes de gravar' : 'Before writing',
				exact: true
			});
			await expect(checklist).toBeVisible();
			const androidUntested = checklist.locator('[data-confirmation="android-untested"]');
			await androidUntested.scrollIntoViewIfNeeded();
			await expect(androidUntested).toBeInViewport();
			await expect(androidUntested.getByRole('checkbox')).not.toBeChecked();
			await settleRendering(page);
			const nativePng = rgbPng(await page.screenshot({ animations: 'disabled', fullPage: false }));
			validateAsset(nativePng, '7-native-connect.png');
			await writeFile(`${directory}7-native-connect.png`, nativePng);
			expect(
				nativeBridge.calls.filter(({ methodName }) => methodName === 'requestDevice')
			).toHaveLength(1);
			expect(nativeBridge.calls.filter(({ methodName }) => methodName === 'sendReport')).toEqual([]);
			expect(nativeBridge.reports).toEqual([]);
		});
	});
}
