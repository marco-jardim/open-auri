// FUX.P4: Comunidade states that the default capture of visual.spec.ts does not reach.
//   - the empty console that teaches (spec §4.4): the §4.4 text, the publish action and three
//     EXAMPLE strips of official presets, "exemplo, não publicado" (feed answered empty);
//   - the publishing desk with the technical sheet opened (it is collapsed by default, §4.1).
// Every guided tour starts dismissed (`oa.tour.v1`) so no popover covers the capture; the wall clock
// is fixed so the sheet's `createdAt` keeps the same wrapping (the sheet itself is masked).
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { openApp, settleRendering } from './helpers/a-app';
import { dynamicRegions } from './helpers/a-visual';

const visualCss = fileURLToPath(new URL('./helpers/visual.css', import.meta.url));

/** Constant wall clock of the capture (2026-01-01T00:00:00Z). */
const EPOCH = Date.UTC(2026, 0, 1);

const TOURS_DISMISSED = JSON.stringify({
	curva: 'dispensado',
	comunidade: 'dispensado',
	cabo: 'dispensado',
	'soe-como-x': 'dispensado',
	comparar: 'dispensado',
	'teste-cego': 'dispensado',
	biblioteca: 'dispensado'
});

const EMPTY_FEED = { sort: 'new', window: null, computedAt: null, items: [], nextCursor: null };

/** Runs before any app code: a fixed `Date` (timers and `performance.now` untouched). */
function fixedClock(epoch: number): void {
	const RealDate = Date;
	class FixedDate extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) super(epoch);
			else super(...(args as [number]));
		}
		static override now(): number {
			return epoch;
		}
	}
	Object.defineProperty(window, 'Date', { value: FixedDate, configurable: true, writable: true });
}

async function openEmptyCommunity(page: Page): Promise<void> {
	await page.addInitScript(fixedClock, EPOCH);
	await page.addInitScript((value) => {
		if (location.protocol.startsWith('http')) localStorage.setItem('oa.tour.v1', value);
	}, TOURS_DISMISSED);
	await page.route('**/api/v1/feed**', (route) => route.fulfill({ json: EMPTY_FEED }));
	await openApp(page, '/comunidade');
	await settleRendering(page);
	// The decorative art (LazyArt) arrives on idle, at the latest after 2 s; under a loaded
	// machine idle comes late, so a capture could race it. Wait for the layer (the state the
	// baselines show); `animations: 'disabled'` then freezes its motion in the capture.
	await expect(page.locator('.art-layer').first()).toBeAttached({ timeout: 15_000 });
	await settleRendering(page);
}

test.describe('comunidade states', () => {
	test.use({ reducedMotion: 'reduce' });

	test('empty console: §4.4 text, publish action and three EXAMPLE strips', async ({
		page
	}, testInfo) => {
		await openEmptyCommunity(page);
		const desk = page.locator('[data-tour="comunidade-channels"]');
		await expect(desk.getByTestId('feed-empty')).toBeVisible();
		await expect(desk.getByTestId('example-strip')).toHaveCount(3);
		await expect(desk.locator('a[href="#publicar"]')).toBeVisible();
		await expect(desk).toHaveScreenshot(`comunidade-empty-console-${testInfo.project.name}.png`, {
			animations: 'disabled',
			caret: 'hide',
			mask: dynamicRegions(page),
			maxDiffPixelRatio: 0.02,
			stylePath: visualCss
		});
	});

	test('publishing desk with the technical sheet opened', async ({ page }, testInfo) => {
		await openEmptyCommunity(page);
		const desk = page.locator('#publicar');
		const sheet = desk.getByTestId('ficha-tecnica');
		await expect(sheet).not.toHaveAttribute('open');
		await sheet.locator('summary').click();
		await expect(sheet).toHaveAttribute('open', '');
		await expect(desk.getByTestId('onair-s5')).toBeVisible();
		await expect(desk).toHaveScreenshot(`comunidade-ficha-open-${testInfo.project.name}.png`, {
			animations: 'disabled',
			caret: 'hide',
			mask: [...dynamicRegions(page), desk.getByTestId('onair-s5')],
			maxDiffPixelRatio: 0.02,
			stylePath: visualCss
		});
	});
});
