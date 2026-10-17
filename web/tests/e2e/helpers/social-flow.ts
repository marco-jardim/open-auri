// Helpers of the social e2e specs (social.spec.ts, community.spec.ts). Everything runs against the
// auth-flow server on :4174 (sign-up open, captured e-mail, Turnstile stub; see auth-flow.ts and
// playwright.config.ts): accounts come from `createVerifiedAccount`, contexts from `newContext`
// (random CF-Connecting-IP each, so rate limits never collide).
//
// - Jobs: the web Worker has no cron; `runJob` asks the dev-only POST /api/dev/jobs/[name] (same
//   guard as the dev mailbox: capture transport + loopback origin, 404 anywhere else).
// - D1: `d1Local` runs SQL on the auth-flow server's local database through
//   `wrangler d1 execute --local --persist-to <AUTH_FLOW_PERSIST>` (never a remote database). Used
//   only for what no API can do by design: making an account an admin with the 2FA marker of its
//   session, and ageing accounts past the reporter age threshold of the moderation.
// - The local D1 persists between runs: ids, nicknames and e-mails are unique per run, and no
//   assertion depends on global counts.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	expect,
	type APIRequestContext,
	type BrowserContext,
	type Locator,
	type Page
} from '@playwright/test';
import { AUTH_FLOW_PERSIST } from '../global-setup';
import { AUTH_FLOW_ORIGIN, DUMMY_TURNSTILE_TOKEN, open, type Locale } from './auth-flow';

// ---- Copy ------------------------------------------------------------------------------------

export type Copy = Record<string, string>;

/** The UI copy of one locale, straight from the message catalog the build uses. */
export function catalog(locale: Locale): Copy {
	const file = fileURLToPath(new URL(`../../../messages/${locale}.json`, import.meta.url));
	return JSON.parse(readFileSync(file, 'utf8')) as Copy;
}

/** Catalog text, failing loudly when the key is missing. */
export function text(copy: Copy, key: string): string {
	const value = copy[key];
	if (value === undefined) throw new Error(`message ${key} missing from the catalog`);
	return value;
}

/** Catalog text up to its first `{placeholder}` (for messages with parameters). */
export function lead(copy: Copy, key: string): string {
	return text(copy, key).split('{')[0]?.trim() ?? '';
}

/** Catalog text with its `{placeholders}` filled. */
export function fill(copy: Copy, key: string, values: Record<string, string | number>): string {
	return text(copy, key).replace(/\{(\w+)\}/g, (match, name: string) =>
		name in values ? String(values[name]) : match
	);
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Unique data -----------------------------------------------------------------------------

function hex(length: number): string {
	return crypto.randomUUID().replaceAll('-', '').slice(0, length);
}

/** Lowercase letters and digits only: valid for the nickname rules and unique per run. */
export function uniqueNickname(prefix = 'e2e'): string {
	return `${prefix}${hex(10)}`;
}

export function uniqueCurveName(prefix: string): string {
	return `${prefix} ${hex(8)}`;
}

/** A small APO text curve (peaking bands only, negative preamp: approved by the gate). */
export function apoCurve(preampDb: number, ...peaks: { hz: number; db: number; q: number }[]) {
	return [
		`Preamp: ${preampDb} dB`,
		...peaks.map(
			(peak, index) => `Filter ${index + 1}: ON PK Fc ${peak.hz} Hz Gain ${peak.db} dB Q ${peak.q}`
		),
		''
	].join('\n');
}

// ---- API -------------------------------------------------------------------------------------

export interface ApiAnswer<T> {
	status: number;
	body: T;
}

/**
 * One JSON call to the auth-flow server with the context's cookies. Writes carry the Origin header
 * (the API kit checks it) and the dummy Turnstile token (accepted by the local stub only).
 */
export async function api<T = unknown>(
	request: APIRequestContext,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	path: string,
	data?: unknown
): Promise<ApiAnswer<T>> {
	const headers: Record<string, string> = { origin: AUTH_FLOW_ORIGIN };
	if (method !== 'GET') headers['x-turnstile-token'] = DUMMY_TURNSTILE_TOKEN;
	if (data !== undefined) headers['content-type'] = 'application/json';
	const response = await request.fetch(`${AUTH_FLOW_ORIGIN}${path}`, {
		method,
		headers,
		...(data === undefined ? {} : { data })
	});
	const raw = await response.text();
	let body: unknown = null;
	if (raw) {
		try {
			body = JSON.parse(raw);
		} catch {
			body = raw;
		}
	}
	return { status: response.status(), body: body as T };
}

/** Runs one scheduled job of the jobs Worker on the auth-flow server (dev-only route). */
export async function runJob(
	request: APIRequestContext,
	name: 'rankings' | 's6-aggregate' | 'trades-expire' | 'regate'
): Promise<unknown> {
	const answer = await api<{ job: string; result: unknown }>(
		request,
		'POST',
		`/api/dev/jobs/${name}`
	);
	expect(answer.status, `dev job ${name} (EMAIL_TRANSPORT=capture on localhost)`).toBe(200);
	expect(answer.body.job).toBe(name);
	return answer.body.result;
}

export interface CurveInfo {
	lineageId: string;
	versionId: string;
	s1: string;
	visibility: string;
}

export async function curveInfo(request: APIRequestContext, lineageId: string): Promise<CurveInfo> {
	const answer = await api<{
		lineage: { id: string; visibility: string };
		version: { id: string };
		curve: { s1: string };
	}>(request, 'GET', `/api/v1/curves/${encodeURIComponent(lineageId)}`);
	expect(answer.status, `GET /api/v1/curves/${lineageId}`).toBe(200);
	return {
		lineageId: answer.body.lineage.id,
		versionId: answer.body.version.id,
		s1: answer.body.curve.s1,
		visibility: answer.body.lineage.visibility
	};
}

export interface ActivityRecord {
	lineageId: string;
	kind: 'previewed' | 'installed';
	count: number;
}

export async function myActivity(request: APIRequestContext): Promise<ActivityRecord[]> {
	const answer = await api<{ items: ActivityRecord[] }>(
		request,
		'GET',
		'/api/v1/me/activity?limit=100'
	);
	expect(answer.status).toBe(200);
	return answer.body.items;
}

/** Waits until the signed-in user's own history has `kind` for `lineageId` (outbox flushed). */
export async function waitForActivity(
	request: APIRequestContext,
	lineageId: string,
	kind: ActivityRecord['kind'],
	timeout = 30_000
): Promise<void> {
	await expect
		.poll(
			async () =>
				(await myActivity(request)).some(
					(item) => item.lineageId === lineageId && item.kind === kind
				),
			{ timeout, message: `${kind} recorded for the lineage` }
		)
		.toBe(true);
}

export interface AudienceGroup {
	total: number;
	named: { username: string; displayUsername: string; at: number }[];
	privateCount: number;
}

export interface Audience {
	previewed: AudienceGroup;
	installed: AudienceGroup;
	favorited: AudienceGroup;
}

export async function audienceOf(request: APIRequestContext, lineageId: string): Promise<Audience> {
	const answer = await api<{ audience: Audience }>(
		request,
		'GET',
		`/api/v1/curves/${encodeURIComponent(lineageId)}/audience`
	);
	expect(answer.status, 'audience of an own lineage').toBe(200);
	return answer.body.audience;
}

export interface RankingEntry {
	rank: number;
	score: number;
	lineage: { id: string };
}

/** The entry of `lineageId` in a materialized ranking (follows the cursor), or null. */
export async function rankingEntry(
	request: APIRequestContext,
	metric: 'favorites' | 'installs',
	window: '7d' | '30d' | 'all',
	lineageId: string
): Promise<RankingEntry | null> {
	let cursor: string | null = null;
	for (let page = 0; page < 50; page += 1) {
		const query = new URLSearchParams({ metric, window, limit: '100' });
		if (cursor) query.set('cursor', cursor);
		const answer: ApiAnswer<{ items: RankingEntry[]; nextCursor: string | null }> = await api(
			request,
			'GET',
			`/api/v1/rankings?${query.toString()}`
		);
		expect(answer.status).toBe(200);
		const found = answer.body.items.find((entry) => entry.lineage.id === lineageId);
		if (found) return found;
		cursor = answer.body.nextCursor;
		if (!cursor) return null;
	}
	return null;
}

export interface TradeDto {
	id: string;
	status: 'waiting' | 'matched' | 'revealed' | 'expired' | 'cancelled';
	lineageId: string;
	versionId: string;
	score: number | null;
	partner:
		| { revealed: false; curveId: string; s1: string }
		| {
				revealed: true;
				curveId: string;
				s1: string;
				score: number | null;
				nickname: string | null;
				lineage: { id: string; versionId: string; name: string | null } | null;
		  }
		| null;
}

function tradeOf(body: unknown): TradeDto {
	const value =
		typeof body === 'object' && body !== null && 'trade' in body
			? (body as { trade: unknown }).trade
			: body;
	return value as TradeDto;
}

export async function joinTrade(
	request: APIRequestContext,
	lineageId: string,
	versionId?: string
): Promise<TradeDto> {
	const answer = await api(request, 'POST', '/api/v1/trades', {
		lineageId,
		...(versionId ? { versionId } : {})
	});
	expect(answer.status, `join S7: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
	return tradeOf(answer.body);
}

export async function myTrades(request: APIRequestContext): Promise<TradeDto[]> {
	const answer = await api<{ items: unknown[] }>(request, 'GET', '/api/v1/trades/me?limit=50');
	expect(answer.status).toBe(200);
	return answer.body.items.map(tradeOf);
}

export async function tradeById(request: APIRequestContext, id: string): Promise<TradeDto> {
	const found = (await myTrades(request)).find((trade) => trade.id === id);
	if (!found) throw new Error('trade missing from the owner list');
	return found;
}

// ---- UI --------------------------------------------------------------------------------------

/** Opens the Curva page on the "ajustar" layer, hydrated, with the import control ready. */
export async function openCurvaPage(page: Page, copy: Copy, path = '/?camada=ajustar') {
	await open(page, path);
	await expect(page.getByLabel(text(copy, 'curva_import'), { exact: true })).toBeEnabled();
}

/** Loads an APO text curve into the editor through the same file picker a user operates. */
export async function importCurve(page: Page, copy: Copy, apo: string, fileName = 'e2e.txt') {
	await expect(page.getByLabel(text(copy, 'curva_import'), { exact: true })).toBeEnabled();
	await page.setInputFiles('input[accept=".txt,.json,text/plain,application/json"]', {
		name: fileName,
		mimeType: 'text/plain',
		buffer: Buffer.from(apo, 'utf8')
	});
	await expect(
		page
			.getByRole('main')
			.getByRole('status')
			.filter({ hasText: new RegExp(`^${escapeRegExp(lead(copy, 'curva_import_ok'))}`) })
	).toBeVisible();
}

/**
 * Client-side navigation through a visible link of the page chrome (keeps the running app and its
 * in-memory editor, like a user clicking the menu); a plain load when no such link is visible.
 */
export async function navigate(page: Page, path: string): Promise<void> {
	const link = page.locator(`a[href="${path}"]:visible`).first();
	if ((await link.count()) > 0) {
		await link.click();
		await expect(page).toHaveURL(new RegExp(`${escapeRegExp(path)}(?:[?#]|$)`));
		await expect(page.locator('#main-content')).toBeVisible();
	} else {
		await open(page, path);
	}
}

export function curvaSocial(page: Page, copy: Copy): Locator {
	return page.getByRole('region', { name: text(copy, 'curva_social_heading'), exact: true });
}

/** Sets the nickname on /conta (a verified account) and waits until the session carries it. */
export async function setNickname(page: Page, nickname: string): Promise<void> {
	await open(page, '/conta');
	const form = page.locator('form[action="?/nickname"]');
	await form.locator('input[name="nickname"]').fill(nickname);
	await Promise.all([
		page.waitForResponse(
			(response) => response.url().includes('?/nickname') && response.request().method() === 'POST'
		),
		form.locator('button[type="submit"]').click()
	]);
	await expect
		.poll(async () => {
			const answer = await api<{ user?: { username?: string | null } } | null>(
				page.context().request,
				'GET',
				'/api/auth/get-session'
			);
			return answer.body?.user?.username ?? null;
		})
		.toBe(nickname);
}

/** Sets the activity visibility on /conta (checkbox present = public). */
export async function setActivityVisibility(
	page: Page,
	visibility: 'public' | 'private'
): Promise<void> {
	await open(page, '/conta');
	const form = page.locator('form[action="?/visibility"]');
	await form.locator('input[name="activity_visibility"]').setChecked(visibility === 'public');
	const [response] = await Promise.all([
		page.waitForResponse(
			(answer) => answer.url().includes('?/visibility') && answer.request().method() === 'POST'
		),
		form.locator('button[type="submit"]').click()
	]);
	expect(response.status()).toBeLessThan(400);
}

export interface Published {
	lineageId: string;
	shareUrl: string;
}

/**
 * Publishes the given curve from the Curva page ("Publicar curva" dialog: name, public), waits for
 * the server's approval and creates the short share link. Returns the lineage and the link.
 */
export async function publishOnCurva(
	page: Page,
	copy: Copy,
	apo: string,
	name: string
): Promise<Published> {
	await openCurvaPage(page, copy);
	await importCurve(page, copy, apo);
	const social = curvaSocial(page, copy);
	const publish = social.getByRole('button', {
		name: text(copy, 'curva_social_publish'),
		exact: true
	});
	// Enabled once the browser knows the session is verified.
	await expect(publish).toBeEnabled({ timeout: 15_000 });
	await publish.click();
	const dialog = page.getByRole('dialog', {
		name: text(copy, 'curva_social_publish'),
		exact: true
	});
	await expect(dialog).toBeVisible();
	await dialog.getByRole('textbox', { name: text(copy, 'curva_social_name') }).fill(name);
	await dialog
		.getByRole('button', { name: text(copy, 'curva_social_publish'), exact: true })
		.click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });
	await expect(
		social.getByText(text(copy, 'curva_social_published'), { exact: true })
	).toBeVisible();
	// The published origin is remembered: the page link and the share button appear.
	const pageLink = social.getByRole('link', { name: text(copy, 'curva_social_open'), exact: true });
	await expect(pageLink).toHaveAttribute('href', /^\/c\/[^/?#]+$/);
	const href = (await pageLink.getAttribute('href')) ?? '';
	const lineageId = decodeURIComponent(href.slice('/c/'.length));
	await social.getByRole('button', { name: text(copy, 'curva_social_share'), exact: true }).click();
	const link = social.getByRole('textbox', { name: text(copy, 'curva_social_link'), exact: true });
	await expect(link).toHaveValue(
		new RegExp(`^${escapeRegExp(AUTH_FLOW_ORIGIN)}/c/${escapeRegExp(lineageId)}\\?s=[\\w-]+$`)
	);
	return { lineageId, shareUrl: await link.inputValue() };
}

// ---- Local D1 (auth-flow server) ------------------------------------------------------------

const WEB_DIR = fileURLToPath(new URL('../../../', import.meta.url));

/** SQL string literal (values here are generated by the tests, quoted anyway). */
export function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Runs SQL statements on the auth-flow server's LOCAL D1 (`--local --persist-to`), through a
 * temporary file (no shell quoting of SQL). Throws with wrangler's exit code on failure.
 */
export function d1Local(statements: readonly string[]): void {
	const dir = mkdtempSync(join(tmpdir(), 'oa-e2e-sql-'));
	const file = join(dir, 'statements.sql');
	writeFileSync(file, `${statements.map((sql) => sql.trim().replace(/;$/, '')).join(';\n')};\n`);
	try {
		const win = process.platform === 'win32';
		const result = spawnSync(
			'npx',
			[
				'wrangler',
				'd1',
				'execute',
				'DB',
				'--local',
				'--persist-to',
				AUTH_FLOW_PERSIST,
				'--file',
				win ? `"${file}"` : file
			],
			{
				cwd: WEB_DIR,
				encoding: 'utf8',
				shell: win,
				env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
				timeout: 120_000
			}
		);
		if (result.status !== 0) {
			throw new Error(`wrangler d1 execute --local failed (exit ${String(result.status)})`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Statements that make accounts older than `days` (moderation counts reporters ≥ 3 days old). */
export function ageAccountsSql(emails: readonly string[], days: number): string[] {
	const createdAt = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
	return emails.map(
		(email) =>
			`UPDATE "user" SET "createdAt" = ${sqlString(createdAt)} WHERE email = ${sqlString(email)}`
	);
}

/**
 * Statements that make a SIGNED-IN account an effective admin: role `admin`, 2FA enabled and the
 * 2FA marker on its current sessions (what a TOTP verification records). Sign in first: with 2FA
 * enabled a new password sign-in would ask for the second factor.
 */
export function adminSql(email: string): string[] {
	const now = new Date().toISOString();
	return [
		`UPDATE "user" SET role = 'admin', "twoFactorEnabled" = 1 WHERE email = ${sqlString(email)}`,
		`UPDATE "session" SET "twoFactorVerifiedAt" = ${sqlString(now)} WHERE "userId" = ` +
			`(SELECT id FROM "user" WHERE email = ${sqlString(email)})`
	];
}

/** The `cf-connecting-ip`-isolated contexts of a test, closed together. */
export async function closeAll(contexts: readonly BrowserContext[]): Promise<void> {
	await Promise.all(contexts.map((context) => context.close()));
}
