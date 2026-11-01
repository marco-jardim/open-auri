import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { devices, type Page } from '@playwright/test';
import { test, expect, cableInfo, type NativeOptions } from './fixtures/capacitor-bridge';
import { settleRendering, waitForApp } from './helpers/a-app';
import { barNavLink } from './helpers/b-ui';
import { hidLog, installHidStub } from './helpers/b-hid';
import { rgbPng, validateAsset } from '../../../tools/play-assets.mjs';

// Opt-in only. From web, set CI=1, PLAY_SCREENSHOTS=1 and
// NODE_OPTIONS=--max-old-space-size=6144, then run:
// npx playwright test tests/e2e/play-screenshots.spec.ts --project=mobile --workers=1
// Add --grep 'phone', 'tablet-7', 'tablet-10' or 'desktop' for a single set.
// Follow with node tools/play-assets.mjs from the repository root.
test.skip(process.env.PLAY_SCREENSHOTS !== '1', 'Store capture requires PLAY_SCREENSHOTS=1');
test.beforeEach(() => {
	test.skip(
		test.info().project.name !== 'mobile',
		'Store capture runs once, in the mobile project'
	);
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

/** The set's fake Android app: the real Capacitor bridge on phone/tablet, none on desktop. */
const nativeOptionsFor = (set: (typeof sets)[number]): NativeOptions => ({
	enabled: set.name !== 'desktop',
	devices: [],
	appVersion: '1.0.0'
});

// Data report 1 also starts with 0x01; only the full command prefix identifies a flash commit.
const isCommit = ({ bytes }: { bytes: number[] }) =>
	bytes.slice(0, 5).join(',') === '1,101,0,1,255';

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
	// Retired one-phone notice (ANDROID_WRITE_VALIDATED is true): asserted absent, never captured.
	const title =
		locale === 'pt-BR'
			? 'Gravação pelo app: teste em um celular'
			: 'Writing from the app: tested on one phone';
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
				// No capture shows the retired one-phone modal or Cabo banner.
				await expect(page.getByRole('dialog', { name: title, exact: true })).toHaveCount(0);
				if (route === '/cabo') {
					if (set.name === 'desktop') {
						await expect(page.getByText('OA-01 · WebHID', { exact: true })).toBeVisible();
					}
					await expect(page.getByRole('complementary', { name: title, exact: true })).toHaveCount(
						0
					);
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
					type Box = NonNullable<typeof help>;
					const apart = (a: Box, b: Box) =>
						a.x >= b.x + b.width ||
						b.x >= a.x + a.width ||
						a.y >= b.y + b.height ||
						b.y >= a.y + a.height;
					expect(apart(help, kicker), 'Comparison help must not overlap the eyebrow').toBe(true);
					expect(apart(help, heading), 'Comparison help must not overlap the title').toBe(true);
					// The heading precedes the help in reading and tab order.
					const order = page.locator('.comparar .intro h1 ~ .intro-help');
					expect(await order.count(), 'Comparison help must follow the title').toBe(1);
					// Narrow layouts put the help on the eyebrow's row, above the title; wide layouts
					// keep it beside the title, right under the eyebrow (not pushed down by the help).
					if (set.name === 'phone') {
						expect(heading.y).toBeGreaterThanOrEqual(help.y + help.height);
					} else {
						expect(heading.y - (kicker.y + kicker.height)).toBeLessThanOrEqual(8);
					}
				}
				if (set.name !== 'phone') {
					if (route === '/soe-como-x') {
						// A real imported example and solver result fill the wide workstation, not blank plots.
						await page.locator('#soe-input-file + .zone + .actions button').click();
						await page
							.locator('#soe-input-text')
							.fill(
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

		// Desktop adds the same real comparison UI over the browser's fake WebHID boundary.
		if (set.name === 'desktop') {
			test('capture cable comparison', async ({ page }) => {
				await installHidStub(page);
				await page.goto('/cabo');
				await waitForApp(page);
				await page.getByRole('switch').click();
				await page
					.getByRole('button', {
						name: locale === 'pt-BR' ? 'Conectar via WebHID real' : 'Connect via real WebHID',
						exact: true
					})
					.click();
				await expect(page.locator('[data-state="connected"]')).toHaveAttribute(
					'aria-current',
					'step'
				);
				await captureComparison(page);
				expect((await hidLog(page)).reports.length).toBeGreaterThan(0);
				expect((await hidLog(page)).reports.some(isCommit)).toBe(false);
			});
		}

		async function captureComparison(page: Page) {
			await (await barNavLink(page, locale === 'pt-BR' ? 'Comparar' : 'Compare')).click();
			await expect(page).toHaveURL(/\/comparar(?:[?#]|$)/);
			const comparison = page.locator('[data-cable-ab]');
			await expect(
				comparison.getByRole('heading', {
					name: locale === 'pt-BR' ? 'Comparar no cabo' : 'Compare on the cable',
					exact: true
				})
			).toBeVisible();
			await expect(comparison).toContainText(
				locale === 'pt-BR'
					? 'A e B tocam no cabo, na memória, sem gravar. Ao desconectar, ele volta à curva salva.'
					: 'A and B play on the cable, in memory, without saving. Unplugged, it goes back to its saved curve.'
			);
			await comparison.locator('[data-cable-ab-start]').click();
			await comparison.locator('[data-confirmation="volume"] input').check();
			await expect(comparison.locator('[data-confirmation="android-untested"]')).toHaveCount(0);
			await comparison.locator('[data-cable-ab-go]').click();
			await expect(comparison.locator('[data-cable-ab-status]')).toHaveText(
				locale === 'pt-BR' ? 'No cabo: A' : 'On the cable: A'
			);
			await expect(comparison.getByRole('radio')).toHaveCount(2);
			await frameInstrument(page, '[data-cable-ab]');
			await expect(comparison).toBeInViewport({ ratio: 1 });
			const png = rgbPng(await page.screenshot({ animations: 'disabled', fullPage: false }));
			validateAsset(png, `${relative}8-cable-compare.png`);
			await writeFile(`${directory}8-cable-compare.png`, png);
		}

		// Desktop never captures the Android-only scene 7.
		if (set.name === 'desktop') return;
		test.describe('native USB', () => {
			// An app with the liveApply capability (1.0.3+): without it the native cable is not
			// live-capable, so neither the Ouvir no cabo switch (scene 7) nor the cable comparison
			// (scene 8) is shown. Only these scenes announce it; the browsing captures keep the default.
			test.use({ nativeOptions: { ...nativeOptionsFor(set), liveApply: true } });
			// More CSS room for the live/compare controls, still a 1080x1920 phone PNG.
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
				// The write checklist must never open in this scene. Checked after every step so a
				// failure names the step that opened it.
				const writeChecklist = page.getByRole('dialog', {
					name: /^(Antes de gravar|Before writing)$/
				});
				const noWriteChecklist = (step: string) =>
					expect(writeChecklist, `write checklist opened ${step}`).toHaveCount(0);
				await noWriteChecklist('on load');
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
				await settleRendering(page);
				await expect(usb.locator('.tag-strip')).toContainText('USB DSP Audio');
				// The one-phone notice was retired: no modal or banner on the connected Cabo panel.
				await expect(page.getByRole('dialog', { name: title, exact: true })).toHaveCount(0);
				await expect(page.getByRole('complementary', { name: title, exact: true })).toHaveCount(0);
				await noWriteChecklist('after connecting on Cabo');
				// The live switch is on Curva, not in U1. Navigate through the real UI to preserve
				// the selected native cable/session.
				expect(nativeBridge.reports).toEqual([]);
				await (await barNavLink(page, locale === 'pt-BR' ? 'Curva' : 'Curve')).click();
				await expect(page).toHaveURL(/\/(?:[?#].*)?$/);
				await noWriteChecklist('after navigating to Curva');
				const live = page.locator('[data-live-panel]');
				const liveSwitch = live.getByRole('switch', {
					name: locale === 'pt-BR' ? 'Ouvir no cabo' : 'Hear on the cable',
					exact: true
				});
				await liveSwitch.click();
				const checklist = page.locator('[data-live-checklist]');
				await expect(checklist).toBeVisible();
				await noWriteChecklist('with the Ouvir no cabo switch');
				await checklist.locator('[data-confirmation="volume"] input').check();
				await expect(checklist.locator('[data-confirmation="android-untested"]')).toHaveCount(0);
				await checklist.locator('[data-live-start]').click();
				await expect(checklist).not.toBeVisible();
				await noWriteChecklist('after Começar / Start');
				await expect(liveSwitch).toHaveAttribute('aria-checked', 'true');
				await expect(live.locator('[data-live-status]')).toContainText('USB DSP Audio');
				const save = live.getByRole('button', {
					name: locale === 'pt-BR' ? 'Salvar no cabo' : 'Save to cable',
					exact: true
				});
				await expect(save).toBeEnabled();
				await frameInstrument(page, '[data-live-panel]');
				await expect(liveSwitch).toBeInViewport({ ratio: 1 });
				await expect(save).toBeInViewport({ ratio: 1 });
				await noWriteChecklist('before the capture');
				const png = rgbPng(await page.screenshot({ animations: 'disabled', fullPage: false }));
				validateAsset(png, `${relative}7-native-connect.png`);
				await writeFile(`${directory}7-native-connect.png`, png);
				expect(
					nativeBridge.calls.filter(({ methodName }) => methodName === 'requestDevice')
				).toHaveLength(1);
				// Preview reports are allowed, but never the persistent-write commit (0x01).
				expect(nativeBridge.reports.length).toBeGreaterThan(0);
				expect(nativeBridge.reports.some(isCommit)).toBe(false);
				// End the editor preview via its real switch before starting a comparison.
				await liveSwitch.click();
				await live
					.getByRole('button', {
						name: locale === 'pt-BR' ? 'Manter até desconectar' : 'Keep until unplugged',
						exact: true
					})
					.click();
				await captureComparison(page);
				expect(nativeBridge.reports.some(isCommit)).toBe(false);
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
			nativeOptions: nativeOptionsFor(set)
		});
		for (const locale of ['pt-BR', 'en-US'] as const) describeLocale(set, locale);
	});
}
