// Auth pages (T3.6) against the built Worker (`wrangler dev`, local D1).
// Prerequisites (run by the orchestrator): `wrangler d1 migrations apply --local` for the web DB,
// and SIGNUP_ENABLED=false, forced by the preview script whatever the .env says.
//
// Turnstile: the widget script is stubbed (no third-party network in tests). The stub hands out a
// dummy token, so the Worker's siteverify call decides between "security check failed" and the
// credentials check, depending on the local TURNSTILE_SECRET. Either way the page must answer
// the same for every address; the exact credentials mapping is covered by the unit tests.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { waitForApp } from './helpers/a-app';
import { randomIp } from './helpers/auth-flow';

const AUTH_ROUTES = [
	'/entrar',
	'/criar-conta',
	'/verificar-email',
	'/esqueci-senha',
	'/redefinir-senha'
] as const;

const CREDENTIALS_MESSAGE = 'E-mail ou senha incorretos.';
const TURNSTILE_MESSAGE =
	'A verificação de segurança não passou. ' +
	'Ela precisa de JavaScript: recarregue a página e tente de novo.';

const TURNSTILE_STUB = `
	window.turnstile = {
		render(container, options) {
			queueMicrotask(() => options.callback && options.callback('e2e-dummy-token'));
			return 'e2e-widget';
		},
		reset() {},
		remove() {}
	};
`;

async function stubTurnstile(page: Page): Promise<void> {
	await page.route('https://challenges.cloudflare.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'text/javascript', body: TURNSTILE_STUB })
	);
}

async function open(page: Page, path: string): Promise<void> {
	await stubTurnstile(page);
	const response = await page.goto(path);
	expect(response?.status(), `${path} must return HTTP 200`).toBe(200);
	await expect(page.locator('#main-content main')).toBeVisible();
	// Hydrated and the lazy runtime mounted (on idle on auth routes): data-runtime="ready", then
	// the bar's cable-status trigger, which only exists once the app is there.
	await waitForApp(page);
}

test.describe('auth pages', () => {
	test.describe.configure({ mode: 'parallel' });
	// Rate limits key on CF-Connecting-IP (kept by Miniflare): one address per test, so runs and
	// projects never share a limiter window.
	test.beforeEach(async ({ context }) => {
		await context.setExtraHTTPHeaders({ 'cf-connecting-ip': randomIp() });
	});

	for (const path of AUTH_ROUTES) {
		test(`${path} renders server-side, noindex, with no serious or critical axe violations`, async ({
			page
		}) => {
			await open(page, path);
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
			await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
				'content',
				'noindex, nofollow'
			);
			await expect(page.locator('[data-page="auth"]')).toBeVisible();
			await expect(page.locator('[data-chrome="footer"]')).toContainText('Rupert Neve');
			const result = await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
				.analyze();
			const violations = result.violations.filter(
				(violation) => violation.impact === 'serious' || violation.impact === 'critical'
			);
			expect(
				violations,
				JSON.stringify(
					violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target }) => target) })),
					null,
					2
				)
			).toEqual([]);
		});
	}

	test('responses are not cacheable and not indexable', async ({ request }) => {
		for (const path of AUTH_ROUTES) {
			const response = await request.get(path);
			expect(response.headers()['cache-control']).toContain('no-store');
			expect(response.headers()['x-robots-tag']).toContain('noindex');
		}
	});

	test('sign-up is closed: explanation, no form, sign-in still offered', async ({ page }) => {
		await open(page, '/criar-conta?next=/biblioteca');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('O cadastro abre em breve');
		await expect(page.locator('#main-content form')).toHaveCount(0);
		await expect(page.locator('input[type="password"]')).toHaveCount(0);
		await expect(
			page.getByRole('link', { name: 'Entrar com uma conta existente' })
		).toHaveAttribute('href', '/entrar?next=%2Fbiblioteca');
	});

	test('keyboard: Tab reaches e-mail, password, show-password and submit in order', async ({
		page
	}) => {
		await open(page, '/entrar');
		const email = page.getByLabel('E-mail', { exact: true });
		await email.focus();
		await expect(email).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByLabel('Senha', { exact: true })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByRole('button', { name: 'Mostrar senha' })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeFocused();
		const outline = await page
			.getByRole('button', { name: 'Entrar', exact: true })
			.evaluate((element) => getComputedStyle(element).outlineStyle);
		expect(outline).not.toBe('none');
	});

	test('open-redirect payloads never reach the form', async ({ page }) => {
		for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example', '/.//x']) {
			await open(page, `/entrar?next=${encodeURIComponent(next)}`);
			await expect(page.locator('input[name="next"]')).toHaveCount(0);
		}
		await open(page, '/entrar?next=%2Fbiblioteca');
		await expect(page.locator('input[name="next"]')).toHaveValue('/biblioteca');
	});

	test('wrong credentials: the same message for any address, nothing echoed but the e-mail', async ({
		page
	}) => {
		const messages: string[] = [];
		for (const email of ['ninguem-1@example.com', 'ninguem-2@example.com']) {
			await open(page, '/entrar');
			await page.getByLabel('E-mail', { exact: true }).fill(email);
			await page.getByLabel('Senha', { exact: true }).fill('senha-errada-123');
			await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue(
				'e2e-dummy-token'
			);
			await page.getByRole('button', { name: 'Entrar', exact: true }).click();
			const alert = page.getByRole('alert');
			await expect(alert).toBeVisible();
			const text = (await alert.textContent())?.trim() ?? '';
			expect(text).not.toContain(email);
			expect([CREDENTIALS_MESSAGE, TURNSTILE_MESSAGE]).toContain(text);
			messages.push(text);
		}
		expect(new Set(messages).size).toBe(1);
	});

	test('reset link without a token offers a new one', async ({ page }) => {
		await open(page, '/redefinir-senha');
		await expect(page.getByRole('alert')).toContainText(
			'Este endereço não tem um link de redefinição válido.'
		);
		await expect(page.getByRole('link', { name: 'Pedir um link novo' })).toHaveAttribute(
			'href',
			'/esqueci-senha'
		);
	});

	test('verification landing states', async ({ page }) => {
		await open(page, '/verificar-email?verificado=1');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('E-mail confirmado');
		await open(page, '/verificar-email?verificado=1&error=INVALID_TOKEN');
		await expect(page.getByRole('alert')).toContainText('inválido ou já venceu');
		await expect(page.getByRole('button', { name: 'Reenviar link' })).toBeVisible();
	});

	test('header shows "Entrar" for anonymous visitors on a prerendered page', async ({ page }) => {
		await page.goto('/docs');
		const entry = page.locator('[data-chrome="bar"] a[data-account]');
		await expect(entry).toHaveText('Entrar');
		await expect(entry).toHaveAttribute('href', '/entrar?next=%2Fdocs');
		await expect(entry).toHaveAttribute('data-account', 'anonymous');
	});

	test('works without JavaScript: the form posts and the page answers', async ({ browser }) => {
		const context = await browser.newContext({
			javaScriptEnabled: false,
			locale: 'pt-BR',
			extraHTTPHeaders: { 'cf-connecting-ip': randomIp() }
		});
		const page = await context.newPage();
		await page.goto('/esqueci-senha');
		// Unique address: the per-address limiter (D1, survives between runs) must start empty.
		const address = `ninguem+${crypto.randomUUID()}@example.com`;
		await page.getByLabel('E-mail', { exact: true }).fill(address);
		await page.getByRole('button', { name: 'Enviar link' }).click();
		// Without JS there is no Turnstile token: the server answers with the uniform check message.
		await expect(page.getByRole('alert')).toContainText('A verificação de segurança não passou.');
		await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue(address);
		await context.close();
	});
});
