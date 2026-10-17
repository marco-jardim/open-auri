// T4.13 + FUX.P4: the anonymous preference needs all three explicit consents and sends exactly the
// previewed JSON, keeping the receipt locally; the Turnstile check is imported and mounted only
// after the consent (L6, T10). Reports need a Turnstile token and an account; their check mounts only
// when the form is shown. Unavailable actions say why (aria-disabled + reason).
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
	Reflect.deleteProperty(window, 'turnstile');
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

/** The text of everything an element's aria-describedby points to (the Button's reason). */
function reasonOf(element: Element): string {
	const ids = element.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
	return ids
		.map((value) => document.getElementById(value)?.textContent?.trim() ?? '')
		.join(' ')
		.trim();
}

/** Visible notes with exactly this text (the reason tooltip may hold the same words). */
function notesWith(text: string): Element[] {
	return Array.from(document.querySelectorAll('p.note')).filter(
		(node) => node.textContent?.trim() === text
	);
}

/**
 * A stand-in for Cloudflare's `window.turnstile`: the widget module finds it and never injects the
 * third-party script, so the test makes no network request.
 */
function stubTurnstile() {
	const renderWidget = vi.fn<(container: HTMLElement, options: { action: string }) => string>(
		() => 'widget-1'
	);
	Reflect.set(window, 'turnstile', { render: renderWidget, reset: vi.fn(), remove: vi.fn() });
	return renderWidget;
}

const PAIRS = [{ a: 'aaaaaaaaaaaa', b: 'bbbbbbbbbbbb', choice: 'a' as const, levelMatched: true }];

function s6Props(
	fetch: ReturnType<typeof fakeFetch>,
	storage: ReceiptStorage,
	overrides: { siteKey?: string; token?: string } = {}
) {
	return {
		api: apiWith(fetch),
		channels: [],
		listener: createListener({ engine: () => null }),
		canListen: false,
		siteKey: overrides.siteKey ?? '',
		online: true,
		storage,
		pairs: PAIRS,
		token: overrides.token ?? 'turnstile-token',
		onnotice: vi.fn()
	};
}

test('S6: nothing can be sent before the three explicit consents', async () => {
	const fetch = fakeFetch(() => json({ ok: true }));
	await render(S6Panel, s6Props(fetch, memoryStorage()));
	const send = page.getByRole('button', { name: m.comunidade_s6_send({ count: '1' }) });
	await expect.element(send).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(send.element())).toBe(m.comunidade_s6_consent_required());
	expect(notesWith(m.comunidade_s6_consent_required())).toHaveLength(1);
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_pairs() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_anonymous() }).click();
	await expect.element(send).toHaveAttribute('aria-disabled', 'true');
	const button = send.element();
	if (button instanceof HTMLElement) button.click();
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
	const send = page.getByRole('button', { name: m.comunidade_s6_send({ count: '1' }) });
	await expect.element(send).not.toHaveAttribute('aria-disabled');
	await send.click();
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

test('S6: the Turnstile check is mounted only after the three consents, with no error before', async () => {
	const renderWidget = stubTurnstile();
	const fetch = fakeFetch(() => undefined);
	await render(S6Panel, s6Props(fetch, memoryStorage(), { siteKey: 'site-key', token: '' }));
	const check = page.getByTestId('s6-check');
	await expect.element(check).toHaveTextContent(m.comunidade_v2_turnstile_after_consent());
	expect(document.querySelector('input[name="cf-turnstile-response"]')).toBeNull();
	expect(document.querySelector('[role="alert"]')).toBeNull();
	expect(renderWidget).not.toHaveBeenCalled();

	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_pairs() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_anonymous() }).click();
	expect(renderWidget).not.toHaveBeenCalled();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_research() }).click();

	await expect.poll(() => renderWidget.mock.calls.length).toBe(1);
	expect(renderWidget.mock.calls[0]?.[1]).toMatchObject({ action: 's6-submit' });
	expect(document.querySelector('input[name="cf-turnstile-response"]')).not.toBeNull();
	// The third-party script itself was never injected (the stub answered).
	expect(document.getElementById('cf-turnstile-api')).toBeNull();
	// Without a token the send action says what is missing.
	const send = page.getByRole('button', { name: m.comunidade_s6_send({ count: '1' }) });
	expect(reasonOf(send.element())).toBe(m.comunidade_report_needs_check());
});

test('S6: without a site key the check says it is unavailable, only after the consent', async () => {
	const fetch = fakeFetch(() => undefined);
	await render(S6Panel, s6Props(fetch, memoryStorage(), { token: '' }));
	expect(notesWith(m.comunidade_turnstile_unavailable())).toHaveLength(0);
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_pairs() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_anonymous() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_research() }).click();
	await expect.poll(() => notesWith(m.comunidade_turnstile_unavailable()).length).toBe(1);
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
	const send = page.getByRole('button', { name: m.comunidade_report_send() });
	await expect.element(send).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(send.element())).toBe(m.comunidade_report_needs_check());
	expect(notesWith(m.comunidade_report_needs_check())).toHaveLength(1);
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
	// Sent once for this curve: the action now says so.
	const send = page.getByRole('button', { name: m.comunidade_report_send() });
	await expect.poll(() => reasonOf(send.element())).toBe(m.comunidade_v2_reason_report_sent());
});

test('report: the Turnstile check mounts with the form, never before', async () => {
	const renderWidget = stubTurnstile();
	const fetch = fakeFetch(() => undefined);
	await render(ReportPanel, {
		api: apiWith(fetch),
		session: VERIFIED,
		channel: null,
		siteKey: 'site-key',
		online: true
	});
	await expect.element(page.getByText(m.comunidade_select_first())).toBeVisible();
	expect(renderWidget).not.toHaveBeenCalled();
	cleanup();
	await render(ReportPanel, {
		api: apiWith(fetch),
		session: VERIFIED,
		channel,
		siteKey: 'site-key',
		online: true
	});
	await expect.poll(() => renderWidget.mock.calls.length).toBe(1);
	expect(renderWidget.mock.calls[0]?.[1]).toMatchObject({ action: 'report' });
});

test('report: visitors get no form and no check, and the action says why', async () => {
	const renderWidget = stubTurnstile();
	const fetch = fakeFetch(() => undefined);
	await render(ReportPanel, {
		api: apiWith(fetch),
		session: ANONYMOUS,
		channel,
		siteKey: 'site-key',
		online: true
	});
	const send = page.getByRole('button', { name: m.comunidade_report_send() });
	await expect.element(send).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(send.element())).toBe(m.comunidade_v2_reason_account());
	expect(page.getByRole('textbox').elements()).toHaveLength(0);
	expect(document.querySelector('[data-testid="login-prompt"]')).toBeNull();
	expect(renderWidget).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});
