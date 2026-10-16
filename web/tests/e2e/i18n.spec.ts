import { expect, test, type Page } from '@playwright/test';
import { openApp, settleRendering, waitForApp } from './helpers/a-app';
import { routes } from './helpers/a-routes';

async function toggleLanguage(page: Page, name: string, locale: string): Promise<void> {
	// Paraglide's toggle reloads the current document, rather than navigating to a new URL.
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		page.getByRole('button', { name, exact: true }).click()
	]);
	await waitForApp(page);
	await expect(page.locator('html')).toHaveAttribute('lang', locale);
	await expect
		.poll(
			async () => (await page.context().cookies()).find(({ name }) => name === 'oa_lang')?.value
		)
		.toBe(locale);
}

async function expectNoRawKeys(page: Page): Promise<void> {
	const keys = await page.locator('#main-content').evaluate((main) => {
		const missing: string[] = [];
		// These are documented math/cookie identifiers in prose, not untranslated messages.
		const identifiers = new Set(location.pathname === '/docs' ? ['f_alias', 'oa_lang'] : []);
		const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			const parent = node.parentElement;
			// Docs legitimately teaches identifiers such as preamp_db in code samples.
			if (
				parent &&
				!parent.closest('pre, code, kbd, samp, script, style, [aria-hidden="true"]') &&
				parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
			) {
				missing.push(
					...(node.textContent?.match(/\b[a-z]+_[a-z0-9_]{3,}\b/g) ?? []).filter(
						(key) => !identifiers.has(key)
					)
				);
			}
			node = walker.nextNode();
		}
		return [...new Set(missing)];
	});
	expect(keys, 'Visible main content must contain translations, not message identifiers').toEqual(
		[]
	);
}

test.describe('Language selection', () => {
	test('toggle persists through client routes and hydrated reloads via its cookie', async ({
		page
	}) => {
		await openApp(page, '/');
		await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
		await toggleLanguage(page, 'Switch to English', 'en-US');

		for (const destination of [
			{ name: 'Library', path: '/biblioteca' },
			{ name: 'Docs', path: '/docs' },
			{ name: 'Cable', path: '/cabo' }
		]) {
			await page
				.getByRole('navigation', { name: 'Main', exact: true })
				.getByRole('link', { name: destination.name, exact: true })
				.click();
			await expect(page).toHaveURL(new RegExp(`${destination.path}$`));
			await waitForApp(page);
			await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
			await expect(
				page.getByRole('button', { name: 'Mudar para português', exact: true })
			).toBeVisible();

			// These routes are prerendered in the base locale; the cookie is applied on hydration.
			await page.reload();
			await waitForApp(page);
			await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
			await expect(
				page.getByRole('button', { name: 'Mudar para português', exact: true })
			).toBeVisible();
			expect((await page.context().cookies()).find(({ name }) => name === 'oa_lang')?.value).toBe(
				'en-US'
			);
		}

		await page.reload();
		await waitForApp(page);
		await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
		await toggleLanguage(page, 'Mudar para português', 'pt-BR');
		await openApp(page, '/');
		await expect(page.getByRole('radio', { name: 'Ouvir', exact: true })).toBeChecked();
		await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
		expect((await page.context().cookies()).find(({ name }) => name === 'oa_lang')?.value).toBe(
			'pt-BR'
		);
	});

	test.describe('browser locale fallback', () => {
		test.use({ locale: 'en-US' });
		test('no language cookie hydrates in English', async ({ page, context }) => {
			expect((await context.cookies()).some(({ name }) => name === 'oa_lang')).toBe(false);
			await openApp(page, '/');
			await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
			await expect(page.getByRole('radio', { name: 'Listen', exact: true })).toBeChecked();
			await expect(
				page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', {
					name: 'Library',
					exact: true
				})
			).toBeVisible();
			await expectNoRawKeys(page);
		});

		// FX2.3/I1: plan §3.5 keeps preferredLanguage, so /lang-boot.js hides the prerendered
		// pt-BR document until the layout hydrates in English; the base locale never paints.
		test('prerendered pt-BR never shows before hydration switches to English', async ({ page }) => {
			// Hold the client entry so the prerendered document is observed before hydration.
			const gate = { open: (): void => undefined };
			const hydration = new Promise<void>((resolve) => {
				gate.open = resolve;
			});
			await page.route('**/_app/immutable/entry/**', async (route) => {
				await hydration;
				await route.continue();
			});
			await page.goto('/docs', { waitUntil: 'commit' });
			const html = page.locator('html');
			await expect(html).toHaveAttribute('data-lang-boot', 'en-US');
			await expect(html).toHaveAttribute('lang', 'pt-BR');
			expect(await page.evaluate(() => getComputedStyle(document.documentElement).visibility)).toBe(
				'hidden'
			);
			await expect(page.locator('#main-content')).toBeHidden();
			gate.open();
			await waitForApp(page);
			await expect(html).toHaveAttribute('lang', 'en-US');
			await expect(html).not.toHaveAttribute('data-lang-boot');
			expect(await page.evaluate(() => getComputedStyle(document.documentElement).visibility)).toBe(
				'visible'
			);
			await expect(
				page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', {
					name: 'Library',
					exact: true
				})
			).toBeVisible();
		});
	});

	test('a pt-BR browser keeps the prerendered page visible with no boot hide', async ({ page }) => {
		await page.goto('/docs', { waitUntil: 'domcontentloaded' });
		const html = page.locator('html');
		await expect(html).toHaveAttribute('lang', 'pt-BR');
		await expect(html).not.toHaveAttribute('data-lang-boot');
		await expect(page.locator('#main-content')).toBeVisible();
		expect(await page.evaluate(() => getComputedStyle(document.documentElement).visibility)).toBe(
			'visible'
		);
		await waitForApp(page);
		await expect(html).toHaveAttribute('lang', 'pt-BR');
	});
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test.describe(`${locale} content`, () => {
		test.describe.configure({ mode: 'parallel' });
		test.beforeEach(async ({ context, baseURL }) => {
			if (!baseURL) throw new Error('i18n tests require Playwright use.baseURL');
			await context.addCookies([{ name: 'oa_lang', value: locale, url: baseURL }]);
		});

		test('visible preamp uses the locale decimal separator', async ({ page }) => {
			await openApp(page, '/');
			await page
				.getByRole('region', { name: 'Presets', exact: true })
				.getByRole('button', { name: 'Auri', exact: true })
				.click();
			const readout = page.getByRole('main').getByText(/\bCRC 0x[0-9a-f]{4}\b/i);
			await expect(readout).toBeVisible();
			await expect(readout).toContainText(
				locale === 'pt-BR' ? /preamp [−+]?\d+,\d dB/ : /preamp [−+]?\d+\.\d dB/
			);
		});

		for (const route of routes) {
			test(`${route.path} has no visible raw message keys`, async ({ page }) => {
				await openApp(page, route.path);
				await settleRendering(page);
				await expect(page.locator('html')).toHaveAttribute('lang', locale);
				await expectNoRawKeys(page);
			});
		}
	});
}
