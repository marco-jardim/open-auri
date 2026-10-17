// Helpers of the auth/account e2e specs (project `auth-flow`, server on :4174 started with
// SIGNUP_ENABLED=true and EMAIL_TRANSPORT=capture; see playwright.config.ts).
//
// - Mail: the Worker writes every message to the dev mailbox (D1); GET /api/dev/mailbox?to=…
//   returns the newest first. That endpoint and the capture transport only exist on localhost.
// - Turnstile: the widget script is stubbed (no third-party network) and hands out Cloudflare's
//   dummy token, which the Worker's local stub accepts in capture mode only.
// - Rate limits key on CF-Connecting-IP: each context sends its own random address (Miniflare
//   keeps a client-provided header), so tests never share a window.
import AxeBuilder from '@axe-core/playwright';
import {
	expect,
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	type Page
} from '@playwright/test';
import { waitForApp } from './a-app';

export const AUTH_FLOW_PORT = 4174;
export const AUTH_FLOW_ORIGIN = `http://localhost:${AUTH_FLOW_PORT}`;
export const DUMMY_TURNSTILE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
export const PASSWORD = 'e2e correct horse 1';
export const NEW_PASSWORD = 'e2e another secret 22';

export type Locale = 'pt-BR' | 'en-US';

const TURNSTILE_STUB = `
	window.turnstile = {
		render(container, options) {
			queueMicrotask(() => options.callback && options.callback(${JSON.stringify(DUMMY_TURNSTILE_TOKEN)}));
			return 'e2e-widget';
		},
		reset() {},
		remove() {}
	};
`;

export function uniqueEmail(): string {
	return `e2e+${crypto.randomUUID()}@example.test`;
}

export function randomIp(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(3));
	return `10.${bytes[0]}.${bytes[1]}.${bytes[2]}`;
}

/** A fresh browser context on the auth-flow server: own IP, locale cookie, stubbed Turnstile. */
export async function newContext(
	browser: Browser,
	locale: Locale = 'pt-BR'
): Promise<BrowserContext> {
	const context = await browser.newContext({
		baseURL: AUTH_FLOW_ORIGIN,
		locale,
		extraHTTPHeaders: { 'cf-connecting-ip': randomIp(), 'accept-language': locale }
	});
	await context.addCookies([{ name: 'oa_lang', value: locale, url: AUTH_FLOW_ORIGIN }]);
	await context.route('https://challenges.cloudflare.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'text/javascript', body: TURNSTILE_STUB })
	);
	return context;
}

export interface CapturedMail {
	to: string;
	subject: string;
	text: string;
	html: string;
	createdAt: number;
}

export async function mailbox(request: APIRequestContext, to: string): Promise<CapturedMail[]> {
	const response = await request.get(
		`${AUTH_FLOW_ORIGIN}/api/dev/mailbox?to=${encodeURIComponent(to)}`
	);
	expect(response.status(), 'dev mailbox (EMAIL_TRANSPORT=capture on localhost)').toBe(200);
	const body = (await response.json()) as { messages: CapturedMail[] };
	return body.messages;
}

/** Waits until `to` has at least `count` messages; returns the newest. */
export async function waitForMail(
	request: APIRequestContext,
	to: string,
	count = 1
): Promise<CapturedMail> {
	let messages: CapturedMail[] = [];
	await expect
		.poll(
			async () => {
				messages = await mailbox(request, to);
				return messages.length;
			},
			{ timeout: 15_000, message: `e-mail #${count} to the test address` }
		)
		.toBeGreaterThanOrEqual(count);
	const newest = messages[0];
	if (!newest) throw new Error('no message');
	return newest;
}

/** First link of the plain-text part (the action link), as a path on the test server. */
export function linkOf(mail: CapturedMail): string {
	const match = /https?:\/\/\S+/.exec(mail.text);
	if (!match) throw new Error('no link in the e-mail');
	const url = new URL(match[0]);
	expect(url.origin).toBe(AUTH_FLOW_ORIGIN);
	return `${url.pathname}${url.search}`;
}

async function apiPost(
	request: APIRequestContext,
	path: string,
	body: unknown
): Promise<{ status: number }> {
	const response = await request.post(`${AUTH_FLOW_ORIGIN}/api/auth${path}`, {
		headers: {
			origin: AUTH_FLOW_ORIGIN,
			'content-type': 'application/json',
			'x-turnstile-token': DUMMY_TURNSTILE_TOKEN
		},
		data: body
	});
	return { status: response.status() };
}

/** Creates and verifies an account through the API and the dev mailbox (no UI). */
export async function createVerifiedAccount(
	request: APIRequestContext,
	email = uniqueEmail(),
	password = PASSWORD
): Promise<string> {
	expect((await apiPost(request, '/sign-up/email', { name: '', email, password })).status).toBe(
		200
	);
	const verified = await request.get(
		`${AUTH_FLOW_ORIGIN}${linkOf(await waitForMail(request, email))}`,
		{
			maxRedirects: 0
		}
	);
	expect(verified.status()).toBeLessThan(400);
	return email;
}

/** Signs the context in through the API (its cookie jar gets the session). */
export async function apiSignIn(
	context: BrowserContext,
	email: string,
	password = PASSWORD
): Promise<void> {
	expect((await apiPost(context.request, '/sign-in/email', { email, password })).status).toBe(200);
}

export async function signedInAs(context: BrowserContext): Promise<string | null> {
	const response = await context.request.get(`${AUTH_FLOW_ORIGIN}/api/auth/get-session`);
	const body = (await response.json().catch(() => null)) as { user?: { email?: string } } | null;
	return body?.user?.email ?? null;
}

/** Waits for the stubbed widget to hand its token to the form. */
export async function turnstileReady(page: Page): Promise<void> {
	await expect(page.locator('input[name="cf-turnstile-response"]').first()).toHaveValue(
		DUMMY_TURNSTILE_TOKEN
	);
}

/**
 * Opens a page and waits for hydration and the app runtime (`waitForApp`: the layout's
 * `data-runtime="ready"`, then the bar's cable-status trigger, which only exists once the lazy
 * runtime has mounted; on auth routes that happens on idle).
 */
export async function open(page: Page, path: string): Promise<void> {
	await page.goto(path);
	await waitForApp(page);
}

/**
 * A form action that runs scrypt on the Worker (sign-in, sign-up, reset) while the whole suite
 * shares the machine: the redirect can come later than the default 5 s expect timeout.
 */
export const AUTH_SUBMIT_TIMEOUT_MS = 20_000;

/** Sign-in through the /entrar form. */
export async function uiSignIn(page: Page, email: string, password = PASSWORD, next = '/conta') {
	await open(page, `/entrar?next=${encodeURIComponent(next)}`);
	const form = page.locator('#main-content form').first();
	await form.locator('input[name="email"]').fill(email);
	await form.locator('input[name="password"]').fill(password);
	await turnstileReady(page);
	await form.locator('button[type="submit"]').click();
	await expect(page).toHaveURL(new RegExp(`${next.replace(/[/?]/g, '\\$&')}(\\?|$)`), {
		timeout: AUTH_SUBMIT_TIMEOUT_MS
	});
}

export async function expectNoSeriousAxe(page: Page): Promise<void> {
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
}
