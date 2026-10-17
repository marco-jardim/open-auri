// Phase 4 social end-to-end scenario (plan T4.T "Caso E2E"), against the built Worker in local
// test mode on :4174 (sign-up open, captured e-mail, Turnstile stub; contexts from
// helpers/auth-flow.ts, each with its own random CF-Connecting-IP):
//   1. user A publishes (Curva page, server gate);
//   2. A creates the short share link;
//   3. user B opens /c/[id] (OG meta present), favorites it, listens 10 s on the Curva page
//      ("experimentou") and installs it with a real write through the HID stub ("instalou");
//   4. the rankings reflect the activity after the job (dev-only job trigger, no cron locally);
//   5. A sees the audience respecting B's privacy (private: count only; public: nickname);
//   6. B deletes their own activity and the counts drop;
//   7. a local (anonymous) library is merged into B's account at sign-in;
//   8. S7 blind trade completed between A and B (join, score, reveal);
//   9. reports by 3 eligible accounts hide the curve; an admin restores it.
// Accounts are created per run (the local D1 persists between runs); nothing depends on global
// counts. Admin role, its 2FA marker and the reporters' account age are set on the LOCAL database
// (helpers/social-flow.ts `d1Local`), the only steps no API offers by design.
//
// Server state is shared by the whole scenario, so it runs once (desktop or auth-flow project),
// never in parallel with itself.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
	apiSignIn,
	createVerifiedAccount,
	newContext,
	open,
	PASSWORD,
	signedInAs,
	uiSignIn
} from './helpers/auth-flow';
import { installHidStub } from './helpers/b-hid';
import {
	closeChecklist,
	confirmBasics,
	connectCable,
	goToCable,
	openChecklist
} from './helpers/b-ui';
import { startPreview } from './helpers/c-audio';
import {
	adminSql,
	ageAccountsSql,
	api,
	apoCurve,
	audienceOf,
	catalog,
	closeAll,
	curvaSocial,
	curveInfo,
	d1Local,
	escapeRegExp,
	importCurve,
	joinTrade,
	lead,
	myActivity,
	navigate,
	openCurvaPage,
	publishOnCurva,
	rankingEntry,
	runJob,
	setActivityVisibility,
	setNickname,
	text,
	tradeById,
	uniqueCurveName,
	uniqueNickname,
	waitForActivity,
	type TradeDto
} from './helpers/social-flow';

test.describe.configure({ mode: 'serial' });

// The scenario is in pt-BR (the cable helpers match the pt-BR labels); community.spec.ts covers
// both languages.
const copy = catalog('pt-BR');

interface Actor {
	context: BrowserContext;
	page: Page;
	email: string;
	nickname: string;
}

async function actor(browser: Browser): Promise<Actor> {
	const context = await newContext(browser, 'pt-BR');
	const email = await createVerifiedAccount(context.request);
	const page = await context.newPage();
	await uiSignIn(page, email);
	const nickname = uniqueNickname();
	await setNickname(page, nickname);
	return { context, page, email, nickname };
}

/** Anonymous status of /c/[id] (404 while hidden by moderation). */
async function publicStatus(browser: Browser, lineageId: string): Promise<number> {
	const anonymous = await newContext(browser, 'pt-BR');
	try {
		const response = await anonymous.request.get(`/c/${encodeURIComponent(lineageId)}`, {
			maxRedirects: 0
		});
		return response.status();
	} finally {
		await anonymous.close();
	}
}

/**
 * Empties the S7 waiting queue of leftovers of earlier (interrupted) runs, which would otherwise
 * pair with B instead of A: a throwaway account joins with A's public lineage; if it was matched
 * at once a stale trade was waiting (try again with a fresh account), otherwise the queue was
 * empty and its own waiting trade is cancelled.
 */
async function drainTradeQueue(browser: Browser, lineageId: string): Promise<void> {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const sink = await newContext(browser, 'pt-BR');
		try {
			const email = await createVerifiedAccount(sink.request);
			await apiSignIn(sink, email);
			const trade = await joinTrade(sink.request, lineageId);
			if (trade.status === 'waiting') {
				const cancelled = await api(
					sink.request,
					'DELETE',
					`/api/v1/trades/${encodeURIComponent(trade.id)}`
				);
				expect(cancelled.status).toBeLessThan(300);
				return;
			}
		} finally {
			await sink.close();
		}
	}
	throw new Error('the S7 queue still had stale waiting trades after 4 throwaway joins');
}

test('A publishes, B listens, favorites and installs; rankings, privacy, deletion, merge, S7, moderation', async ({
	browser
}, testInfo) => {
	test.skip(
		testInfo.project.name === 'mobile',
		'one run of the shared-state scenario is enough (desktop or auth-flow project)'
	);
	// Several accounts (scrypt), a 10 s audible preview, a real-timing cable write, jobs and a few
	// local `wrangler d1 execute` calls.
	test.setTimeout(600_000);
	const contexts: BrowserContext[] = [];

	// ---- 1–2. A publishes and shares --------------------------------------------------------------
	const a = await actor(browser);
	contexts.push(a.context);
	const curveName = uniqueCurveName('E2E social');
	const published = await test.step('1–2. A publishes and creates the share link', async () =>
		publishOnCurva(
			a.page,
			copy,
			apoCurve(-3, { hz: 1000, db: 2, q: 1 }, { hz: 120, db: -1.5, q: 0.8 }),
			curveName
		));
	const lineageId = published.lineageId;
	const info = await curveInfo(a.context.request, lineageId);
	expect(info.visibility).toBe('public');
	const shareUrl = new URL(published.shareUrl);

	// ---- 3. B opens the link, favorites, listens 10 s and installs --------------------------------
	const bContext = await newContext(browser, 'pt-BR');
	contexts.push(bContext);
	const bEmail = await createVerifiedAccount(bContext.request);
	const bPage = await bContext.newPage();
	await installHidStub(bPage);
	await uiSignIn(bPage, bEmail);
	const bNickname = uniqueNickname();
	await setNickname(bPage, bNickname);
	const b: Actor = { context: bContext, page: bPage, email: bEmail, nickname: bNickname };

	await test.step('3a. /c/[id] from the share link: card and OG meta', async () => {
		const response = await b.page.goto(`${shareUrl.pathname}${shareUrl.search}`);
		expect(response?.status()).toBe(200);
		// Server-rendered card: wait for hydration before using its buttons (the chrome's audio
		// button is enabled after mount), otherwise a click lands on inert HTML.
		await expect(b.page.locator('[data-chrome="bar"] button[popovertarget]')).toBeEnabled();
		await expect(b.page.getByRole('heading', { level: 1, name: curveName })).toBeVisible();
		await expect(b.page.getByTestId('shared-curve-author')).toContainText(a.nickname);
		const head = b.page.locator('head');
		await expect(head.locator('meta[property="og:title"]')).toHaveAttribute('content', curveName);
		await expect(head.locator('meta[property="og:type"]')).toHaveAttribute('content', 'website');
		await expect(head.locator('meta[name="twitter:card"]')).toHaveAttribute(
			'content',
			'summary_large_image'
		);
		const image = await head.locator('meta[property="og:image"]').getAttribute('content');
		expect(image).toMatch(new RegExp(`/og/${escapeRegExp(info.versionId)}\\.png$`));
		const og = await b.context.request.get(new URL(image ?? '', shareUrl).pathname);
		expect(og.status()).toBe(200);
		expect(og.headers()['content-type']).toContain('image/png');
		await expect(head.locator('link[rel="canonical"]')).toHaveAttribute(
			'href',
			new RegExp(`/c/${escapeRegExp(lineageId)}$`)
		);
	});

	await test.step('3b. B favorites on /c/[id]', async () => {
		const favorite = b.page.getByRole('button', {
			name: text(copy, 'shared_curve_favorite'),
			exact: true
		});
		const [answer] = await Promise.all([
			b.page.waitForResponse(
				(candidate) =>
					candidate.request().method() === 'PUT' &&
					new URL(candidate.url()).pathname ===
						`/api/v1/curves/${encodeURIComponent(lineageId)}/favorite`
			),
			favorite.click()
		]);
		expect(answer.status()).toBeLessThan(300);
		// Opened from the share link: the favorite carries the share id (funnel).
		expect(new URL(answer.url()).searchParams.get('s')).toBe(shareUrl.searchParams.get('s'));
		const favorited = b.page.getByRole('button', {
			name: text(copy, 'shared_curve_favorited'),
			exact: true
		});
		await expect(favorited).toHaveAttribute('aria-pressed', 'true');
	});

	await test.step('3c. "Abrir na Curva", 10 s of audible preview → experimentou', async () => {
		await b.page.getByRole('link', { name: text(copy, 'shared_curve_open'), exact: true }).click();
		await expect(b.page.locator('[data-chrome="bar"] button[popovertarget]')).toBeEnabled();
		// The page confirms the version through the API before remembering the origin; the favorite
		// made on /c/[id] shows here as "Remover favorito".
		await expect(
			curvaSocial(b.page, copy).getByRole('button', {
				name: text(copy, 'curva_social_unfavorite'),
				exact: true
			})
		).toBeVisible({ timeout: 15_000 });
		expect(
			(await myActivity(b.context.request)).filter((item) => item.lineageId === lineageId)
		).toEqual([]);
		await startPreview(b.page);
		// "experimentou" needs ≥ 10 s of audible audio-context time on side B.
		await waitForActivity(b.context.request, lineageId, 'previewed', 45_000);
	});

	await test.step('3d. real write through the HID stub → instalou', async () => {
		await goToCable(b.page);
		await connectCable(b.page);
		const dialog = await openChecklist(b.page);
		await confirmBasics(dialog);
		const write = dialog.getByRole('button', { name: 'Gravar no cabo', exact: true });
		await expect(write).toBeEnabled();
		await write.click();
		await expect(dialog.getByRole('status')).toHaveText(/^Gravado no cabo\. CRC /);
		await closeChecklist(dialog);
		// Back to the Curva page (client-side, like a user): its social block flushes the outbox
		// too, so the event does not depend on which component flushed first.
		await b.page
			.getByRole('navigation', { name: 'Principal', exact: true })
			.getByRole('link', { name: 'Curva', exact: true })
			.click();
		await waitForActivity(b.context.request, lineageId, 'installed');
	});

	// ---- 4. Rankings after the job ------------------------------------------------------------------
	await test.step('4. rankings reflect the activity after the job', async () => {
		await runJob(a.context.request, 'rankings');
		const favorites = await rankingEntry(a.context.request, 'favorites', '7d', lineageId);
		expect(favorites?.score).toBeGreaterThanOrEqual(1);
		const installs = await rankingEntry(a.context.request, 'installs', '7d', lineageId);
		expect(installs?.score).toBeGreaterThanOrEqual(1);
		// Anonymous visitors see the same ranking (it is public).
		const anonymous = await newContext(browser, 'pt-BR');
		try {
			const entry = await rankingEntry(anonymous.request, 'favorites', 'all', lineageId);
			expect(entry?.score).toBeGreaterThanOrEqual(1);
		} finally {
			await anonymous.close();
		}
	});

	// ---- 5. Audience and privacy ----------------------------------------------------------------
	await test.step('5. A sees the audience; B private → count only, public → nickname', async () => {
		const kinds = ['previewed', 'installed', 'favorited'] as const;
		const privateView = await audienceOf(a.context.request, lineageId);
		for (const kind of kinds) {
			expect(privateView[kind].total, kind).toBe(1);
			expect(privateView[kind].privateCount, kind).toBe(1);
			expect(privateView[kind].named, kind).toEqual([]);
		}
		expect(JSON.stringify(privateView)).not.toContain(b.nickname);
		// Only the owner reads the audience.
		expect(
			(await api(b.context.request, 'GET', `/api/v1/curves/${lineageId}/audience`)).status
		).toBe(404);

		await setActivityVisibility(b.page, 'public');
		const publicView = await audienceOf(a.context.request, lineageId);
		for (const kind of kinds) {
			expect(publicView[kind].total, kind).toBe(1);
			expect(publicView[kind].privateCount, kind).toBe(0);
			expect(
				publicView[kind].named.map((person) => person.username),
				kind
			).toEqual([b.nickname]);
		}
	});

	// ---- 6. B deletes their own activity -----------------------------------------------------------
	await test.step('6. B deletes their own activity and the counts drop', async () => {
		const deleted = await api<{ deleted: number }>(
			b.context.request,
			'DELETE',
			`/api/v1/me/activity?lineageId=${encodeURIComponent(lineageId)}`
		);
		expect(deleted.status).toBe(200);
		expect(deleted.body.deleted).toBeGreaterThanOrEqual(2);
		expect(
			(await myActivity(b.context.request)).filter((item) => item.lineageId === lineageId)
		).toEqual([]);
		const after = await audienceOf(a.context.request, lineageId);
		expect(after.previewed.total).toBe(0);
		expect(after.installed.total).toBe(0);
		expect(after.previewed.named).toEqual([]);
		expect(after.installed.named).toEqual([]);
		await runJob(a.context.request, 'rankings');
		const installs = await rankingEntry(a.context.request, 'installs', '7d', lineageId);
		expect(installs === null || installs.score === 0).toBe(true);
	});

	// ---- 7. Local library merged at sign-in -------------------------------------------------------
	await test.step('7. a local library is merged into the account at sign-in', async () => {
		type Created = { items: { id: string; head: { name: string } }[] };
		const createdPath = '/api/v1/me/library?shelf=created&limit=100';
		const before = await api<Created>(b.context.request, 'GET', createdPath);
		expect(before.status).toBe(200);

		const device = await newContext(browser, 'pt-BR');
		contexts.push(device);
		const page = await device.newPage();
		await openCurvaPage(page, copy);
		// The import names the editor curve "Importado" (not the file name).
		await importCurve(
			page,
			copy,
			apoCurve(-4, { hz: 2500, db: 1.5, q: 1.2 }, { hz: 60, db: 1, q: 0.7 }),
			'merge.txt'
		);
		// Through the menu: the running app keeps the editor curve just imported.
		await navigate(page, '/biblioteca');
		const local = page.getByRole('region', { name: text(copy, 'biblioteca_local'), exact: true });
		await page.getByRole('button', { name: text(copy, 'biblioteca_save'), exact: true }).click();
		await expect(page.getByText(text(copy, 'biblioteca_saved'), { exact: true })).toBeVisible();
		await expect(local).not.toContainText(text(copy, 'biblioteca_local_error'));
		await expect(local).not.toContainText(text(copy, 'empty_library_body'));
		// The local library lives in IndexedDB: the saved curve must survive a reload while still
		// anonymous (otherwise there is nothing to merge at sign-in).
		await open(page, '/biblioteca');
		await expect(
			local,
			'the saved local curve survives a reload (IndexedDB, not memory)'
		).not.toContainText(text(copy, 'empty_library_body'), { timeout: 10_000 });
		expect(await signedInAs(device)).toBeNull();

		await uiSignIn(page, b.email, PASSWORD, '/biblioteca');
		await expect(
			local,
			'the anonymous local library is still there after sign-in'
		).not.toContainText(text(copy, 'empty_library_body'), { timeout: 10_000 });
		const banner = page.getByRole('region', {
			name: text(copy, 'biblioteca_social_merge_title'),
			exact: true
		});
		await expect(banner).toBeVisible({ timeout: 15_000 });
		await banner
			.getByRole('button', { name: text(copy, 'biblioteca_social_merge_action'), exact: true })
			.click();
		const report = page.getByRole('region', {
			name: text(copy, 'biblioteca_social_merge_report'),
			exact: true
		});
		await expect(report).toBeVisible({ timeout: 15_000 });
		await expect(report).toContainText(
			new RegExp(`${escapeRegExp(lead(copy, 'biblioteca_social_merge_created'))}\\s*[1-9]`)
		);
		const created = await api<Created>(device.request, 'GET', createdPath);
		expect(created.status).toBe(200);
		const known = new Set(before.body.items.map((item) => item.id));
		expect(created.body.items.filter((item) => !known.has(item.id)).length).toBeGreaterThan(0);
	});

	// ---- 8. S7 between A and B -----------------------------------------------------------------
	await test.step('8. S7 blind trade between A and B: join, score, reveal', async () => {
		const bCurve = await publishOnCurva(
			b.page,
			copy,
			apoCurve(-3.5, { hz: 4000, db: -2, q: 0.9 }, { hz: 250, db: 1, q: 1.1 }),
			uniqueCurveName('E2E S7')
		);
		const bInfo = await curveInfo(b.context.request, bCurve.lineageId);
		await drainTradeQueue(browser, lineageId);

		const bTrade = await joinTrade(b.context.request, bInfo.lineageId, bInfo.versionId);
		expect(bTrade.status).toBe('waiting');
		const aTrade = await joinTrade(a.context.request, lineageId, info.versionId);
		expect(aTrade.status).toBe('matched');

		// Blind: each side sees only the other curve.
		const aBlind = await tradeById(a.context.request, aTrade.id);
		const bBlind = await tradeById(b.context.request, bTrade.id);
		expect(aBlind.partner).toEqual(expect.objectContaining({ revealed: false, s1: bInfo.s1 }));
		expect(bBlind.status).toBe('matched');
		expect(bBlind.partner).toEqual(expect.objectContaining({ revealed: false, s1: info.s1 }));
		expect(JSON.stringify(aBlind)).not.toContain(b.nickname);
		expect(JSON.stringify(bBlind)).not.toContain(a.nickname);

		const aScore = await api(a.context.request, 'POST', `/api/v1/trades/${aTrade.id}/score`, {
			score: 4
		});
		expect(aScore.status).toBeLessThan(300);
		expect((await tradeById(a.context.request, aTrade.id)).partner?.revealed).toBe(false);
		const bScore = await api(b.context.request, 'POST', `/api/v1/trades/${bTrade.id}/score`, {
			score: 5
		});
		expect(bScore.status).toBeLessThan(300);

		const revealedA: TradeDto = await tradeById(a.context.request, aTrade.id);
		const revealedB: TradeDto = await tradeById(b.context.request, bTrade.id);
		expect(revealedA.status).toBe('revealed');
		expect(revealedB.status).toBe('revealed');
		expect(revealedA.partner).toEqual(
			expect.objectContaining({ revealed: true, nickname: b.nickname, score: 5 })
		);
		expect(revealedB.partner).toEqual(
			expect.objectContaining({ revealed: true, nickname: a.nickname, score: 4 })
		);
	});

	// ---- 9. Reports by 3 accounts hide; the admin restores ------------------------------------------
	await test.step('9. three eligible reports hide the curve; the admin restores it', async () => {
		const reporters: { context: BrowserContext; email: string }[] = [];
		for (let index = 0; index < 3; index += 1) {
			const context = await newContext(browser, 'pt-BR');
			contexts.push(context);
			const email = await createVerifiedAccount(context.request);
			await apiSignIn(context, email);
			reporters.push({ context, email });
		}
		const admin = await newContext(browser, 'pt-BR');
		contexts.push(admin);
		const adminEmail = await createVerifiedAccount(admin.request);
		await apiSignIn(admin, adminEmail);
		// Reporters must be at least 3 days old to count (new accounts never hide anything); the
		// admin needs the role, 2FA and the 2FA marker of its session. Local D1 only.
		d1Local([
			...ageAccountsSql(
				reporters.map(({ email }) => email),
				4
			),
			...adminSql(adminEmail)
		]);

		expect(await publicStatus(browser, lineageId)).toBe(200);
		for (const [index, reporter] of reporters.entries()) {
			const filed = await api(reporter.context.request, 'POST', '/api/v1/reports', {
				targetKind: 'lineage',
				targetId: lineageId,
				reason: 'spam',
				note: `e2e report ${index + 1}`
			});
			expect(filed.status, JSON.stringify(filed.body)).toBe(201);
		}
		await expect.poll(() => publicStatus(browser, lineageId), { timeout: 15_000 }).toBe(404);
		// Hidden: out of the public ranking too.
		expect(await rankingEntry(a.context.request, 'favorites', 'all', lineageId)).toBeNull();

		const page = await admin.newPage();
		const response = await page.goto('/admin/moderacao');
		expect(response?.status(), 'admin area for the promoted account').toBe(200);
		const item = page.locator('li.item').filter({ hasText: lineageId });
		// The queue is shared by every run of the local database: follow the pages if needed.
		for (let pageIndex = 0; pageIndex < 10 && (await item.count()) === 0; pageIndex += 1) {
			const next = page.getByRole('link', { name: text(copy, 'admin_mod_next'), exact: true });
			if ((await next.count()) === 0) break;
			const before = page.url();
			await next.click();
			await page.waitForURL((url) => url.href !== before);
		}
		await expect(item).toHaveCount(1);
		await expect(item).toContainText(curveName);
		await item.locator('textarea[name="reason"]').fill('e2e: restored after review');
		await item
			.getByRole('button', { name: text(copy, 'admin_mod_action_restore'), exact: true })
			.click();
		await expect.poll(() => publicStatus(browser, lineageId), { timeout: 15_000 }).toBe(200);
		// The owner still owns it and the audience endpoint still answers.
		expect((await audienceOf(a.context.request, lineageId)).favorited.total).toBe(1);
	});

	await closeAll(contexts);
});
