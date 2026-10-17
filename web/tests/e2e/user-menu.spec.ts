// User menu in the bar (FUX.1, spec §2.6, operator request). /docs is prerendered, so the
// chrome asks /api/auth/get-session itself: the test answers it (signed in as "ana") and
// stubs the Better Auth sign-out, so no real account is needed. Runs on desktop and mobile.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { barScope } from './helpers/b-ui';

const SESSION = {
	session: { id: 's-e2e', userId: 'u-e2e', expiresAt: '2099-01-01T00:00:00.000Z' },
	user: { id: 'u-e2e', username: 'ana', displayUsername: 'ana', emailVerified: true }
};

async function signedIn(page: Page): Promise<void> {
	let signedOut = false;
	await page.route('**/api/auth/get-session', (route: Route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(signedOut ? null : SESSION)
		})
	);
	await page.route('**/api/auth/sign-out', async (route: Route) => {
		expect(route.request().method()).toBe('POST');
		signedOut = true;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ success: true })
		});
	});
}

// The session answers come from page.route: keep the service worker out of the way.
test.use({ serviceWorkers: 'block' });

/** The account trigger: in the bar on desktop, in the menu sheet on mobile (FUX.NAV). */
const trigger = async (page: Page) =>
	(await barScope(page)).getByRole('button', { name: /^Conta:\s*ana$/ });

/** A press outside the menu: the page on desktop, the sheet's title when the sheet is open. */
async function pressOutside(page: Page): Promise<void> {
	const sheet = page.locator('[data-chrome="bar"]').getByRole('dialog', { name: /^Menu$/ });
	if (await sheet.isVisible()) {
		await sheet.getByRole('heading', { name: /^Menu$/ }).click();
		return;
	}
	await page.locator('#main-content').click({ position: { x: 2, y: 2 } });
}

test.beforeEach(async ({ page }) => {
	await signedIn(page);
	await page.goto('/docs');
	await expect(await trigger(page)).toBeVisible();
});

test('opens a menu with the account destinations, fixed below the name and not clipped', async ({
	page
}) => {
	const button = await trigger(page);
	await expect(button).toHaveAttribute('aria-haspopup', 'menu');
	await expect(button).toHaveAttribute('aria-expanded', 'false');
	await button.click();
	await expect(button).toHaveAttribute('aria-expanded', 'true');
	const menu = page.getByRole('menu', { name: /Conta:\s*ana/ });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole('menuitem')).toHaveText([
		'Minha conta',
		'Meu perfil público',
		'Minha biblioteca',
		'Sair'
	]);
	const account = menu.getByRole('menuitem', { name: 'Minha conta' });
	await expect(account).toHaveAttribute('href', '/conta');
	await expect(menu.getByRole('menuitem', { name: 'Meu perfil público' })).toHaveAttribute(
		'href',
		'/u/ana'
	);
	await expect(menu.getByRole('menuitem', { name: 'Minha biblioteca' })).toHaveAttribute(
		'href',
		'/biblioteca'
	);
	// Static pages never claim admin (the flag only comes from a resolved server session).
	await expect(menu.getByRole('menuitem', { name: 'Admin' })).toHaveCount(0);

	// Fixed under the trigger and fully hit-testable: the bar's horizontal scroll does not clip it.
	const popup = menu.locator('xpath=..');
	expect(await popup.evaluate((element) => getComputedStyle(element).position)).toBe('fixed');
	const buttonBox = await button.boundingBox();
	const menuBox = await popup.boundingBox();
	if (!buttonBox || !menuBox) throw new Error('Missing boxes');
	expect(menuBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height);
	await expect(menu.getByRole('menuitem', { name: 'Sair' })).toBeInViewport({ ratio: 1 });
	const hit = await menu.getByRole('menuitem', { name: 'Sair' }).evaluate((element) => {
		const rect = element.getBoundingClientRect();
		const x = rect.left + rect.width / 2;
		const y = rect.top + rect.height / 2;
		const target = document.elementFromPoint(x, y);
		return target !== null && element.contains(target);
	});
	expect(hit).toBe(true);

	const axe = await new AxeBuilder({ page }).include('[data-chrome="bar"]').analyze();
	expect(
		axe.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))
	).toEqual([]);
});

test('keyboard: arrows, Home/End, Escape returns focus, Tab closes', async ({ page }) => {
	const button = await trigger(page);
	await button.focus();
	await page.keyboard.press('ArrowDown');
	const menu = page.getByRole('menu');
	await expect(menu.getByRole('menuitem', { name: 'Minha conta' })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(menu.getByRole('menuitem', { name: 'Meu perfil público' })).toBeFocused();
	await page.keyboard.press('End');
	await expect(menu.getByRole('menuitem', { name: 'Sair' })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(menu.getByRole('menuitem', { name: 'Minha conta' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(button).toHaveAttribute('aria-expanded', 'false');
	await expect(button).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(menu.getByRole('menuitem', { name: 'Minha conta' })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(button).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('menu')).toHaveCount(0);
});

test('a click outside closes it; a link navigates', async ({ page }) => {
	const button = await trigger(page);
	await button.click();
	await expect(page.getByRole('menu')).toBeVisible();
	await pressOutside(page);
	await expect(button).toHaveAttribute('aria-expanded', 'false');
	await button.click();
	await page.getByRole('menuitem', { name: 'Minha biblioteca' }).click();
	await expect(page).toHaveURL(/\/biblioteca$/);
});

test('Sair ends the session with the existing sign-out and shows "Entrar" again', async ({
	page
}) => {
	const signOut = page.waitForRequest(
		(request) => request.url().endsWith('/api/auth/sign-out') && request.method() === 'POST'
	);
	await (await trigger(page)).click();
	await page.getByRole('menuitem', { name: 'Sair' }).click();
	await signOut;
	const entry = page.locator('[data-chrome="bar"] a[data-account]');
	await expect(entry).toHaveText('Entrar');
	await expect(entry).toHaveAttribute('data-account', 'anonymous');
});
