// FUX.P3 · Soe como X states the default visual baseline does not reach (spec §1.4b):
// index loading, index failure with retry, no result, solver result, and the one-column mobile
// stack. Loading, failure and result run offline (mocked index route, pasted CSV, preset
// target). "No result" needs the real AutoEq index: CI without it sets OA_NO_AUTOEQ=1.
import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { waitForApp } from './helpers/a-app';

const noArt = fileURLToPath(new URL('./helpers/no-art.css', import.meta.url));
// The strict CSP blocks the style Playwright injects for stylePath; CSP is covered by csp.spec.ts.
test.use({ bypassCSP: true });

const NO_AUTOEQ = process.env.OA_NO_AUTOEQ === '1';
const INDEX = '**/data/autoeq/index.json';
const CSV = 'frequency,raw\n20,4\n100,3\n300,1\n1000,0\n3000,2\n6000,-3\n10000,1\n20000,-6';

async function settle(page: Page) {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/soe-como-x');
	await expect(page.locator('#soe-title')).toBeVisible();
	// The title is in the prerendered HTML; client-only state (the paste panel behind "Colar
	// texto") needs the hydrated page, so wait for the mounted client app as well.
	await waitForApp(page);
}

/** The Soe como X tour auto-opens on a first desktop visit; mark it dismissed (`oa.tour.v1`). */
async function dismissTour(page: Page) {
	await page.addInitScript(() => {
		if (!location.protocol.startsWith('http')) return;
		const stored = localStorage.getItem('oa.tour.v1');
		const tours: Record<string, string> = stored ? JSON.parse(stored) : {};
		tours['soe-como-x'] ??= 'dispensado';
		localStorage.setItem('oa.tour.v1', JSON.stringify(tours));
	});
}

function shot(page: Page) {
	// Meters, canvases and attribution vary or animate: masked like visual.spec.ts.
	return {
		animations: 'disabled' as const,
		stylePath: noArt,
		mask: [page.locator('canvas'), page.locator('[data-mode="live"]')]
	};
}

test.describe('Soe como X states', () => {
	test('loading the AutoEq index shows a skeleton with the final geometry', async ({ page }) => {
		await page.route(INDEX, () => new Promise<void>(() => undefined));
		await settle(page);
		await page.locator('#soe-search').focus();
		await expect(page.locator('.measurement [aria-busy="true"]')).toBeVisible();
		await expect(page.locator('.measurement')).toHaveScreenshot('soe-loading.png', shot(page));
	});

	test('index failure offers "Tentar de novo" and recovers', async ({ page }) => {
		let fail = true;
		await page.route(INDEX, async (route) => {
			if (fail) await route.fulfill({ status: 503, body: 'offline' });
			else await route.continue();
		});
		await settle(page);
		await page.locator('#soe-search').focus();
		const missing = page.locator('.missing');
		await expect(missing).toBeVisible();
		await expect(missing).toHaveScreenshot('soe-failure.png', shot(page));
		fail = false;
		test.skip(NO_AUTOEQ, 'recovery needs the AutoEq index (OA_NO_AUTOEQ=1)');
		await missing.getByRole('button').click();
		await expect(page.locator('#soe-measurement')).toBeVisible();
	});

	test('no result teaches what to type', async ({ page }) => {
		test.skip(NO_AUTOEQ, 'needs the AutoEq index (OA_NO_AUTOEQ=1)');
		// The desktop tour's first step highlights this very station (`data-tour-active`); its lazy
		// chunk opens it sooner or later depending on load, so the capture (whose baseline has no
		// tour) only stays deterministic with the tour dismissed.
		await dismissTour(page);
		await settle(page);
		await page.locator('#soe-search').fill('zzzz sem fone algum');
		await expect(page.locator('.measurement .no-result')).toBeVisible();
		await expect(page.locator('.measurement')).toHaveScreenshot('soe-no-result.png', shot(page));
	});

	test('solver result: real passes, deviation map, A/B in DATA and editor hand-off', async ({
		page
	}) => {
		// This case drives the import and target stations and captures the whole workstation: the
		// tour panel must not sit over them (nor in the new soe-result.png baseline).
		await dismissTour(page);
		await page.route(INDEX, (route) => route.fulfill({ status: 503, body: 'offline' }));
		await settle(page);
		// The measurement import's "Colar texto" toggle opens the paste panel (FUX.P3).
		const paste = page.locator('#soe-input-file + .zone + .actions button');
		await paste.click();
		await expect(paste).toHaveAttribute('aria-expanded', 'true');
		await page.locator('#soe-input-text').fill(CSV);
		await page.locator('#soe-input-paste button').click();
		await page.locator('#soe-target-kind').selectOption('preset');
		await page.locator('.correction .solve').click();
		await expect(page.locator('.gate-pass')).toBeVisible({ timeout: 20_000 });
		const workstation = page.locator('.workstation');
		await expect(workstation).toHaveAttribute('data-phase', 'result');
		// The final row of the deviation map is the full solve: the readout shows that pass.
		const finalPass = page.locator('.map-iterations li').last();
		await expect(page.locator('.monitor-head .iter')).toContainText(
			`ITER ${(await finalPass.textContent())?.trim()} /`
		);
		await expect(page.locator('.map svg[role="img"] rect').first()).toBeVisible();
		// No audio was started: meters are DATA, never live (and the idle spectrum draws nothing).
		await expect(page.locator('[data-tour="soe-ab"] [data-mode="live"]')).toHaveCount(0);
		await expect(workstation.locator('[data-mode="live"]')).toHaveCount(0);
		// Late chunks settle the result station: the chrome's audio engine and the editor curve
		// (they enable "Ouvir prévia" and "Usar esta curva"), and SocialPublish's sign-in link.
		await expect(page.locator('[data-tour="soe-ab"] .buttons button').first()).not.toHaveAttribute(
			'aria-disabled',
			'true'
		);
		await expect(page.locator('[data-tour="soe-editor"] button').first()).not.toHaveAttribute(
			'aria-disabled',
			'true'
		);
		await expect(workstation.locator('a[href^="/entrar"]')).toBeVisible();
		// Whichever control happens to hold focus (RESOLVER, or the skip link, which only shows
		// when focused) is not part of this state. Same focus on every run: none.
		await page.evaluate(() => {
			if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
		});
		// The workstation is taller than the viewport (always on mobile, often on desktop), and a
		// taller capture is shot beyond it at whatever scroll offset Playwright reached: the
		// viewport-fixed layers (Playwright's mask overlays, like the bar in no-art.css) landed
		// elsewhere on each shot and the rounded clip changed by 1 px (3844/3845). That, not the
		// page, was "two consecutive stable screenshots" failing. A viewport that holds the whole
		// workstation keeps the capture from scrolling, and nothing is masked: in this state
		// nothing in it is live (asserted above).
		const viewport = page.viewportSize();
		const bottom = await workstation.evaluate(
			(element) => element.getBoundingClientRect().bottom + window.scrollY
		);
		if (viewport) {
			await page.setViewportSize({
				width: viewport.width,
				height: Math.max(viewport.height, Math.ceil(bottom) + 32)
			});
		}
		await page.evaluate(() => window.scrollTo(0, 0));
		await expect(workstation).toHaveScreenshot('soe-result.png', {
			animations: 'disabled',
			stylePath: noArt,
			maxDiffPixels: 40
		});
	});

	test('mobile stacks measurement and target in one column', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.route(INDEX, (route) => route.fulfill({ status: 503, body: 'offline' }));
		await settle(page);
		const measurement = await page.locator('.station.measurement').boundingBox();
		const target = await page.locator('.station.target').boundingBox();
		expect(measurement && target).toBeTruthy();
		if (!measurement || !target) return;
		expect(Math.abs(measurement.x - target.x)).toBeLessThan(2);
		expect(target.y).toBeGreaterThan(measurement.y + measurement.height - 2);
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(0);
	});
});
