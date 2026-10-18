// Strict CSP (T5.4): every page loads with zero `securitypolicyviolation` events and its policy
// never allows inline scripts. Runs against the built Worker (projects desktop and mobile), so it
// covers both delivery paths: SSR responses (Kit's header with nonces) and prerendered pages
// (Kit's <meta> with hashes plus the web/_headers policy of Workers Static Assets).
//
// The listener is an init script, so it is attached before the first byte of the document is
// parsed. Turnstile is stubbed (no third-party network in tests): the stub is served from the real
// challenges.cloudflare.com URL, so script-src is still exercised; the widget's own frame is not
// (checked by hand on staging, see docs/seguranca.md).
import { expect, test, type Page } from '@playwright/test';
import { routes } from './helpers/a-routes';
import { randomIp } from './helpers/auth-flow';

interface Violation {
	directive: string;
	blockedURI: string;
	sourceFile: string;
	line: number;
	sample: string;
}

declare global {
	interface Window {
		__cspViolations?: Violation[];
		__cspProbe?: number;
	}
}

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

/** Pages that hydrate the shared chrome (Phase 2 routes, Comunidade, auth pages). */
const APP_ROUTES = [
	...routes.map((route) => route.path),
	'/comunidade',
	'/entrar',
	'/criar-conta',
	'/verificar-email',
	'/esqueci-senha',
	'/redefinir-senha'
];

/**
 * Pages that answer a redirect or an error page for an anonymous visitor: /conta sends to the
 * sign-in page, /conta/encerrada and the admin area answer their own status, and unknown curve
 * and profile ids render the error page. Creating a real curve for /c/[id] needs a verified
 * account (auth-flow server); the error page shares its layout and policy.
 */
const OTHER_ROUTES = [
	'/conta',
	'/conta/encerrada',
	'/admin',
	'/c/csp-e2e-inexistente',
	'/u/csp-e2e-inexistente'
];

async function prepare(page: Page): Promise<string[]> {
	await page.context().setExtraHTTPHeaders({ 'cf-connecting-ip': randomIp() });
	await page.route('https://challenges.cloudflare.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'text/javascript', body: TURNSTILE_STUB })
	);
	await page.addInitScript(() => {
		window.__cspViolations = [];
		document.addEventListener('securitypolicyviolation', (event) => {
			window.__cspViolations?.push({
				directive: event.effectiveDirective,
				blockedURI: event.blockedURI,
				sourceFile: event.sourceFile,
				line: event.lineNumber,
				sample: event.sample
			});
		});
	});
	// Backup channel: Chrome also logs every refusal (including ones raised in workers) here.
	const consoleReports: string[] = [];
	page.on('console', (message) => {
		if (/content security policy/i.test(message.text())) consoleReports.push(message.text());
	});
	return consoleReports;
}

/** The enforced document policies: the response header (SSR, web/_headers) and Kit's <meta>. */
async function policies(page: Page, header: string | undefined): Promise<string[]> {
	const meta = await page
		.locator('meta[http-equiv="content-security-policy"]')
		.evaluateAll((elements) => elements.map((element) => element.getAttribute('content') ?? ''));
	// Several CSP headers arrive joined by commas (or newlines, depending on the client).
	return [...(header ?? '').split(/[,\n]/), ...meta].map((policy) => policy.trim()).filter(Boolean);
}

function directive(policy: string, name: string): string | undefined {
	return policy
		.split(';')
		.map((part) => part.trim())
		.find((part) => part === name || part.startsWith(`${name} `));
}

async function settle(page: Page): Promise<void> {
	// Not 'networkidle': pages with live social/audio work never go idle. 'load' plus a pause lets late
	// work (workers, worklets, deferred chunks) report its violations.
	await page.waitForLoadState('load');
	await page.waitForTimeout(750);
}

async function expectNoViolations(
	page: Page,
	path: string,
	consoleReports: string[]
): Promise<void> {
	const violations = await page.evaluate(() => window.__cspViolations ?? []);
	expect(violations, `${path}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
	expect(consoleReports, `${path}: console CSP reports`).toEqual([]);
}

test.describe('content security policy', () => {
	test.describe.configure({ mode: 'parallel' });

	for (const path of APP_ROUTES) {
		test(`${path} loads with no CSP violation and no inline-script allowance`, async ({ page }) => {
			const consoleReports = await prepare(page);
			const response = await page.goto(path);
			expect(response?.status(), `${path} must return HTTP 200`).toBe(200);
			// Not every page wraps its content in <main> (Comparar, Biblioteca and others use plates).
			await expect(page.locator('#main-content')).toBeVisible();
			// Hydrated: the chrome's audio button is enabled only after the app mounts.
			await expect(page.locator('[data-chrome="bar"] button[popovertarget]')).toBeEnabled();
			await settle(page);
			await expectNoViolations(page, path, consoleReports);

			const enforced = await policies(page, response?.headers()['content-security-policy']);
			const documentPolicy = enforced.find((policy) => directive(policy, 'script-src'));
			expect(documentPolicy, `${path} must carry the document policy`).toBeDefined();
			for (const policy of enforced) {
				expect(directive(policy, 'script-src') ?? '').not.toContain("'unsafe-inline'");
				expect(directive(policy, 'style-src') ?? '').not.toContain("'unsafe-inline'");
				expect(policy).not.toContain("'unsafe-eval'");
			}
			expect(directive(documentPolicy ?? '', 'style-src-attr')).toBe(
				"style-src-attr 'unsafe-inline'"
			);
		});
	}

	for (const path of OTHER_ROUTES) {
		test(`${path} (redirect or error page) loads with no CSP violation`, async ({ page }) => {
			const consoleReports = await prepare(page);
			const response = await page.goto(path);
			expect(response?.status() ?? 0, `${path} must not fail on the server`).toBeLessThan(500);
			await settle(page);
			await expectNoViolations(page, path, consoleReports);
		});
	}

	// Simple Analytics loads on the production origin only (src/lib/server/analytics.ts): the local
	// preview never renders its tag nor contacts its hosts, yet its policy already allows them.
	test('the local preview has no Simple Analytics tag and the policy allows its hosts', async ({
		page
	}) => {
		const analytics: string[] = [];
		page.on('request', (request) => {
			if (/simpleanalytics/i.test(new URL(request.url()).hostname)) analytics.push(request.url());
		});
		const consoleReports = await prepare(page);
		// '/' and '/docs' are prerendered (meta + web/_headers policy); '/entrar' is SSR (header).
		for (const path of ['/', '/docs', '/entrar']) {
			const response = await page.goto(path);
			expect(response?.status(), path).toBe(200);
			const html = (await response?.text()) ?? '';
			expect(html, `${path}: placeholder must never leak`).not.toContain('%analytics%');
			expect(html, path).not.toContain('simpleanalyticscdn.com');
			expect(html, path).not.toContain('privacy-first analytics');
			await expect(page.locator('script[src*="simpleanalyticscdn.com"]')).toHaveCount(0);
			await settle(page);
			await expectNoViolations(page, path, consoleReports);

			const enforced = await policies(page, response?.headers()['content-security-policy']);
			const documentPolicy = enforced.find((policy) => directive(policy, 'script-src')) ?? '';
			expect(directive(documentPolicy, 'script-src'), path).toContain(
				'https://scripts.simpleanalyticscdn.com'
			);
			for (const name of ['connect-src', 'img-src']) {
				const carrying = enforced.map((policy) => directive(policy, name)).filter(Boolean);
				expect(carrying.length, `${path} ${name}`).toBeGreaterThan(0);
				for (const value of carrying) {
					expect(value, `${path} ${name}`).toContain('https://queue.simpleanalyticscdn.com');
				}
			}
		}
		expect(analytics).toEqual([]);
	});

	test('the policy really blocks injected inline scripts and <style> elements', async ({
		page
	}) => {
		const consoleReports = await prepare(page);
		await page.goto('/');
		await expect(page.locator('[data-chrome="bar"] button[popovertarget]')).toBeEnabled();
		await page.evaluate(() => {
			const script = document.createElement('script');
			script.textContent = 'window.__cspProbe = 1';
			document.head.append(script);
			const style = document.createElement('style');
			style.textContent = 'body { outline: 3px solid red; }';
			document.head.append(style);
		});
		await expect
			.poll(() => page.evaluate(() => (window.__cspViolations ?? []).map((v) => v.directive)))
			.toEqual(expect.arrayContaining(['script-src-elem', 'style-src-elem']));
		expect(await page.evaluate(() => window.__cspProbe)).toBeUndefined();
		// The console channel sees the same refusals (it is the backup of the other tests).
		await expect.poll(() => consoleReports.length).toBeGreaterThan(0);
	});
});
