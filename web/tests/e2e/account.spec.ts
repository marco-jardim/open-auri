// /conta e2e against the built Worker in local test mode (project `auth-flow`, port 4174; links
// from the dev mailbox): change password → sign out the other sessions (second browser context)
// → change e-mail (both links) → export (download, keys, no secrets) → close the account. The
// whole flow runs once in pt-BR and once in en-US (expected copy read from web/messages/*.json),
// each with a different closure policy and its own user. Also /conta/encerrada for every visitor
// and the /admin 404.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
	apiSignIn,
	AUTH_FLOW_ORIGIN,
	createVerifiedAccount,
	DUMMY_TURNSTILE_TOKEN,
	expectNoSeriousAxe,
	linkOf,
	mailbox,
	NEW_PASSWORD,
	newContext,
	open,
	PASSWORD,
	signedInAs,
	turnstileReady,
	uiSignIn,
	uniqueEmail,
	waitForMail,
	type Locale
} from './helpers/auth-flow';

test.describe.configure({ mode: 'parallel' });

/** The UI copy of one locale, straight from the message catalog the build uses. */
function catalog(locale: Locale): Record<string, string> {
	const file = fileURLToPath(new URL(`../../messages/${locale}.json`, import.meta.url));
	return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
}

/** Catalog text up to its first `{placeholder}` (for messages with parameters). */
function lead(text: string | undefined): string {
	if (!text) throw new Error('message missing from the catalog');
	return text.split('{')[0]?.trim() ?? text;
}

/** The /conta form whose `action` is `?/<name>`. */
function form(page: Page, name: string) {
	return page.locator(`form[action="?/${name}"]`);
}

/** Waits until the other context is signed out (the action finished server-side). */
async function signedOut(context: BrowserContext): Promise<void> {
	await expect.poll(() => signedInAs(context), { timeout: 10_000 }).toBeNull();
}

async function closeAccount(
	page: Page,
	context: BrowserContext,
	copy: Record<string, string>,
	email: string,
	password: string,
	mode: 'anonymize' | 'delete-all'
): Promise<void> {
	await open(page, '/conta');
	const close = form(page, 'close');
	await close.locator(`input[name="mode"][value="${mode}"]`).check();
	await close.locator('input[name="password"]').fill(password);
	await close.locator('input[name="acknowledged"]').check();
	const before = (await mailbox(context.request, email)).length;
	await close.getByRole('button', { name: copy.conta_close_submit, exact: true }).click();
	await expect(page.getByTestId('close-pending')).toContainText(lead(copy.conta_close_pending));
	// Nothing is deleted before the mailed link is opened.
	expect(await signedInAs(context)).toBe(email);
	const link = linkOf(await waitForMail(context.request, email, before + 1));
	expect(link).toContain('delete-user/callback');
	await page.goto(link);
	await expect(page).toHaveURL(/\/conta\/encerrada/);
	expect(await signedInAs(context)).toBeNull();
	await page.goto('/conta');
	await expect(page).toHaveURL(/\/entrar\?next=%2Fconta/);
	// The account is gone: its credentials no longer sign in.
	const again = await context.request.post(`${AUTH_FLOW_ORIGIN}/api/auth/sign-in/email`, {
		headers: { origin: AUTH_FLOW_ORIGIN, 'x-turnstile-token': DUMMY_TURNSTILE_TOKEN },
		data: { email, password }
	});
	expect(again.status()).toBe(401);
}

// The full flow once per locale; each run also exercises one closure policy, so both policies are
// covered with separate users without a third full run.
const RUNS: readonly { locale: Locale; mode: 'anonymize' | 'delete-all' }[] = [
	{ locale: 'pt-BR', mode: 'anonymize' },
	{ locale: 'en-US', mode: 'delete-all' }
];

for (const { locale, mode } of RUNS) {
	test(`password, other sessions, e-mail, export and closure (${locale}, ${mode})`, async ({
		browser
	}) => {
		const copy = catalog(locale);
		const here = await newContext(browser, locale);
		const elsewhere = await newContext(browser, locale);
		const email = await createVerifiedAccount(here.request);
		const page = await here.newPage();
		await uiSignIn(page, email);
		await apiSignIn(elsewhere, email);
		expect(await signedInAs(elsewhere)).toBe(email);

		// Change password (signing the other sessions out is the default).
		await open(page, '/conta');
		await expect(page.locator('html')).toHaveAttribute(
			'lang',
			new RegExp(`^${locale.slice(0, 2)}`)
		);
		await expectNoSeriousAxe(page);
		const password = form(page, 'password');
		await password.locator('input[name="currentPassword"]').fill(PASSWORD);
		await password.locator('input[name="newPassword"]').fill(NEW_PASSWORD);
		await password.locator('input[name="confirmPassword"]').fill(NEW_PASSWORD);
		await expect(password.locator('input[name="revokeOtherSessions"]')).toBeChecked();
		await password.getByRole('button', { name: copy.conta_password_submit, exact: true }).click();
		await signedOut(elsewhere);
		await expect(password.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
		// The current device stays signed in (its session is rotated, not lost).
		expect(await signedInAs(here)).toBe(email);

		// Sign out the other sessions from the list.
		await apiSignIn(elsewhere, email, NEW_PASSWORD);
		await open(page, '/conta');
		const others = form(page, 'revokeOthers').locator('button[type="submit"]');
		await expect(others).toBeEnabled();
		await others.click();
		await signedOut(elsewhere);
		expect(await signedInAs(here)).toBe(email);

		// Change e-mail: the current address confirms, then the new one.
		const newEmail = uniqueEmail();
		await open(page, '/conta');
		const change = form(page, 'email');
		await change.locator('input[name="newEmail"]').fill(newEmail);
		const passwordField = change.locator('input[name="password"]');
		if (await passwordField.count()) await passwordField.fill(NEW_PASSWORD);
		await turnstileReady(page);
		const before = (await mailbox(here.request, email)).length;
		await change.locator('button[type="submit"]').click();
		const pending = page.getByTestId('email-pending');
		await expect(pending).toContainText(copy.conta_email_pending_title ?? '');
		await expect(pending).toContainText(newEmail);
		const confirm = await waitForMail(here.request, email, before + 1);
		expect(await mailbox(here.request, newEmail)).toHaveLength(0);
		await page.goto(linkOf(confirm));
		const finalLink = linkOf(await waitForMail(here.request, newEmail));
		// The old address is told about the change.
		await waitForMail(here.request, email, before + 2);
		await page.goto(finalLink);
		await expect(page).toHaveURL(/\/conta\?email=alterado/);
		await expect(page.locator('#main-content')).toContainText(newEmail);
		expect(await signedInAs(here)).toBe(newEmail);

		// Export: a JSON attachment with the documented keys and no secrets.
		await open(page, '/conta');
		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page
				.locator('form[action="/conta/exportar"]')
				.getByRole('button', { name: copy.conta_export_submit, exact: true })
				.click()
		]);
		expect(download.suggestedFilename()).toMatch(/\.json$/);
		const text = await readFile(await download.path(), 'utf8');
		const document = JSON.parse(text) as Record<string, unknown>;
		expect(document.format).toBe('open-auri.account-export');
		expect(document.version).toBe(1);
		expect(text).toContain(newEmail);
		for (const secret of [PASSWORD, NEW_PASSWORD, 'scrypt$']) expect(text).not.toContain(secret);
		for (const cookie of await here.cookies()) {
			if (cookie.value.length >= 16) expect(text).not.toContain(cookie.value);
		}

		await closeAccount(page, here, copy, newEmail, NEW_PASSWORD, mode);
		await here.close();
		await elsewhere.close();
	});
}

test('/conta/encerrada is a static page: the same for anonymous and signed-in visitors', async ({
	browser
}) => {
	const anonymous = await newContext(browser, 'en-US');
	const signedIn = await newContext(browser);
	const email = await createVerifiedAccount(signedIn.request);
	await apiSignIn(signedIn, email);
	for (const context of [anonymous, signedIn]) {
		const page = await context.newPage();
		const response = await page.goto('/conta/encerrada');
		expect(response?.status()).toBe(200);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		// No account data on it: it is the landing page of an account that no longer exists.
		await expect(page.locator('#main-content')).not.toContainText(email);
	}
	await anonymous.close();
	await signedIn.close();
});

test('/admin is a 404 for a signed-in user who is not an admin', async ({ browser }) => {
	const context = await newContext(browser);
	const email = await createVerifiedAccount(context.request);
	const page = await context.newPage();
	await uiSignIn(page, email);
	for (const path of ['/admin', '/admin/usuarios', '/admin/auditoria']) {
		const response = await page.goto(path);
		expect(response?.status(), path).toBe(404);
	}
	const anonymous = await newContext(browser);
	const response = await (await anonymous.newPage()).goto('/admin');
	expect(response?.status()).toBe(404);
	await anonymous.close();
	await context.close();
});
