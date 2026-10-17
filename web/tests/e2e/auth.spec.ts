// Auth e2e against the built Worker in local test mode (project `auth-flow`, port 4174:
// SIGNUP_ENABLED=true, EMAIL_TRANSPORT=capture; links come from the dev mailbox). Both locales.
import { expect, test } from '@playwright/test';
import {
	AUTH_SUBMIT_TIMEOUT_MS,
	createVerifiedAccount,
	linkOf,
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

// Several scrypt form actions, captured mails and runtime mounts per test while the whole suite
// shares the machine: the default 30 s is not enough (account.spec.ts gives 2 minutes).
test.describe.configure({ mode: 'parallel', timeout: 90_000 });

/** Waits for a form action answered by the Worker (scrypt, mail) under the shared load. */
const submitted = { timeout: AUTH_SUBMIT_TIMEOUT_MS };

const LOCALES: readonly Locale[] = ['pt-BR', 'en-US'];

for (const locale of LOCALES) {
	test(`sign-up → verification link → sign-in (${locale})`, async ({ browser }) => {
		const context = await newContext(browser, locale);
		const page = await context.newPage();
		const email = uniqueEmail();

		await open(page, '/criar-conta?next=%2Fconta');
		await expect(page.locator('html')).toHaveAttribute(
			'lang',
			new RegExp(`^${locale.slice(0, 2)}`)
		);
		const form = page.locator('#main-content form').first();
		await form.locator('input[name="email"]').fill(email);
		await form.locator('input[name="password"]').fill(PASSWORD);
		await form.locator('input[name="confirm"]').fill(PASSWORD);
		await turnstileReady(page);
		await form.locator('button[type="submit"]').click();
		await expect(page).toHaveURL(/\/verificar-email\?.*enviado=1/, submitted);

		// Not verified yet: the account exists but cannot sign in.
		expect(await signedInAs(context)).toBeNull();
		const mail = await waitForMail(context.request, email);
		expect(mail.subject.length).toBeGreaterThan(0);
		await page.goto(linkOf(mail));
		await expect(page).toHaveURL(/\/verificar-email\?.*verificado=1/, submitted);
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		// The link signs nobody in.
		expect(await signedInAs(context)).toBeNull();

		await uiSignIn(page, email);
		expect(await signedInAs(context)).toBe(email);
		await expect(page.locator('#main-content')).toContainText(email);
		await context.close();
	});
}

test('the verification e-mail follows the language of the visitor', async ({ browser }) => {
	const subjects: string[] = [];
	for (const locale of LOCALES) {
		const context = await newContext(browser, locale);
		const page = await context.newPage();
		const email = uniqueEmail();
		await open(page, '/criar-conta');
		const form = page.locator('#main-content form').first();
		await form.locator('input[name="email"]').fill(email);
		await form.locator('input[name="password"]').fill(PASSWORD);
		await form.locator('input[name="confirm"]').fill(PASSWORD);
		await turnstileReady(page);
		await form.locator('button[type="submit"]').click();
		await expect(page).toHaveURL(/enviado=1/, submitted);
		subjects.push((await waitForMail(context.request, email)).subject);
		await context.close();
	}
	expect(new Set(subjects).size).toBe(2);
});

test('keyboard only: Tab to the form, type, Enter signs in', async ({ browser }) => {
	const context = await newContext(browser);
	const email = await createVerifiedAccount(context.request);
	const page = await context.newPage();
	await open(page, '/entrar?next=%2Fconta');
	await turnstileReady(page);

	let reached = false;
	for (let press = 0; press < 60 && !reached; press += 1) {
		await page.keyboard.press('Tab');
		reached = await page.evaluate(
			() => (document.activeElement as HTMLInputElement | null)?.name === 'email'
		);
	}
	expect(reached, 'Tab reaches the e-mail field').toBe(true);
	await page.keyboard.type(email);
	await page.keyboard.press('Tab');
	await expect(page.locator('input[name="password"]')).toBeFocused();
	await page.keyboard.type(PASSWORD);
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/\/conta(\?|$)/, submitted);
	expect(await signedInAs(context)).toBe(email);
	await context.close();
});

test('wrong password and unknown address get the same answer and no session', async ({
	browser
}) => {
	const context = await newContext(browser);
	const email = await createVerifiedAccount(context.request);
	const page = await context.newPage();
	const answers: string[] = [];
	for (const address of [email, uniqueEmail()]) {
		await open(page, '/entrar');
		const form = page.locator('#main-content form').first();
		await form.locator('input[name="email"]').fill(address);
		await form.locator('input[name="password"]').fill('definitely wrong 000');
		await turnstileReady(page);
		await form.locator('button[type="submit"]').click();
		const alert = page.getByRole('alert').filter({ hasText: /\S/ }).first();
		await expect(alert).toBeVisible(submitted);
		const text = (await alert.textContent())?.trim() ?? '';
		expect(text).not.toContain(address);
		answers.push(text);
		await expect(page).toHaveURL(/\/entrar/);
	}
	expect(new Set(answers).size).toBe(1);
	expect(await signedInAs(context)).toBeNull();
	await context.close();
});

test('password reset through the mailed link; the link works once', async ({ browser }) => {
	const context = await newContext(browser);
	const email = await createVerifiedAccount(context.request);
	const page = await context.newPage();
	await open(page, '/esqueci-senha');
	const form = page.locator('#main-content form').first();
	await form.locator('input[name="email"]').fill(email);
	await turnstileReady(page);
	await form.locator('button[type="submit"]').click();
	const link = linkOf(await waitForMail(context.request, email, 2));
	expect(link).toMatch(/^\/redefinir-senha\?token=/);

	const newPassword = 'reset via e2e 4242';
	for (const attempt of [1, 2]) {
		await open(page, link);
		const reset = page.locator('#main-content form').first();
		await reset.locator('input[name="password"]').fill(newPassword);
		await reset.locator('input[name="confirm"]').fill(newPassword);
		await reset.locator('button[type="submit"]').click();
		if (attempt === 1) await expect(page).toHaveURL(/\/entrar\?.*redefinida=1/, submitted);
		else
			await expect(page.getByRole('alert').filter({ hasText: /\S/ }).first()).toBeVisible(
				submitted
			);
	}
	await uiSignIn(page, email, newPassword);
	await context.close();
});
