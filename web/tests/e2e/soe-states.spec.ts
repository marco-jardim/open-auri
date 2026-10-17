// FUX.P3 · Soe como X states the default visual baseline does not reach (spec §1.4b):
// index loading, index failure with retry, no result, solver result, and the one-column mobile
// stack. Loading, failure and result run offline (mocked index route, pasted CSV, preset
// target). "No result" needs the real AutoEq index: CI without it sets OA_NO_AUTOEQ=1.
import { expect, test, type Page } from '@playwright/test';

const NO_AUTOEQ = process.env.OA_NO_AUTOEQ === '1';
const INDEX = '**/data/autoeq/index.json';
const CSV = 'frequency,raw\n20,4\n100,3\n300,1\n1000,0\n3000,2\n6000,-3\n10000,1\n20000,-6';

async function settle(page: Page) {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/soe-como-x');
	await expect(page.locator('#soe-title')).toBeVisible();
}

function shot(page: Page) {
	// Meters, canvases and attribution vary or animate: masked like visual.spec.ts.
	return {
		animations: 'disabled' as const,
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
		await settle(page);
		await page.locator('#soe-search').fill('zzzz sem fone algum');
		await expect(page.locator('.measurement .no-result')).toBeVisible();
		await expect(page.locator('.measurement')).toHaveScreenshot('soe-no-result.png', shot(page));
	});

	test('solver result: real passes, deviation map, A/B in DATA and editor hand-off', async ({
		page
	}) => {
		await page.route(INDEX, (route) => route.fulfill({ status: 503, body: 'offline' }));
		await settle(page);
		await page.locator('#soe-input-file + .zone + .actions button').click();
		await page.locator('#soe-input-text').fill(CSV);
		await page.locator('#soe-input-paste button').click();
		await page.locator('#soe-target-kind').selectOption('preset');
		await page.locator('.correction .solve').click();
		await expect(page.locator('.gate-pass')).toBeVisible({ timeout: 20_000 });
		await expect(page.locator('.monitor-head .iter')).toContainText('ITER');
		await expect(page.locator('.map svg[role="img"] rect').first()).toBeVisible();
		// No audio was started: meters are DATA, never live.
		await expect(page.locator('[data-tour="soe-ab"] [data-mode="live"]')).toHaveCount(0);
		await expect(page.locator('.workstation')).toHaveScreenshot('soe-result.png', shot(page));
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
