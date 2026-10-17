import { expect, test } from '@playwright/test';
import { openApp, settleRendering } from './helpers/a-app';
import { routes } from './helpers/a-routes';

// CI has no embedded AutoEq data (web/static/data/autoeq is generated locally and git-ignored);
// the workflow sets OA_NO_AUTOEQ=1 so only those requests and their console echo are tolerated.
const NO_AUTOEQ = process.env.OA_NO_AUTOEQ === '1';
const AUTOEQ_PATH = /\/data\/autoeq\//;

test.describe('Phase 2 route smoke', () => {
	test.describe.configure({ mode: 'parallel' });

	for (const route of routes) {
		test(`${route.path} renders cleanly with the shared homage and legal links`, async ({
			page
		}) => {
			const errors: string[] = [];
			const autoeqMisses = new Set<string>();
			page.on('console', (message) => {
				if (message.type() !== 'error') return;
				const url = message.location().url;
				if (NO_AUTOEQ && (AUTOEQ_PATH.test(url) || /AutoEq/.test(message.text()))) return;
				errors.push(`console: ${message.text()}`);
			});
			page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
			page.on('response', (response) => {
				if (response.status() >= 400) {
					if (NO_AUTOEQ && AUTOEQ_PATH.test(response.url())) {
						autoeqMisses.add(response.url());
						return;
					}
					errors.push(`HTTP ${response.status()}: ${response.url()}`);
				}
			});

			await openApp(page, route.path);
			await settleRendering(page);
			await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
			await expect(page.locator('body')).not.toContainText(/NaN|undefined|\[object Object\]/);

			const footer = page.getByRole('contentinfo');
			await expect(footer.getByText('Esta página homenageia', { exact: true })).toBeVisible();
			await expect(footer.getByRole('heading').first()).toHaveText(/\S/);
			await expect(
				footer.getByRole('list', { name: 'Fontes da homenagem', exact: true })
			).toBeVisible();
			const legal = footer.getByRole('link', { name: 'Aviso legal completo', exact: true });
			const github = footer.getByRole('link', { name: 'Código-fonte no GitHub', exact: true });
			await expect(legal).toBeVisible();
			await expect(github).toBeVisible();
			await expect(github).toHaveAttribute('href', /^https:\/\/github\.com\//);
			// Adjacency is stronger than a general "comes later" check: no link may slip in between.
			expect(
				await github.evaluate((link) => {
					const previous = link.previousElementSibling;
					return (
						previous?.tagName === 'A' && previous.textContent?.trim() === 'Aviso legal completo'
					);
				})
			).toBe(true);
			expect(errors, `Browser errors on ${route.path}`).toEqual([]);
		});
	}
});
