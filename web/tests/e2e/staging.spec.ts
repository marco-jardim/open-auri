// T5.T: end-to-end checks against the DEPLOYED staging Worker (plan T5.T, ~2405-2418).
//
// Runs only when STAGING_ORIGIN is set; the origin is never written in the repository (the
// workers.dev subdomain is sensitive). playwright.config.ts then exposes a single `staging`
// project and starts no local server:
//
//   $env:STAGING_ORIGIN = '<staging origin>'; npx playwright test --project=staging
//
// Optional: STAGING_SIGNUP_ENABLED=true when staging was deployed with SIGNUP_ENABLED=true (then
// the closed sign-up check is skipped; the open form is never submitted).
//
// Nothing here creates data on staging: no account, no e-mail, no publication, no report. Reads
// and the browser-only flows (offline shell, cable through the WebHID stub, which only replaces
// navigator.hid in the page) are enough. The read-only switch is NOT flipped from tests (it is a
// shared, audited admin action on KV): the manual staging procedure is in
// tests/integration/phase5/README.md ("Read-only mode on staging").
//
// No cf-connecting-ip header is sent: on the real edge the client address is Cloudflare's to set.
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { waitForApp } from './helpers/a-app';
import { routes } from './helpers/a-routes';
import { hidLog, installHidStub } from './helpers/b-hid';
import { confirmBasics, connectCable, openChecklist } from './helpers/b-ui';

const STAGING_ORIGIN = process.env.STAGING_ORIGIN ?? '';
const SIGNUP_ENABLED = process.env.STAGING_SIGNUP_ENABLED === 'true';

test.skip(
	STAGING_ORIGIN === '',
	'STAGING_ORIGIN is not set: these checks only run against a deployed staging Worker'
);

/** Every public page that hydrates the shared chrome (same list as csp.spec.ts). */
const PUBLIC_PAGES = [
	...routes.map((route) => route.path),
	'/comunidade',
	'/entrar',
	'/criar-conta',
	'/verificar-email',
	'/esqueci-senha',
	'/redefinir-senha'
];

/** Expected header values (web/src/lib/server/security/headers.ts and web/_headers). */
const HSTS = 'max-age=63072000; includeSubDomains';
const FRAME_ANCESTORS = "frame-ancestors 'none'";
const NON_HTML_DEFAULT = "default-src 'none'";

/** Ids that name nothing (syntactically plausible, never created). */
const UNKNOWN_ID = 'stagingt5tunknown01';

interface StagingViolation {
	directive: string;
	blockedURI: string;
	sourceFile: string;
	line: number;
}

declare global {
	interface Window {
		__stagingCspViolations?: StagingViolation[];
	}
}

/**
 * Turnstile's own frame and scripts run under Cloudflare's policy, not ours, and log their own
 * network noise (e.g. Private Access Token probes); they are not page errors of the app.
 */
function fromTurnstile(message: ConsoleMessage): boolean {
	return message.location().url.startsWith('https://challenges.cloudflare.com/');
}

/**
 * Attaches, before the first byte is parsed, the `securitypolicyviolation` listener of
 * csp.spec.ts, and collects console errors, page errors, CSP console reports and same-origin
 * HTTP errors. Returns the live list of problems.
 */
async function watch(page: Page): Promise<string[]> {
	await page.addInitScript(() => {
		window.__stagingCspViolations = [];
		document.addEventListener('securitypolicyviolation', (event) => {
			window.__stagingCspViolations?.push({
				directive: event.effectiveDirective,
				blockedURI: event.blockedURI,
				sourceFile: event.sourceFile,
				line: event.lineNumber
			});
		});
	});
	const problems: string[] = [];
	page.on('console', (message) => {
		if (fromTurnstile(message)) return;
		if (message.type() === 'error') problems.push(`console: ${message.text()}`);
		else if (/content security policy/i.test(message.text())) {
			problems.push(`csp console: ${message.text()}`);
		}
	});
	page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
	page.on('response', (response) => {
		if (response.status() >= 400 && response.url().startsWith(STAGING_ORIGIN)) {
			problems.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
		}
	});
	return problems;
}

async function settle(page: Page): Promise<void> {
	// Not 'networkidle': live social and audio work never goes idle (see csp.spec.ts).
	await page.waitForLoadState('load');
	await page.waitForTimeout(750);
}

function expectSecurityHeaders(
	headers: Record<string, string>,
	kind: 'html' | 'other',
	label: string
): void {
	expect(headers['strict-transport-security'], label).toBe(HSTS);
	expect(headers['x-content-type-options'], label).toBe('nosniff');
	expect(headers['x-frame-options'], label).toBe('DENY');
	expect(headers['referrer-policy'], label).toBe('strict-origin-when-cross-origin');
	expect(headers['cross-origin-opener-policy'], label).toBe('same-origin');
	expect(headers['permissions-policy'] ?? '', label).toContain('hid=(self)');
	// Several CSP headers arrive joined (newline or comma): every one is enforced.
	const csp = headers['content-security-policy'] ?? '';
	expect(csp, label).toContain(FRAME_ANCESTORS);
	if (kind === 'html') {
		expect(csp, label).not.toMatch(/script-src[^;,\n]*'unsafe-inline'/);
	} else {
		expect(csp, label).toContain(NON_HTML_DEFAULT);
	}
}

test.describe('staging: public pages, i18n and CSP', () => {
	test.describe.configure({ mode: 'parallel' });

	for (const locale of ['pt-BR', 'en-US'] as const) {
		test.describe(locale, () => {
			test.use({ locale });
			test.beforeEach(async ({ context }) => {
				await context.addCookies([{ name: 'oa_lang', value: locale, url: STAGING_ORIGIN }]);
			});

			for (const path of PUBLIC_PAGES) {
				test(`${path} renders in ${locale} with no console error and no CSP violation`, async ({
					page
				}) => {
					const problems = await watch(page);
					const response = await page.goto(path);
					expect(response?.status(), `${path} must return HTTP 200`).toBe(200);
					await waitForApp(page);
					await expect(page.locator('html')).toHaveAttribute('lang', locale);
					await settle(page);
					const violations = await page.evaluate(() => window.__stagingCspViolations ?? []);
					expect(violations, `${path}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
					expect(problems, `${path} (${locale})`).toEqual([]);
				});
			}
		});
	}
});

test.describe('staging: headers and public API', () => {
	test('security headers on SSR HTML, prerendered HTML, API JSON and error responses', async ({
		request
	}) => {
		const cases = [
			{ path: '/entrar', status: 200, kind: 'html' },
			{ path: '/docs', status: 200, kind: 'html' },
			{ path: '/api/v1/feed', status: 200, kind: 'other' },
			{ path: `/c/${UNKNOWN_ID}`, status: 404, kind: 'html' },
			{ path: `/og/${UNKNOWN_ID}.png`, status: 404, kind: 'other' }
		] as const;
		for (const entry of cases) {
			const response = await request.get(entry.path, { maxRedirects: 0 });
			expect(response.status(), entry.path).toBe(entry.status);
			expectSecurityHeaders(response.headers(), entry.kind, entry.path);
		}
	});

	for (const path of ['/api/v1/feed', '/api/v1/rankings']) {
		test(`${path}: JSON with ETag, 304 on If-None-Match`, async ({ request }) => {
			const first = await request.get(path);
			expect(first.status()).toBe(200);
			expect(first.headers()['content-type']).toContain('application/json');
			expect(first.headers()['cache-control'] ?? '').toContain('public');
			const body: unknown = await first.json();
			expect(typeof body).toBe('object');
			const etag = first.headers()['etag'] ?? '';
			expect(etag).toMatch(/^(W\/)?"[^"]+"$/);

			const again = await request.get(path, { headers: { 'if-none-match': etag } });
			// The rankings job may recompute in between (every 15 min): then the ETag changes.
			if (again.status() === 200) {
				expect(again.headers()['etag']).not.toBe(etag);
			} else {
				expect(again.status()).toBe(304);
				expect(await again.body()).toHaveLength(0);
			}
		});
	}

	test('unknown OG image and unknown shared curve answer 404', async ({ request }) => {
		expect((await request.get(`/og/${UNKNOWN_ID}.png`)).status()).toBe(404);
		expect((await request.get(`/c/${UNKNOWN_ID}`)).status()).toBe(404);
	});
});

test.describe('staging: browser flows without server writes', () => {
	test('offline: the service worker installs and the Curva shell loads without a network', async ({
		page,
		context
	}) => {
		await page.goto('/');
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
			if (navigator.serviceWorker.controller) return;
			await new Promise<void>((resolve) => {
				navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
					once: true
				});
			});
		});
		await context.setOffline(true);
		try {
			await page.reload();
			await expect(page.getByRole('heading', { name: 'Curva', exact: true })).toBeVisible();
			await expect(page.getByTestId('pwa-offline-notice')).toBeVisible();
		} finally {
			await context.setOffline(false);
		}
	});

	test('cable through the HID stub: checklist first, reports only after the write gesture', async ({
		page
	}) => {
		await installHidStub(page);
		await page.goto('/cabo');
		await expect(
			page.getByRole('button', { name: 'Levantar tampa do checklist', exact: true })
		).toBeEnabled();
		await connectCable(page);
		expect((await hidLog(page)).reports).toEqual([]);

		const dialog = await openChecklist(page);
		const write = dialog.getByRole('button', { name: 'Gravar no cabo', exact: true });
		await expect(write).toBeDisabled();
		await confirmBasics(dialog);
		await expect(write).toBeEnabled();
		// Confirmations alone never send anything: only the click does.
		expect((await hidLog(page)).reports).toEqual([]);
		await write.click();
		await expect(dialog.getByRole('status')).toHaveText(/^Gravado no cabo\. CRC /);
		const { reports } = await hidLog(page);
		expect(reports).toHaveLength(10);
		for (const report of reports) {
			expect(report.reportId).toBe(0xcb);
			expect(report.bytes).toHaveLength(31);
		}
	});

	test('sign-up is closed (SIGNUP_ENABLED=false): explanation, no form, nothing submitted', async ({
		page
	}) => {
		test.skip(SIGNUP_ENABLED, 'staging was deployed with SIGNUP_ENABLED=true');
		const response = await page.goto('/criar-conta');
		expect(response?.status()).toBe(200);
		await waitForApp(page);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('O cadastro abre em breve');
		await expect(page.locator('#main-content form')).toHaveCount(0);
		await expect(page.locator('input[type="password"]')).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Entrar com uma conta existente' })).toBeVisible();
	});
});
