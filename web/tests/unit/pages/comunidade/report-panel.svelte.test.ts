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

for (const kind of ['lineage', 'pack', 'user'] as const) {
	test(`reports a ${kind} using its API target, not its display name`, async () => {
		const { props, fetch } = setup();
		const target = { kind, id: kind === 'user' ? 'ana.public' : 'opaque-id' };
		await render(ReportPanel, { ...props, subject: target, targetName: 'Display name' });
		await send().click();
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
			targetKind: kind,
			targetId: target.id
		});
	});
}

test('different target kinds sharing an id are not treated as an already sent report', async () => {
	const { props } = setup();
	const screen = await render(ReportPanel, { ...props, subject: { kind: 'lineage', id: 'same' } });
	await send().click();
	await expect.element(send()).toHaveAccessibleDescription(m.comunidade_v2_reason_report_sent());
	await screen.rerender({ subject: { kind: 'pack', id: 'same' }, token: 'fresh' });
	await expect.element(send()).not.toHaveAttribute('aria-disabled');
});
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
			subject: { kind: 'lineage' as const, id: channel.lineageId },
			targetName: channel.name,
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
	await expect.element(page.getByText(m.comunidade_verify_prompt(), { exact: true }).first()).toBeVisible();
	expect(page.getByRole('link', { name: m.shared_curve_login() }).elements()).toHaveLength(0);
	(send().element() as HTMLElement).click();
	expect(page.getByRole('textbox').elements()).toHaveLength(0);
	await screen.rerender({ session: VERIFIED, online: false });
	await expect.element(send()).toHaveAccessibleDescription(m.comunidade_offline());
	(send().element() as HTMLElement).click();
	expect(fetch).not.toHaveBeenCalled();
});

test('failed report sends reset the live widget and accept a fresh check without closing the panel', async () => {
	const { props, fetch } = setup();
	fetch.mockResolvedValueOnce(apiError('TURNSTILE_FAILED', 403));
	let options: TurnstileRenderOptions | undefined;
	let widgetNumber = 0;
	const renderWidget = vi.fn((_container: HTMLElement, next: TurnstileRenderOptions) => {
		options = next;
		return `widget-${++widgetNumber}`;
	});
	const remove = vi.fn();
	Reflect.set(window, 'turnstile', { render: renderWidget, remove, reset: vi.fn() });
	await render(ReportPanel, { ...props, siteKey: 'site-key', token: '' });
	await expect.poll(() => renderWidget.mock.calls.length).toBe(1);
	options?.callback?.('first-check');
	await send().click();
	await expect.poll(() => renderWidget.mock.calls.length).toBe(2);
	expect(remove).toHaveBeenCalledWith('widget-1');
	await expect.element(send()).toHaveAccessibleDescription(m.comunidade_report_needs_check());
	options?.callback?.('fresh-check');
	await send().click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.comunidade_report_sent());
	expect(headerOf(fetch.mock.calls[1]?.[1], 'x-turnstile-token')).toBe('fresh-check');
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
	await screen.rerender({ subject: { kind: 'lineage', id: 'lin-second' }, token: 'fresh' });
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
	await screen.rerender({
		subject: { kind: 'lineage', id: 'lin-second' },
		targetName: 'Outra curva'
	});
	resolve({ reported: true });
	await expect.element(send()).not.toHaveAttribute('aria-busy');
	await expect.element(page.getByRole('status')).toHaveTextContent('');
	expect(props.api.report).toHaveBeenCalledWith(
		expect.objectContaining({ targetId: channel.lineageId }),
		'token'
	);
	// The channel now on screen was not reported: a fresh check makes it sendable.
	await expect.element(send()).toHaveAccessibleDescription(m.comunidade_report_needs_check());
	await screen.rerender({ token: 'fresh' });
	await expect.element(send()).not.toHaveAttribute('aria-disabled');
	// The submitted channel is the one marked as reported.
	await screen.rerender({ subject: { kind: 'lineage', id: channel.lineageId } });
	await expect.element(send()).toHaveAccessibleDescription(m.comunidade_v2_reason_report_sent());
});

test('a report completing for the previous channel preserves the new note without showing success', async () => {
	const { props } = setup();
	let resolve: (value: { reported: true }) => void = () => undefined;
	vi.spyOn(props.api, 'report').mockReturnValueOnce(
		new Promise((done) => {
			resolve = done;
		})
	);
	const screen = await render(ReportPanel, props);
	const note = page.getByRole('textbox', { name: m.comunidade_report_note() });
	await note.fill('Evidence for the original channel');
	await send().click();
	await expect.element(send()).toHaveAttribute('aria-busy', 'true');
	await screen.rerender({
		subject: { kind: 'lineage', id: 'lin-second' },
		targetName: 'Outra curva'
	});
	await note.fill('Evidence for the new channel');
	resolve({ reported: true });
	await expect.element(send()).not.toHaveAttribute('aria-busy');
	await expect.element(note).toHaveValue('Evidence for the new channel');
	await expect.element(page.getByRole('status')).toHaveTextContent('');
	expect(props.api.report).toHaveBeenCalledWith(
		expect.objectContaining({
			targetId: channel.lineageId,
			note: 'Evidence for the original channel'
		}),
		'token'
	);
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
