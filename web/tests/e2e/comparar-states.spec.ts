import { expect, test } from '@playwright/test';
import { installAudioProbe, loadSineFile } from './helpers/c-audio.ts';

/**
 * FUX.P2 states the shared visual spec cannot show: an armed lane playing a deterministic sine
 * with its VU live and unmasked, next to an unarmed lane that stays in DATA. Reels and the amber
 * head lamp must follow the real transport state.
 */
test.describe('comparar states', () => {
	test.use({ viewport: { width: 1440, height: 1000 } });

	test('armed lane playing shows a live, unmasked VU; unarmed lane stays DATA', async ({
		page
	}) => {
		await installAudioProbe(page);
		await page.goto('/comparar');
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		// Dismiss the first-visit tour so it cannot cover the lanes. It mounts lazily, so wait for it
		// before pressing Escape, and prove Escape really closes it.
		const tour = page.getByRole('button', { name: 'Pular tour', exact: true });
		await expect(tour).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(tour).toBeHidden();
		await loadSineFile(page);
		await page.keyboard.press('Escape');

		const deck = page.locator('.deck-svg');
		await expect(deck).toHaveAttribute('data-playing', 'false');
		const play = page.getByRole('button', { name: 'Ouvir A/B', exact: true });
		await expect(play).not.toHaveAttribute('aria-disabled', 'true');
		await play.click();
		await expect(page.getByRole('button', { name: 'Parar prévia', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(deck).toHaveAttribute('data-playing', 'true');

		const armed = page.locator('.lane').nth(0);
		const unarmed = page.locator('.lane').nth(4);
		await expect(armed.locator('.lane-read span')).toHaveText('AO VIVO', { timeout: 10_000 });
		await expect(armed.locator('.lane-read output')).toContainText('VU');
		await expect(unarmed.locator('.lane-read span')).toHaveText('DADOS');
		await expect(armed.locator('.trim')).toContainText('dB');

		// Steady sine: let the VU ballistics settle before the capture.
		await page.waitForTimeout(1500);
		await expect(armed).toHaveScreenshot('comparar-lane-armed-playing.png', {
			maxDiffPixelRatio: 0.02
		});
		// The unarmed lane sits next to a playing one: its DATA readout is steady, but a few
		// anti-aliased edge pixels (6 to 8) differ between runs, even right after an update.
		await expect(unarmed).toHaveScreenshot('comparar-lane-unarmed.png', {
			animations: 'disabled',
			maxDiffPixels: 40
		});
		await expect(page.locator('.deck')).toHaveScreenshot('comparar-deck-playing.png', {
			animations: 'disabled',
			maxDiffPixelRatio: 0.02
		});

		await page.getByRole('button', { name: 'Parar prévia', exact: true }).click();
		await expect(deck).toHaveAttribute('data-playing', 'false');
		await expect(armed.locator('.lane-read span')).toHaveText('DADOS');
	});
});
