// Visual references of the auth pages (FUX.P8, console channel strip). These routes had no
// baseline before (spec §1.9); the orchestrator generates them against the :4173 reference
// (sign-up closed, so /criar-conta shows the closed state). Both configured projects run every
// case: desktop 1440 px and mobile 390 px.
//
// Turnstile: the widget script is stubbed (no third-party network). The stub draws a fixed box
// marked `data-visual-dynamic` (masked by dynamicRegions) and, in the "lit" case only, hands out a
// dummy token so every stage of the channel validates. The idle case never gets a token, so its
// EQ and Saída lamps are dark: the capture only shows real validation state.
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { openApp, settleRendering } from './helpers/a-app';
import { dynamicRegions } from './helpers/a-visual';
import { randomIp } from './helpers/auth-flow';

// The capture injects tests/e2e/helpers/visual.css as a <style>; the strict CSP blocks it.
test.use({ bypassCSP: true });

const visualCss = fileURLToPath(new URL('./helpers/visual.css', import.meta.url));

function turnstileStub(withToken: boolean): string {
	return `
		window.turnstile = {
			render(container, options) {
				const box = document.createElement('div');
				box.setAttribute('data-visual-dynamic', '');
				box.style.width = '300px';
				box.style.height = '65px';
				container.append(box);
				${withToken ? "queueMicrotask(() => options.callback && options.callback('visual-dummy-token'));" : ''}
				return 'visual-widget';
			},
			reset() {},
			remove() {}
		};
	`;
}

async function stubTurnstile(page: Page, withToken: boolean): Promise<void> {
	await page.route('https://challenges.cloudflare.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'text/javascript', body: turnstileStub(withToken) })
	);
}

function stage(page: Page, id: 'input' | 'gain' | 'eq' | 'output') {
	return page.locator(`#main-content .stage[data-stage="${id}"]`);
}

const cases = [
	{
		name: 'auth-entrar',
		path: '/entrar',
		token: false,
		prepare: async (page: Page) => {
			await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
			// Nothing typed: every lamp of the channel is dark.
			for (const id of ['input', 'gain', 'eq', 'output'] as const) {
				await expect(stage(page, id)).toHaveAttribute('data-on', 'false');
			}
		}
	},
	{
		name: 'auth-entrar-lit',
		path: '/entrar',
		token: true,
		prepare: async (page: Page) => {
			await page.getByLabel('E-mail', { exact: true }).fill('ana@example.com');
			await page.getByLabel('Senha', { exact: true }).fill('senha-de-exemplo');
			await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue(
				'visual-dummy-token'
			);
			// Real validation lit every stage, Saída last.
			await expect(stage(page, 'output')).toHaveAttribute('data-on', 'true');
			// Same focus state on every run.
			await page.locator('#main-content h1').click();
		}
	},
	{
		name: 'auth-criar-conta-fechado',
		path: '/criar-conta',
		token: false,
		prepare: async (page: Page) => {
			await expect(page.getByRole('heading', { level: 1 })).toHaveText('O cadastro abre em breve');
			await expect(page.locator('#main-content form')).toHaveCount(0);
		}
	}
] as const;

for (const motion of [
	{ name: 'default-motion', preference: 'no-preference' },
	{ name: 'reduced-motion', preference: 'reduce' }
] as const) {
	test.describe(`auth ${motion.name}`, () => {
		test.describe.configure({ mode: 'parallel' });
		test.use({ reducedMotion: motion.preference });
		// Rate limits key on CF-Connecting-IP: one address per test.
		test.beforeEach(async ({ context }) => {
			await context.setExtraHTTPHeaders({ 'cf-connecting-ip': randomIp() });
		});

		for (const entry of cases) {
			test(`${entry.name} reference`, async ({ page }, testInfo) => {
				await stubTurnstile(page, entry.token);
				await openApp(page, entry.path);
				await settleRendering(page);
				await entry.prepare(page);
				expect(
					await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
				).toBe(motion.preference === 'reduce');
				// Project and motion are explicit so update-snapshots cannot overwrite another variant.
				await expect(page).toHaveScreenshot(
					`${entry.name}-${testInfo.project.name}-${motion.name}.png`,
					{
						fullPage: true,
						animations: 'disabled',
						caret: 'hide',
						mask: dynamicRegions(page),
						maxDiffPixelRatio: 0.02,
						timeout: 30_000,
						stylePath: visualCss
					}
				);
			});
		}
	});
}
