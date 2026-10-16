import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';
import { openApp, settleRendering } from './helpers/a-app';
import { routes } from './helpers/a-routes';

async function expectVisibleKeyboardFocus(control: Locator): Promise<void> {
	await expect(control).toBeFocused();
	const focus = await control.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			visible: element.matches(':focus-visible'),
			outline: style.outlineStyle,
			width: Number.parseFloat(style.outlineWidth),
			color: style.outlineColor
		};
	});
	expect(focus.visible).toBe(true);
	expect(focus.outline).not.toBe('none');
	expect(focus.width).toBeGreaterThanOrEqual(2);
	expect(focus.color).not.toBe('rgba(0, 0, 0, 0)');
}

test.describe('WCAG 2.2 AA', () => {
	test.describe.configure({ mode: 'parallel' });

	for (const route of routes) {
		test(`${route.path} has no serious or critical axe violations`, async ({ page }) => {
			await openApp(page, route.path);
			await settleRendering(page);
			const result = await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
				.analyze();
			const violations = result.violations.filter(
				(violation) => violation.impact === 'serious' || violation.impact === 'critical'
			);
			expect(
				violations,
				JSON.stringify(
					violations.map(({ id, impact, nodes }) => ({
						id,
						impact,
						nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary }))
					})),
					null,
					2
				)
			).toEqual([]);
		});
	}

	test('Curva layers support shortcuts, Tab, arrow keys and visible keyboard focus', async ({
		page
	}) => {
		await openApp(page, '/?camada=ouvir');
		const main = page.getByRole('main');
		const layers = page.getByRole('radiogroup', { name: 'Camada', exact: true });
		const options = [
			{ key: '1', name: 'Ouvir', layer: 'ouvir' },
			{ key: '2', name: 'Ajustar', layer: 'ajustar' },
			{ key: '3', name: 'Engenharia', layer: 'engenharia' }
		] as const;

		for (const option of options) {
			await page.keyboard.press(option.key);
			await expect(main).toHaveAttribute('data-layer', option.layer);
			await expect(layers.getByRole('radio', { name: option.name, exact: true })).toBeChecked();
		}

		await page.keyboard.press('1');
		const ouvir = layers.getByRole('radio', { name: 'Ouvir', exact: true });
		await expect(main).toHaveAttribute('data-layer', 'ouvir');
		await expect(ouvir).toBeChecked();
		// Start at the document, not locator.focus(): the layer control must be in the real tab order.
		let reached = false;
		for (let index = 0; index < 50; index++) {
			await page.keyboard.press('Tab');
			if (await ouvir.evaluate((element) => element === document.activeElement)) {
				reached = true;
				break;
			}
		}
		expect(reached, 'Tab must reach the selected layer radio').toBe(true);
		await expectVisibleKeyboardFocus(ouvir);

		for (const option of options.slice(1)) {
			await page.keyboard.press('ArrowRight');
			const radio = layers.getByRole('radio', { name: option.name, exact: true });
			await expect(radio).toBeChecked();
			await expect(main).toHaveAttribute('data-layer', option.layer);
			await expectVisibleKeyboardFocus(radio);
		}
		await page.keyboard.press('ArrowRight');
		await expect(ouvir).toBeChecked();
		await expectVisibleKeyboardFocus(ouvir);
		await page.keyboard.press('ArrowLeft');
		await expect(layers.getByRole('radio', { name: 'Engenharia', exact: true })).toBeChecked();
	});
});
