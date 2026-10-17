// /comunidade e2e against the built Worker in local test mode (:4174: sign-up open, captured
// e-mail, Turnstile stub; contexts from helpers/auth-flow.ts with a random CF-Connecting-IP each).
// Both languages (expected copy read from web/messages/*.json):
//   - anonymous: browse the console, listen to a channel (SOLO), every social action shows the
//     sign-in prompt that comes back to /comunidade, publishing is disabled; axe clean;
//   - feed windows: recent / most favorited / most installed × 7d / 30d / all, each a real
//     GET /api/v1/feed with the matching query;
//   - "NO AR / Publicar": a GATE_REJECTED answer (the server's error shape, injected once: the
//     editor itself only admits gate-approved curves) lists the reasons and leaves the lamp off;
//     the real server's approval of the same curve lights it; axe clean signed in.
// Seeded curves are published by fresh accounts per run (the local D1 persists between runs).
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
	apiSignIn,
	createVerifiedAccount,
	expectNoSeriousAxe,
	newContext,
	open,
	type Locale
} from './helpers/auth-flow';
import {
	apoCurve,
	catalog,
	escapeRegExp,
	fill,
	importCurve,
	navigate,
	openCurvaPage,
	publishOnCurva,
	setNickname,
	text,
	uniqueCurveName,
	uniqueNickname,
	type Copy
} from './helpers/social-flow';

test.describe.configure({ mode: 'parallel', timeout: 180_000 });

const LOCALES: readonly Locale[] = ['pt-BR', 'en-US'];

/** The project's viewport (contexts made by `newContext` start at the browser default). */
async function projectViewport(page: Page): Promise<void> {
	const viewport = test.info().project.use.viewport;
	if (viewport) await page.setViewportSize(viewport);
}

/** One public curve published from the Curva page by a fresh pt-BR account. */
async function seedPublicCurve(browser: Browser): Promise<string> {
	const context = await newContext(browser, 'pt-BR');
	try {
		const email = await createVerifiedAccount(context.request);
		await apiSignIn(context, email);
		const page = await context.newPage();
		await setNickname(page, uniqueNickname('com'));
		const name = uniqueCurveName('E2E comunidade');
		await publishOnCurva(
			page,
			catalog('pt-BR'),
			apoCurve(-3, { hz: 800, db: 1.5, q: 1 }, { hz: 6000, db: -2, q: 0.7 }),
			name
		);
		return name;
	} finally {
		await context.close();
	}
}

/** Opens /comunidade; `viaMenu` keeps the running app (the editor curve just imported). */
async function openCommunity(
	page: Page,
	copy: Copy,
	locale: Locale,
	viaMenu = false
): Promise<void> {
	if (viaMenu) await navigate(page, '/comunidade');
	else await open(page, '/comunidade');
	await expect(page.locator('html')).toHaveAttribute('lang', new RegExp(`^${locale.slice(0, 2)}`));
	await expect(
		page.getByRole('heading', { level: 1, name: text(copy, 'comunidade_title'), exact: true })
	).toBeVisible();
}

/** The channel strip of `name` in the "new" feed, loading more pages when needed. */
async function channel(page: Page, copy: Copy, name: string) {
	const bank = page.getByRole('list', {
		name: text(copy, 'comunidade_console_title'),
		exact: true
	});
	await expect(bank).toBeVisible({ timeout: 15_000 });
	// Direct children only: a strip may contain lists of its own.
	const strips = bank.locator(':scope > li');
	// Keyed on the curve's page link: the SOLO button's name changes while the channel plays.
	const strip = strips.filter({ has: page.getByRole('link', { name, exact: true }) });
	const more = page.getByRole('button', { name: text(copy, 'comunidade_load_more'), exact: true });
	for (let attempt = 0; attempt < 10 && (await strip.count()) === 0; attempt += 1) {
		if ((await more.count()) === 0) break;
		const before = await strips.count();
		await more.click();
		await expect(strips).not.toHaveCount(before);
	}
	await expect(strip).toHaveCount(1);
	return strip;
}

for (const locale of LOCALES) {
	test(`anonymous: browse, listen, sign-in prompts, a11y (${locale})`, async ({ browser }) => {
		const name = await seedPublicCurve(browser);
		const copy = catalog(locale);
		const context = await newContext(browser, locale);
		const page = await context.newPage();
		await projectViewport(page);
		await openCommunity(page, copy, locale);

		// Browse: the seeded public curve is a channel of the "new" feed.
		const strip = await channel(page, copy, name);
		await expect(strip).toHaveAttribute('aria-label', new RegExp(`${escapeRegExp(name)}$`));

		// Listen without an account (SOLO): the channel plays, then stops.
		const solo = strip.getByRole('button', {
			name: fill(copy, 'comunidade_channel_listen', { name }),
			exact: true
		});
		await solo.click();
		const stop = strip.getByRole('button', {
			name: fill(copy, 'comunidade_channel_stop', { name }),
			exact: true
		});
		await expect(stop).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
		await stop.click();
		await expect(solo).toHaveAttribute('aria-pressed', 'false');

		// Social actions ask for an account; the link comes back here. Publishing is off.
		const prompts = page.getByTestId('login-prompt');
		await expect(prompts.first()).toBeVisible();
		await expect(prompts.first()).toContainText(text(copy, 'comunidade_login_prompt'));
		const signIn = prompts
			.first()
			.getByRole('link', { name: text(copy, 'comunidade_login_link'), exact: true });
		await expect(signIn).toHaveAttribute('href', /^\/entrar\?next=%2Fcomunidade/);
		await expect(
			page.getByRole('button', { name: text(copy, 'comunidade_onair_publish'), exact: true })
		).toBeDisabled();
		await expect(page.getByTestId('onair-lamp')).toHaveAttribute('data-lit', 'false');

		await expectNoSeriousAxe(page);
		await context.close();
	});

	test(`feed windows: recent, favorites and installs × 7d / 30d / all (${locale})`, async ({
		browser
	}) => {
		const copy = catalog(locale);
		const context = await newContext(browser, locale);
		const page = await context.newPage();
		await projectViewport(page);
		const firstFeed = page.waitForRequest((request) => request.url().includes('/api/v1/feed'));
		await openCommunity(page, copy, locale);
		expect(new URL((await firstFeed).url()).searchParams.get('sort') ?? 'new').toBe('new');

		const sorts = page.getByRole('group', {
			name: text(copy, 'comunidade_sort_label'),
			exact: true
		});
		const windows = page.getByRole('group', {
			name: text(copy, 'comunidade_window_label'),
			exact: true
		});
		// "Recentes" has no window: it is not a ranking.
		await expect(
			sorts.getByRole('button', { name: text(copy, 'comunidade_sort_new'), exact: true })
		).toHaveAttribute('aria-pressed', 'true');
		await expect(windows).toHaveCount(0);

		for (const [sortKey, sort] of [
			['comunidade_sort_favorites', 'favorites'],
			['comunidade_sort_installs', 'installs']
		] as const) {
			const sortButton = sorts.getByRole('button', { name: text(copy, sortKey), exact: true });
			const sorted = page.waitForRequest((request) => {
				const url = new URL(request.url());
				return url.pathname === '/api/v1/feed' && url.searchParams.get('sort') === sort;
			});
			await sortButton.click();
			await expect(sortButton).toHaveAttribute('aria-pressed', 'true');
			expect(new URL((await sorted).url()).searchParams.get('window')).toMatch(/^(7d|30d|all)$/);
			await expect(windows).toBeVisible();
			for (const [windowKey, window] of [
				['comunidade_window_30d', '30d'],
				['comunidade_window_all', 'all'],
				['comunidade_window_7d', '7d']
			] as const) {
				const windowButton = windows.getByRole('button', {
					name: text(copy, windowKey),
					exact: true
				});
				const requested = page.waitForRequest((request) => {
					const url = new URL(request.url());
					return (
						url.pathname === '/api/v1/feed' &&
						url.searchParams.get('sort') === sort &&
						url.searchParams.get('window') === window
					);
				});
				await windowButton.click();
				await expect(windowButton).toHaveAttribute('aria-pressed', 'true');
				const response = await (await requested).response();
				expect(response?.status()).toBe(200);
				// Either channels or the empty-ranking state, never an error.
				await expect(
					page
						.getByRole('list', { name: text(copy, 'comunidade_console_title'), exact: true })
						.or(page.getByTestId('feed-empty'))
				).toBeVisible();
				await expect(page.getByTestId('feed-offline')).toHaveCount(0);
			}
		}

		await sorts
			.getByRole('button', { name: text(copy, 'comunidade_sort_new'), exact: true })
			.click();
		await expect(windows).toHaveCount(0);
		await context.close();
	});

	test(`NO AR: the lamp lights only after the server approved the curve (${locale})`, async ({
		browser
	}) => {
		const copy = catalog(locale);
		const context = await newContext(browser, locale);
		const email = await createVerifiedAccount(context.request);
		await apiSignIn(context, email);
		const page = await context.newPage();
		await projectViewport(page);
		await setNickname(page, uniqueNickname('air'));

		// The editor only admits curves the (shared) gate approves (the import refuses the rest),
		// so a server refusal cannot be reached with a real curve from the UI. The real server gate
		// is covered by the integration tests (gate parity); here the first publication answer is
		// replaced by the server's GATE_REJECTED shape, to prove the lamp follows the server answer
		// and never a local check. The second click goes to the real server.
		await openCurvaPage(page, copy);
		await importCurve(page, copy, apoCurve(-3.5, { hz: 1500, db: 2, q: 1 }), 'on-air.txt');
		await openCommunity(page, copy, locale, true);
		let refused = 0;
		await page.route('**/api/v1/curves', async (route) => {
			if (route.request().method() !== 'POST' || refused > 0) {
				await route.fallback();
				return;
			}
			refused += 1;
			await route.fulfill({
				status: 422,
				contentType: 'application/json',
				body: JSON.stringify({
					error: { code: 'GATE_REJECTED', details: { reasons: ['level'] } }
				})
			});
		});
		const onAir = page.locator('#publicar');
		const lamp = onAir.getByTestId('onair-lamp');
		const publish = onAir.getByRole('button', {
			name: text(copy, 'comunidade_onair_publish'),
			exact: true
		});
		const name = onAir.getByRole('textbox', { name: text(copy, 'comunidade_onair_name') });
		await expect(name).toBeEnabled({ timeout: 15_000 });
		await expect(onAir.getByTestId('login-prompt')).toHaveCount(0);
		const curveName = uniqueCurveName('E2E no ar');
		await name.fill(curveName);
		await expect(lamp).toHaveAttribute('data-lit', 'false');
		await expect(onAir.getByTestId('onair-s1')).not.toBeEmpty();
		await expect(onAir.getByTestId('onair-s5')).toContainText('open-auri/preset@1');
		await expect(publish).toBeEnabled();
		await publish.click();
		const refusal = onAir.getByRole('alert');
		await expect(refusal).toContainText(text(copy, 'comunidade_gate_rejected'), {
			timeout: 15_000
		});
		await expect(onAir.getByTestId('gate-reasons').getByRole('listitem').first()).toBeVisible();
		await expect(lamp).toHaveAttribute('data-lit', 'false');
		await expect(onAir).toContainText(text(copy, 'comunidade_onair_off'));
		expect(refused).toBe(1);

		// The real server approves the same curve: the lamp lights after its answer, with the link.
		await expect(publish).toBeEnabled();
		await publish.click();
		await expect(onAir.getByRole('alert')).toContainText(text(copy, 'comunidade_onair_published'), {
			timeout: 15_000
		});
		await expect(lamp).toHaveAttribute('data-lit', 'true');
		await expect(onAir).toContainText(text(copy, 'comunidade_onair_lit'));
		const pageLink = onAir.getByRole('link', {
			name: text(copy, 'comunidade_onair_open'),
			exact: true
		});
		await expect(pageLink).toHaveAttribute('href', /^\/c\/[^/?#]+$/);
		// The "new" feed is reloaded and carries the new channel.
		await channel(page, copy, curveName);
		await expectNoSeriousAxe(page);

		// The public page of the new curve answers for anyone.
		const href = (await pageLink.getAttribute('href')) ?? '';
		const anonymous = await newContext(browser, locale);
		const response = await anonymous.request.get(href);
		expect(response.status()).toBe(200);
		await anonymous.close();
		await context.close();
	});
}
