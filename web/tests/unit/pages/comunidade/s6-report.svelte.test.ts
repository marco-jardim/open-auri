// T4.13: S6 needs all three explicit consents and sends exactly the previewed JSON, keeping the
// receipt locally; reports need a Turnstile token (and an account).
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import ReportPanel from '#lib/components/pages/comunidade/ReportPanel.svelte';
import S6Panel from '#lib/components/pages/comunidade/S6Panel.svelte';
import { createListener } from '#lib/components/pages/comunidade/listener.svelte.ts';
import {
	S6_RECEIPTS_KEY,
	channelOf,
	readReceipts,
	type FeedItem,
	type ReceiptStorage
} from '#lib/components/pages/comunidade/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { ANONYMOUS, VERIFIED, apiWith, fakeFetch, feedItem, headerOf, json } from './fixtures.ts';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function memoryStorage(): ReceiptStorage & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => {
			data.set(key, value);
		}
	};
}

const PAIRS = [{ a: 'aaaaaaaaaaaa', b: 'bbbbbbbbbbbb', choice: 'a' as const, levelMatched: true }];

function s6Props(fetch: ReturnType<typeof fakeFetch>, storage: ReceiptStorage) {
	return {
		api: apiWith(fetch),
		channels: [],
		listener: createListener({ engine: () => null }),
		canListen: false,
		siteKey: '',
		online: true,
		storage,
		pairs: PAIRS,
		token: 'turnstile-token',
		onnotice: vi.fn()
	};
}

test('S6: nothing can be sent before the three explicit consents', async () => {
	const fetch = fakeFetch(() => json({ ok: true }));
	await render(S6Panel, s6Props(fetch, memoryStorage()));
	const send = page.getByRole('button', { name: m.comunidade_s6_send({ count: '1' }) });
	await expect.element(send).toBeDisabled();
	await expect.element(page.getByText(m.comunidade_s6_consent_required())).toBeVisible();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_pairs() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_anonymous() }).click();
	await expect.element(send).toBeDisabled();
	expect(fetch).not.toHaveBeenCalled();
});

test('S6: with consent it sends exactly the previewed payload and keeps the receipt', async () => {
	const fetch = fakeFetch((url, init) =>
		url.pathname === '/api/v1/s6/batches' && init.method === 'POST' ? json({ ok: true }) : undefined
	);
	const storage = memoryStorage();
	await render(S6Panel, s6Props(fetch, storage));
	// Wait for the browser-only receipt: the preview is then the final body.
	await expect.element(page.getByTestId('s6-payload')).toMatchTextContent('s6-consent-v1');
	await expect
		.poll(() => document.querySelector('[data-testid="s6-payload"]')?.textContent ?? '')
		.toMatch(/"receipt": "[A-Za-z0-9_-]{43}"/);
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_pairs() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_anonymous() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_research() }).click();
	const preview: unknown = JSON.parse(
		document.querySelector('[data-testid="s6-payload"]')?.textContent ?? ''
	);
	await page.getByRole('button', { name: m.comunidade_s6_send({ count: '1' }) }).click();
	await expect.element(page.getByText(m.comunidade_s6_sent())).toBeVisible();
	const [url, init] = fetch.mock.calls[0] ?? [];
	expect(url).toBe('/api/v1/s6/batches');
	expect(headerOf(init, 'x-turnstile-token')).toBe('turnstile-token');
	expect(JSON.parse(String(init?.body))).toEqual(preview);
	expect(preview).toMatchObject({ consentVersion: 's6-consent-v1', pairs: PAIRS });
	const receipts = readReceipts(storage);
	expect(receipts).toHaveLength(1);
	expect(storage.data.has(S6_RECEIPTS_KEY)).toBe(true);
	expect(receipts[0]?.receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(receipts[0]?.receipt).toBe(Reflect.get(Object(preview), 'receipt'));
});

const channel = channelOf(feedItem() as unknown as FeedItem);

test('report: without a Turnstile token the report cannot be sent', async () => {
	const fetch = fakeFetch(() => json({ reported: true }));
	await render(ReportPanel, {
		api: apiWith(fetch),
		session: VERIFIED,
		channel,
		siteKey: '',
		online: true
	});
	await expect
		.element(page.getByRole('button', { name: m.comunidade_report_send() }))
		.toBeDisabled();
	await expect.element(page.getByText(m.comunidade_report_needs_check())).toBeVisible();
	expect(fetch).not.toHaveBeenCalled();
});

test('report: with a token it posts the reason and sends the token header', async () => {
	const fetch = fakeFetch((url) =>
		url.pathname === '/api/v1/reports' ? json({ reported: true }) : undefined
	);
	await render(ReportPanel, {
		api: apiWith(fetch),
		session: VERIFIED,
		channel,
		siteKey: '',
		online: true,
		token: 'tok-123'
	});
	await page.getByRole('button', { name: m.comunidade_report_send() }).click();
	await expect.element(page.getByText(m.comunidade_report_sent())).toBeVisible();
	const [, init] = fetch.mock.calls[0] ?? [];
	expect(headerOf(init, 'x-turnstile-token')).toBe('tok-123');
	expect(JSON.parse(String(init?.body))).toEqual({
		targetKind: 'lineage',
		targetId: channel.lineageId,
		reason: 'dangerous',
		note: null
	});
});

test('report: anonymous visitors get the sign-in prompt instead of the form', async () => {
	const fetch = fakeFetch(() => undefined);
	await render(ReportPanel, {
		api: apiWith(fetch),
		session: ANONYMOUS,
		channel,
		siteKey: '',
		online: true
	});
	await expect.element(page.getByTestId('login-prompt')).toBeVisible();
	expect(page.getByRole('button', { name: m.comunidade_report_send() }).elements()).toHaveLength(0);
});
