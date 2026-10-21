import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { devices, type Page } from '@playwright/test';
import { test, expect, cableInfo } from './fixtures/capacitor-bridge';
import { settleRendering, waitForApp } from './helpers/a-app';
import { rgbPng, validateAsset } from '../../../tools/play-assets.mjs';

// Opt-in only. From web, set CI=1, PLAY_SCREENSHOTS=1 and
// NODE_OPTIONS=--max-old-space-size=6144, then run:
// npx playwright test tests/e2e/play-screenshots.spec.ts --project=mobile --workers=1
// Add --grep 'phone', 'tablet-7', 'tablet-10' or 'desktop' for a single set.
// Follow with node tools/play-assets.mjs from the repository root.
test.skip(process.env.PLAY_SCREENSHOTS !== '1', 'Store capture requires PLAY_SCREENSHOTS=1');
test.beforeEach(() => {
	test.skip(test.info().project.name !== 'mobile', 'Store capture runs once, in the mobile project');
});
test.use({
	reducedMotion: 'reduce',
	colorScheme: 'dark'
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

const sets = [
	{ name: 'phone', viewport: { width: 360, height: 640 }, deviceScaleFactor: 3 },
	{ name: 'tablet-7', viewport: { width: 720, height: 1280 }, deviceScaleFactor: 1.5 },
	{ name: 'tablet-10', viewport: { width: 900, height: 1600 }, deviceScaleFactor: 1.6 },
	{ name: 'desktop', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 }
] as const;

/** Frame the actual instruments below fixed chrome, without altering the UI or capture size. */
async function frameInstrument(page: Page, selector: string) {
	const instrument = page.locator(selector);
	await expect(instrument).toBeVisible();
	await instrument.evaluate((element) => {
		const bar = document.querySelector('[data-chrome="bar"]');
		const banner = document.querySelector('.room > .banner');
		if (!bar) throw new Error('Missing store capture app bar');
		window.scrollBy({
			top:
				element.getBoundingClientRect().top -
				bar.getBoundingClientRect().bottom -
				(banner?.getBoundingClientRect().height ?? 0) -
				12,
			behavior: 'instant'
		});
	});
	await settleRendering(page);
	const bounds = await instrument.boundingBox();
	const viewport = page.viewportSize();
	if (!bounds || !viewport) throw new Error('Missing store capture viewport');
	expect(bounds.x, 'Instrument must not overflow the left edge').toBeGreaterThanOrEqual(0);
	expect(bounds.x + bounds.width, 'Instrument must fit the wide viewport').toBeLessThanOrEqual(
		viewport.width
	);
}

function describeLocale(set: (typeof sets)[number], locale: 'pt-BR' | 'en-US') {
	const relative = `screenshots/${locale}/${set.name === 'phone' ? '' : `${set.name}/`}`;
	const directory = fileURLToPath(
		new URL(`../../../docs/android/play-assets/${relative}`, import.meta.url)
	);
	const title =
		locale === 'pt-BR'
			? 'Gravação pelo app ainda não testada num cabo'
			: 'Writing from the app has not been tested on a cable yet';
	test.describe(locale, () => {
		test.use({ locale });
		test.beforeEach(async ({ context, baseURL }) => {
			if (!baseURL) throw new Error('Store capture requires Playwright use.baseURL');
			await context.addCookies([{ name: 'oa_lang', value: locale, url: baseURL }]);
			if (set.name !== 'phone') {
				// Large layouts auto-open more tours. Dismiss them via the same persisted user choice.
				await context.addInitScript(() => {
					localStorage.setItem(
						'oa.tour.v1',
						JSON.stringify({
							curva: 'dispensado',
							cabo: 'dispensado',
							comparar: 'dispensado',
							'soe-como-x': 'dispensado',
							comunidade: 'dispensado',
							'teste-cego': 'dispensado'
						})
					);
				});
			}
			await mkdir(directory, { recursive: true });
		});
		test('capture browsing store screenshots', async ({ page, nativeBridge }) => {
			for (const [route, name] of routes) {
				const response = await page.goto(route);
				expect(response?.status(), `${route} must return HTTP 200`).toBe(200);
				await waitForApp(page);
				await expect(page.locator('html')).toHaveAttribute('lang', locale);
				if (route === '/' && set.name !== 'desktop') {
					const notice = page.getByRole('dialog', { name: title, exact: true });
					await expect(notice).toBeVisible();
					await notice
						.getByRole('button', { name: locale === 'pt-BR' ? 'Entendi' : 'Got it', exact: true })
						.click();
					await expect(notice).not.toBeVisible();
				}
				if (route === '/cabo') {
					// Preserve the real app's untested-writing banner, not a browser-only view.
					if (set.name !== 'desktop') {
						await expect(
							page.getByRole('complementary', { name: title, exact: true })
						).toBeVisible();
					} else {
						await expect(page.getByText('OA-01 · WebHID', { exact: true })).toBeVisible();
						await expect(
							page.getByRole('complementary', { name: title, exact: true })
						).toHaveCount(0);
					}
				}
				await settleRendering(page);
				await page.evaluate(async () => {
					await document.fonts.ready;
					await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => {})));
					window.scrollTo(0, 0);
				});
				if (route === '/comparar') {
					const help = await page.locator('.comparar .intro-help').boundingBox();
					const kicker = await page.locator('.comparar .kicker').boundingBox();
					const heading = await page.getByRole('heading', { level: 1 }).boundingBox();
					if (!help || !kicker || !heading) throw new Error('Missing comparison header');
					expect(
						help.x >= kicker.x + kicker.width ||
							kicker.x >= help.x + help.width ||
							help.y >= kicker.y + kicker.height ||
							kicker.y >= help.y + help.height,
						'Comparison help must not overlap the eyebrow'
					).toBe(true);
					expect(heading.y).toBeGreaterThanOrEqual(help.y + help.height);
				}
				if (set.name !== 'phone') {
					if (route === '/soe-como-x') {
						// A real imported example and solver result fill the wide workstation, not blank plots.
						await page.locator('#soe-input-file + .zone + .actions button').click();
						await page.locator('#soe-input-text').fill(
							'frequency,raw\n20,4\n100,3\n300,1\n1000,0\n3000,2\n6000,-3\n10000,1\n20000,-6'
						);
						await page.locator('#soe-input-paste button').click();
						await page.locator('#soe-target-kind').selectOption('preset');
						await page.locator('.correction .solve').click();
						await expect(page.locator('.workstation')).toHaveAttribute('data-phase', 'result', {
							timeout: 20_000
						});
						await expect(page.locator('.gate-pass')).toBeVisible();
					}
					if (route === '/comunidade') {
						// An empty local feed still has the app's clearly labelled example preset strips.
						await expect(page.locator('.oa-comunidade .bank:not(.skel-bank)')).toBeVisible({
							timeout: 20_000
						});
					}
					const frame = {
						'/': set.name === 'desktop' ? '.curva .instrument' : '.curva .nameplate',
						'/cabo': '.room .rack',
						'/comparar': '.comparar .lanes',
						'/soe-como-x': '.soe-page .workstation',
						'/comunidade': '.oa-comunidade .console',
						'/teste-cego': '.blind-test .desk'
					}[route];
					await frameInstrument(page, frame);
				}
				const png = rgbPng(await page.screenshot({ animations: 'disabled', fullPage: false }));
				validateAsset(png, `${relative}${name}.png`);
				await writeFile(`${directory}${name}.png`, png);
			}
			// The six browsing captures must not request even simulated USB permission.
			expect(nativeBridge.reports).toEqual([]);
			expect(
				nativeBridge.calls.filter(({ methodName }) =>
					['requestDevice', 'open', 'sendReport'].includes(methodName)
				)
			).toEqual([]);
			if (set.name === 'desktop') expect(nativeBridge.calls).toEqual([]);
		});

		// Desktop has six browser scenes, never an Android-only USB capture.
		if (set.name === 'desktop') return;
		test.describe('native USB', () => {
			// More CSS room for U1 and the sticky notice, still a 1080x1920 phone PNG.
			if (set.name === 'phone') {
				test.use({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2 });
			}
			test('capture connected Android USB', async ({ page, nativeBridge }) => {
				// Real Capacitor bridge, fake cable. Connecting must never write any reports.
				await nativeBridge.connect(cableInfo());
				const response = await page.goto('/cabo');
				expect(response?.status()).toBe(200);
				await waitForApp(page);
				await expect(page.locator('html')).toHaveAttribute('lang', locale);
				const notice = page.getByRole('dialog', { name: title, exact: true });
				await expect(notice).toBeVisible();
				await notice
					.getByRole('button', { name: locale === 'pt-BR' ? 'Entendi' : 'Got it', exact: true })
					.click();
				await expect(notice).not.toBeVisible();
				const usb = page.getByRole('region', { name: /^U1/ });
				const model = usb.getByText(
					locale === 'pt-BR' ? 'OA-01 · USB Android' : 'OA-01 · Android USB',
					{ exact: true }
				);
				await expect(model).toBeVisible();
				await expect(
					usb.getByText(
						locale === 'pt-BR'
							? 'App Android v1.0.0, USB host OK'
							: 'Android app v1.0.0, USB host OK',
						{ exact: true }
					)
				).toBeVisible();
				await usb
					.getByRole('button', {
						name: locale === 'pt-BR' ? 'Conectar pelo USB do Android' : 'Connect over Android USB',
						exact: true
					})
					.click();
				const connected = usb.locator('[data-state="connected"]');
				await expect(connected).toHaveAttribute('aria-current', 'step');
				await expect(connected).toHaveClass(/\bon\b/);
				const banner = page.getByRole('complementary', { name: title, exact: true });
				await expect(banner).toBeVisible();
				await settleRendering(page);
				// Scroll the actual page, without hiding/repositioning UI or opening the checklist.
				await usb.evaluate((unit) => {
					const notice = document.querySelector('.room > .banner');
					const bar = document.querySelector('[data-chrome="bar"]');
					if (!notice || !bar) throw new Error('Missing native capture framing elements');
					window.scrollBy({
						top:
							unit.getBoundingClientRect().top -
							bar.getBoundingClientRect().bottom -
							notice.getBoundingClientRect().height -
							12,
						behavior: 'instant'
					});
				});
				await settleRendering(page);
				await expect(banner).toBeInViewport({ ratio: 1 });
				await expect(model).toBeInViewport({ ratio: 1 });
				await expect(connected).toBeInViewport({ ratio: 1 });
				await expect(usb.locator('.tag-strip')).toContainText('USB DSP Audio');
				await expect(usb.locator('.tag-strip')).toBeInViewport({ ratio: 1 });
				await expect(
					page.getByRole('dialog', { name: /^(Antes de gravar|Before writing)$/ })
				).not.toBeVisible();
				const png = rgbPng(await page.screenshot({ animations: 'disabled', fullPage: false }));
				validateAsset(png, `${relative}7-native-connect.png`);
				await writeFile(`${directory}7-native-connect.png`, png);
				expect(
					nativeBridge.calls.filter(({ methodName }) => methodName === 'requestDevice')
				).toHaveLength(1);
				// Connecting only picks and authorizes the device; nothing opens it before a write.
				expect(nativeBridge.calls.filter(({ methodName }) => methodName === 'open')).toHaveLength(
					0
				);
				expect(nativeBridge.calls.filter(({ methodName }) => methodName === 'sendReport')).toEqual(
					[]
				);
				expect(nativeBridge.reports).toEqual([]);
			});
		});
	});
}

for (const set of sets) {
	test.describe(set.name, () => {
		test.use({
			viewport: set.viewport,
			deviceScaleFactor: set.deviceScaleFactor,
			// Tablets keep the Pixel touch/Android UA. Desktop must use the browser WebHID view.
			...(set.name === 'desktop'
				? { isMobile: false, hasTouch: false, userAgent: devices['Desktop Chrome'].userAgent }
				: {}),
			nativeOptions: { enabled: set.name !== 'desktop', devices: [], appVersion: '1.0.0' }
		});
		for (const locale of ['pt-BR', 'en-US'] as const) describeLocale(set, locale);
	});
}
