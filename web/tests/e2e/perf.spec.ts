import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openApp, settleRendering } from './helpers/a-app';
import {
	finishDragRecording,
	installLcpObserver,
	nextFrame,
	readLcp,
	startDragRecording
} from './helpers/a-performance';

/**
 * Frame-paced Ajustar drag of filter 2 (Auri preset), `rate`× CPU-throttled through CDP when
 * above 1, checked against the frame and long-task budgets.
 */
async function expectDragWithinBudgets(page: Page, testInfo: TestInfo, rate = 1): Promise<void> {
	await openApp(page, '/?camada=ajustar');
	await expect(page.getByRole('main')).toHaveAttribute('data-layer', 'ajustar');
	await page
		.getByRole('region', { name: 'Presets', exact: true })
		.getByRole('button', { name: 'Auri', exact: true })
		.click();
	await settleRendering(page);
	expect(
		await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes('longtask'))
	).toBe(true);

	const handle = page
		.getByRole('group', { name: 'Alças dos filtros', exact: true })
		.getByRole('slider', { name: /^Filtro 2: PK/ });
	await expect(handle).toHaveAttribute('aria-disabled', 'false');
	await handle.scrollIntoViewIfNeeded();
	const box = await handle.boundingBox();
	if (!box) throw new Error('The editable filter handle has no bounding box');
	const initialFrequency = await handle.getAttribute('aria-valuenow');
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	const session = rate > 1 ? await page.context().newCDPSession(page) : null;
	let recording: Awaited<ReturnType<typeof finishDragRecording>>;
	try {
		await session?.send('Emulation.setCPUThrottlingRate', { rate });
		await page.mouse.move(x, y);
		await startDragRecording(page);
		await page.mouse.down();
		await expect(handle).toHaveClass(/dragging/);
		try {
			// Frame-paced real pointer events exercise the worker-backed drag, even on mobile Chromium.
			for (let step = 1; step <= 72; step++) {
				const progress = step / 72;
				await page.mouse.move(x + 18 * progress, y + 8 * Math.sin(progress * Math.PI));
				await nextFrame(page);
			}
		} finally {
			await page.mouse.up();
		}
		recording = await finishDragRecording(page);
	} finally {
		await session?.send('Emulation.setCPUThrottlingRate', { rate: 1 });
		await session?.detach();
	}
	await expect(handle).not.toHaveAttribute('aria-valuenow', initialFrequency ?? '');
	expect(
		recording.deltas.length,
		'At least 30 rendered frame intervals must be measured'
	).toBeGreaterThanOrEqual(30);
	const sorted = [...recording.deltas].sort((left, right) => left - right);
	const mean = recording.deltas.reduce((sum, value) => sum + value, 0) / recording.deltas.length;
	const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
	await testInfo.attach(rate > 1 ? `drag-performance-cpu-x${rate}` : 'drag-performance', {
		body: JSON.stringify({ rate, mean, p95, ...recording }, null, 2),
		contentType: 'application/json'
	});
	const longTasks = recording.tasks.filter(({ duration }) => duration > 50);
	// PO decision (2026-10-18): the GitHub runner (2 vCPU, software raster) sits right at the frame
	// budget, so CI only reports the numbers (attachment + annotation). Every local and pre-push
	// run enforces the budgets.
	if (process.env.CI) {
		const within = mean < 20 && p95 < 50 && longTasks.length === 0;
		testInfo.annotations.push({
			type: within ? 'perf' : 'perf-over-budget',
			description: `drag mean ${mean.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, long tasks ${longTasks.length} (budgets: < 20 ms, < 50 ms, none)`
		});
		return;
	}
	expect.soft(mean, 'Mean rAF interval during drag must be < 20 ms').toBeLessThan(20);
	expect.soft(p95, 'p95 rAF interval during drag must be < 50 ms').toBeLessThan(50);
	expect(longTasks, 'No main-thread task during the drag may exceed 50 ms').toEqual([]);
}

// Manifest/JS-size budgets are checked separately by scripts/check-budgets.mjs.
test.describe('Browser performance budgets', () => {
	// One measurement at a time inside each perf project (see playwright.config.ts).
	test.describe.configure({ mode: 'serial' });
	test.use({ reducedMotion: 'reduce' });
	test.setTimeout(60000);
	test.beforeEach(({ browserName }) => {
		test.skip(browserName !== 'chromium', 'Long Tasks and CDP throttling require Chromium');
	});

	test('Ajustar handle drag stays within frame and long-task budgets', async ({
		page
	}, testInfo) => {
		await expectDragWithinBudgets(page, testInfo);
	});

	for (const path of ['/', '/docs'] as const) {
		test(`${path} LCP is below 2500 ms on a cold 4G connection`, async ({ page }, testInfo) => {
			const session = await page.context().newCDPSession(page);
			try {
				await session.send('Network.enable');
				await session.send('Network.setCacheDisabled', { cacheDisabled: true });
				await session.send('Network.setBypassServiceWorker', { bypass: true });
				await session.send('Network.emulateNetworkConditions', {
					offline: false,
					latency: 150,
					// CDP expects bytes/s: 1.6 Mbps down and 750 kbps up.
					downloadThroughput: (1.6 * 1000000) / 8,
					uploadThroughput: 750000 / 8,
					connectionType: 'cellular4g'
				});
				await installLcpObserver(page);
				await page.bringToFront();
				await openApp(page, path);
				// No clicks or scrolls: user input would prematurely finalize LCP.
				await settleRendering(page);
				await expect.poll(async () => (await readLcp(page)).value).not.toBeNull();
				const lcp = await readLcp(page);
				expect(lcp.supported).toBe(true);
				await testInfo.attach('lcp-4g', {
					body: JSON.stringify({ path, latencyMs: 150, downloadMbps: 1.6, ...lcp }, null, 2),
					contentType: 'application/json'
				});
				if (lcp.value === null) throw new Error(`No LCP entry was observed on ${path}`);
				expect(lcp.value, `${path} cold-load LCP on 4G`).toBeLessThan(2500);
			} finally {
				await session.detach();
			}
		});
	}
});
