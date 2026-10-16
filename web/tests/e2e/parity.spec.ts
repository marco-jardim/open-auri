import { expect, test } from '@playwright/test';
import { openApp, waitForApp } from './helpers/a-app';
import { neutralPreset, officialPresets } from './helpers/a-presets';

test.describe('Official payload CRC parity', () => {
	test.describe.configure({ mode: 'parallel' });

	for (const preset of [...officialPresets, neutralPreset]) {
		test(`${preset.id}: Curva and Cabo display golden CRC ${preset.crc}`, async ({ page }) => {
			await openApp(page, '/');
			if (preset.id === 'neutro') {
				await page.getByRole('banner').getByRole('button', { name: 'Neutro', exact: true }).click();
			} else {
				const button = page
					.getByRole('region', { name: 'Presets', exact: true })
					.getByRole('button', { name: preset.label, exact: true });
				await button.click();
				await expect(button).toHaveAttribute('aria-pressed', 'true');
			}

			// Curva's nameplate is the visible CRC readout; the byte map renders raw LE bytes.
			await expect(page.getByRole('main').getByText(/\bCRC 0x[0-9a-f]{4}\b/i)).toContainText(
				`CRC ${preset.crc}`
			);
			await page
				.getByRole('navigation', { name: 'Principal', exact: true })
				.getByRole('link', { name: 'Cabo', exact: true })
				.click();
			await expect(page).toHaveURL(/\/cabo$/);
			await waitForApp(page);
			const main = page.locator('#main-content');
			// Neutro is a preset in the editor but not an official option in Cabo's selector.
			if (preset.id !== 'neutro') {
				await expect(
					main.getByRole('combobox', { name: 'Carregar preset no editor (não grava)', exact: true })
				).toHaveValue(preset.id);
			}
			await expect(main.getByText(/^CRC16-CCITT-FALSE 0x[0-9a-f]{4}$/i)).toHaveText(
				`CRC16-CCITT-FALSE ${preset.crc}`
			);
		});
	}

	for (const preset of officialPresets) {
		test(`Cabo's preset selector encodes ${preset.id} as ${preset.crc}`, async ({ page }) => {
			await openApp(page, '/cabo');
			const main = page.locator('#main-content');
			await main
				.getByRole('combobox', { name: 'Carregar preset no editor (não grava)', exact: true })
				.selectOption(preset.id);
			await expect(main.getByText(/^CRC16-CCITT-FALSE 0x[0-9a-f]{4}$/i)).toHaveText(
				`CRC16-CCITT-FALSE ${preset.crc}`
			);
		});
	}
});
