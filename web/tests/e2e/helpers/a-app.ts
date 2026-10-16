import { expect, type Page } from '@playwright/test';

/** The shared cable-status control is disabled in SSR and enabled by the mounted client app. */
export async function waitForApp(page: Page): Promise<void> {
	await expect(page.locator('#main-content')).toBeVisible();
	await expect(page.locator('[data-chrome="bar"] button[popovertarget]')).toBeEnabled();
}

export async function openApp(page: Page, path: string): Promise<void> {
	const response = await page.goto(path);
	expect(response?.status(), `${path} must return HTTP 200`).toBe(200);
	await waitForApp(page);
}

export async function settleRendering(page: Page): Promise<void> {
	// Background workers, prefetching and SW updates need not become globally network-idle.
	// Readiness comes from the mounted UI, loaded fonts and two painted frames instead.
	await waitForApp(page);
	const pathname = new URL(page.url()).pathname;
	if (pathname === '/biblioteca') {
		// This readout starts at ∅ and becomes numeric when the finite gate calculation completes.
		await expect(
			page.getByRole('img', { name: /^(Pico de saída|Output peak):/ })
		).toHaveAccessibleName(/: [−+]?\d+[,.]\d+ dB$/);
	} else if (pathname === '/soe-como-x') {
		// Wait for the initial AutoEq request to finish, including its unavailable-data UI.
		await expect(
			page.getByRole('combobox', { name: /^(Selecionar medição|Select measurement)$/ })
		).toBeEnabled();
	}
	await page.evaluate(async () => {
		await document.fonts.ready;
		await new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		});
	});
}
