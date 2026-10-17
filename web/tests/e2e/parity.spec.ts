import { expect, test } from '@playwright/test';
import { openApp, waitForApp } from './helpers/a-app';
import { neutralPreset, officialPresets } from './helpers/a-presets';
import { barAction, barNavLink } from './helpers/b-ui';

test.describe('Official payload CRC parity', () => {
	test.describe.configure({ mode: 'parallel' });

	for (const preset of [...officialPresets, neutralPreset]) {
		test(`${preset.id}: Curva and Cabo display golden CRC ${preset.crc}`, async ({ page }) => {
			await openApp(page, '/');
			if (preset.id === 'neutro') {
				// The bar's preset (a "Carregar no editor" item, or the sheet's button on mobile).
				await (await barAction(page, 'Neutro')).click();
			} else {
				const button = page
					.getByRole('region', { name: 'Presets', exact: true })
					.getByRole('button', { name: preset.label, exact: true });
				await button.click();
				await expect(button).toHaveAttribute('aria-pressed', 'true');
			}

			// Curva's nameplate "No editor" state line is the visible CRC readout of the editor curve
			// (the preset card's description also quotes a CRC; the byte map renders raw LE bytes).
			const state = page.getByRole('main').getByTestId('editor-state');
			await expect(state).toBeVisible();
			await expect(state).toContainText(`CRC ${preset.crc}`);
			await (await barNavLink(page, 'Cabo')).click();
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
