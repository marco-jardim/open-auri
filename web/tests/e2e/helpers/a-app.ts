import { expect, type Page } from '@playwright/test';

/**
 * FUX.2: the client runtime is a dynamic chunk. The layout imports it at once on instrument
 * routes and on idle (requestIdleCallback, 1500 ms timeout) on static and auth routes, then
 * publishes the app; only then does the bar render the cable-status trigger (a skeleton before).
 * With the whole suite sharing the machine (and `wrangler dev` retrying dropped chunk
 * connections) that can take longer than the default 5 s expect timeout, so the wait is explicit.
 */
export const RUNTIME_READY_TIMEOUT_MS = 20_000;

/**
 * Hydrated and the runtime mounted: the layout's `.app-root[data-runtime]` reaches `ready`
 * (`error` ends the wait at once and fails with a clear message), then the bar's status trigger.
 */
export async function waitForApp(page: Page): Promise<void> {
	await expect(page.locator('#main-content')).toBeVisible();
	const root = page.locator('.app-root');
	await expect(root).toHaveAttribute('data-runtime', /^(ready|error)$/, {
		timeout: RUNTIME_READY_TIMEOUT_MS
	});
	await expect(root, 'the app runtime failed to load').toHaveAttribute('data-runtime', 'ready');
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
