import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import ReportPanel from '#lib/components/pages/comunidade/ReportPanel.svelte';
import { channelOf, type FeedItem } from '#lib/components/pages/comunidade/model.ts';
import type { TurnstileRenderOptions } from '#lib/components/security/Turnstile.svelte';
import { m } from '#lib/paraglide/messages.js';
import { VERIFIED, apiError, apiWith, fakeFetch, feedItem, headerOf, json } from './fixtures.ts';

const channel = channelOf(feedItem() as unknown as FeedItem);
const send = () => page.getByRole('button', { name: m.comunidade_report_send() });
afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	Reflect.deleteProperty(window, 'turnstile');
});
function setup() {
	const fetch = fakeFetch(() => json({ reported: true }));
	return {
		fetch,
		props: {
			api: apiWith(fetch),
			session: VERIFIED,
			channel,
			siteKey: '',
			online: true,
			token: 'token'
		}
	};
}

test('unverified and offline users cannot send even with a token', async () => {
	const { props, fetch } = setup();
	const screen = await render(ReportPanel, { ...props, session: { ...VERIFIED, verified: false } });
	await expect.element(send()).toHaveAttribute('aria-disabled', 'true');
	await expect.element(send()).toHaveAccessibleDescription(m.comunidade_verify_prompt());
	(send().element() as HTMLElement).click();
	expect(page.getByRole('textbox').elements()).toHaveLength(0);
	await screen.rerender({ session: VERIFIED, online: false });
	await expect.element(send()).toHaveAccessibleDescription(m.comunidade_offline());
	(send().element() as HTMLElement).click();
	expect(fetch).not.toHaveBeenCalled();
});

test('every reason is available; maximum private note is preserved and success locks only that target', async () => {
	const { props, fetch } = setup();
	const screen = await render(ReportPanel, props);
	const reasons = page.getByRole('combobox', { name: m.comunidade_report_reason() });
	expect([...reasons.element().querySelectorAll('option')].map((option) => option.value)).toEqual([
		'dangerous',
		'spam',
		'offensive',
		'copyright',
		'impersonation',
		'other'
	]);
	await userEvent.selectOptions(reasons, 'other');
	const note = page.getByRole('textbox', { name: m.comunidade_report_note() });
	await expect.element(note).toHaveAttribute('maxlength', '500');
	await note.fill('N'.repeat(500));
	await send().click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.comunidade_report_sent());
	expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
		reason: 'other',
		note: 'N'.repeat(500)
	});
	await expect.element(note).toHaveValue('');
	await expect.element(send()).toHaveAccessibleDescription(m.comunidade_v2_reason_report_sent());
	(send().element() as HTMLElement).click();
	expect(fetch).toHaveBeenCalledOnce();
	await screen.rerender({ channel: { ...channel, lineageId: 'lin-second' }, token: 'fresh' });
	await expect.element(send()).not.toHaveAttribute('aria-disabled');
	await note.fill('   ');
	await send().click();
	await expect.poll(() => fetch.mock.calls.length).toBe(2);
	expect(JSON.parse(String(fetch.mock.calls[1]?.[1].body))).toMatchObject({
		targetId: 'lin-second',
		note: null
	});
});

test('failure consumes the token, preserves the note, and requires a fresh check before retry', async () => {
	const { props, fetch } = setup();
	fetch.mockResolvedValueOnce(apiError('TURNSTILE_FAILED', 403));
	const screen = await render(ReportPanel, props);
	const note = page.getByRole('textbox', { name: m.comunidade_report_note() });
	await note.fill('Private evidence');
	await send().click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.comunidade_error_turnstile());
	await expect.element(send()).toHaveAccessibleDescription(m.comunidade_report_needs_check());
	await expect.element(note).toHaveValue('Private evidence');
	await screen.rerender({ token: 'new-token' });
	await send().click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.comunidade_report_sent());
	expect(headerOf(fetch.mock.calls[1]?.[1], 'x-turnstile-token')).toBe('new-token');
});

test('a pending report blocks duplicate sends and releases the form after failure', async () => {
	const { props, fetch } = setup();
	let reject: (error: Error) => void = () => undefined;
	vi.spyOn(props.api, 'report').mockReturnValueOnce(
		new Promise((_resolve, fail) => {
			reject = fail;
		})
	);
	await render(ReportPanel, props);
	await send().click();
	// In flight the Button is `loading` (ReportPanel.svelte:178): by design that is aria-busy and
	// blocked activation (Button.svelte:11, :70, :94), not aria-disabled, which is kept for an
	// unavailable action with a reason.
	await expect.element(send()).toHaveAttribute('aria-busy', 'true');
	(send().element() as HTMLElement).click();
	expect(props.api.report).toHaveBeenCalledOnce();
	reject(new Error('private error'));
	await expect.element(page.getByRole('status')).toHaveTextContent(m.comunidade_error_generic());
	await expect.element(send()).not.toHaveAttribute('aria-busy');
	// The single-use token was consumed by the failed attempt: a new check is required.
	await expect.element(send()).toHaveAttribute('aria-disabled', 'true');
	await expect.element(send()).toHaveAccessibleDescription(m.comunidade_report_needs_check());
	(send().element() as HTMLElement).click();
	expect(props.api.report).toHaveBeenCalledOnce();
	expect(fetch).not.toHaveBeenCalled();
});

test('a report marks the submitted channel, even when the selection changes in flight', async () => {
	const { props } = setup();
	let resolve: (value: { reported: true }) => void = () => undefined;
	vi.spyOn(props.api, 'report').mockReturnValueOnce(
		new Promise((done) => {
			resolve = done;
		})
	);
	const screen = await render(ReportPanel, props);
	await send().click();
	await expect.element(send()).toHaveAttribute('aria-busy', 'true');
	await screen.rerender({ channel: { ...channel, lineageId: 'lin-second', name: 'Outra curva' } });
	resolve({ reported: true });
	await expect.element(page.getByRole('status')).toHaveTextContent(m.comunidade_report_sent());
	expect(props.api.report).toHaveBeenCalledWith(
		expect.objectContaining({ targetId: channel.lineageId }),
		'token'
	);
	// The channel now on screen was not reported: a fresh check makes it sendable.
	await expect.element(send()).toHaveAccessibleDescription(m.comunidade_report_needs_check());
	await screen.rerender({ token: 'fresh' });
	await expect.element(send()).not.toHaveAttribute('aria-disabled');
	// The submitted channel is the one marked as reported.
	await screen.rerender({ channel });
	await expect.element(send()).toHaveAccessibleDescription(m.comunidade_v2_reason_report_sent());
});

test('lazy widget callback enables sending and expiry disables it again without a network script', async () => {
	const { props } = setup();
	let options: TurnstileRenderOptions | undefined;
	const renderWidget = vi.fn((_container: HTMLElement, next: TurnstileRenderOptions) => {
		options = next;
		return 'report-widget';
	});
	Reflect.set(window, 'turnstile', { render: renderWidget, remove: vi.fn(), reset: vi.fn() });
	await render(ReportPanel, { ...props, siteKey: 'site-key', token: '' });
	await expect.poll(() => renderWidget.mock.calls.length).toBe(1);
	expect(options?.action).toBe('report');
	expect(document.getElementById('cf-turnstile-api')).toBeNull();
	options?.callback?.('solved');
	await expect.element(send()).not.toHaveAttribute('aria-disabled');
	options?.['expired-callback']?.();
	await expect.element(send()).toHaveAccessibleDescription(m.comunidade_report_needs_check());
});
