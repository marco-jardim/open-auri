// Sharing desk (T8, spec §5.3 L6): with no selection it asks for one; with a curve it shows the OG
// image and its download, the printable identity card and, for a verified account online, creates
// a tracked QR link (`POST /shares`) that can be copied. The link belongs to its curve. Unavailable
// actions say why; failures land in the status line and the log holds only the error name.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import SharePanel from '#lib/components/pages/comunidade/SharePanel.svelte';
import {
	channelOf,
	type Channel,
	type FeedItem,
	type SessionView
} from '#lib/components/pages/comunidade/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { qrSvg } from '#lib/qr/index.ts';
import {
	ANONYMOUS,
	VERIFIED,
	apiError,
	apiWith,
	deferred,
	domClick,
	fakeFetch,
	feedItem,
	json,
	reasonOf,
	statusOf
} from './fixtures.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

const UNVERIFIED: SessionView = {
	known: true,
	signedIn: true,
	verified: false,
	nickname: 'geoff'
};
const channel = channelOf(feedItem() as unknown as FeedItem);
const other = channelOf(
	feedItem({
		id: 'lin-bbbbbbbbbbbb',
		name: 'Outra',
		author: null,
		license: 'CC0-1.0'
	}) as unknown as FeedItem
);
const SHARE_PATH = '/s/sh-0001';

/** `POST /api/v1/shares` answers `answer()`; anything else is 404. */
function shareApi(
	answer: () => Response | Promise<Response> = () => json({ shareId: 'sh-0001', url: SHARE_PATH })
) {
	return fakeFetch((url, init) =>
		url.pathname === '/api/v1/shares' && init.method === 'POST' ? answer() : undefined
	);
}

function shareProps(
	fetch: ReturnType<typeof fakeFetch>,
	overrides: { session?: SessionView; channel?: Channel | null; online?: boolean } = {}
) {
	const online = overrides.online ?? true;
	return {
		api: apiWith(fetch, online),
		session: overrides.session ?? VERIFIED,
		channel: overrides.channel === undefined ? channel : overrides.channel,
		online
	};
}

const shareUrl = () => `${location.origin}${SHARE_PATH}`;
const createButton = () =>
	page.getByRole('button', { name: m.comunidade_share_create(), exact: true });
const copyButton = () => page.getByRole('button', { name: m.comunidade_share_copy(), exact: true });
const urlLine = () => document.querySelector('[data-testid="share-url"]');
const qrBox = () => page.getByTestId('share-qr');
const ogImage = (name: string) =>
	page.getByRole('img', { name: m.comunidade_share_og_alt({ name }), exact: true });

test('share: without a selected curve it asks to select one first', async () => {
	const fetch = shareApi();
	await render(SharePanel, shareProps(fetch, { channel: null }));
	await expect
		.element(page.getByTestId('share-panel'))
		.toHaveTextContent(m.comunidade_select_first());
	expect(page.getByRole('button').elements()).toHaveLength(0);
	expect(page.getByRole('img').elements()).toHaveLength(0);
	expect(document.querySelector('[data-testid="share-qr"]')).toBeNull();
	expect(fetch).not.toHaveBeenCalled();
});

test('share: the desk shows the OG image, its download and the printable identity card', async () => {
	const api = apiWith(shareApi());
	await render(SharePanel, { api, session: VERIFIED, channel, online: true });
	const og = `/og/${channel.versionId}.png`;
	expect(api.ogImageUrl(channel.versionId)).toBe(og);
	await expect.element(ogImage(channel.name)).toHaveAttribute('src', og);
	const download = page.getByRole('link', { name: m.comunidade_share_download_png(), exact: true });
	await expect.element(download).toHaveAttribute('href', og);
	await expect.element(download).toHaveAttribute('download');
	const avatar = m.comunidade_avatar_label({ name: channel.name });
	await expect.element(page.getByRole('img', { name: avatar, exact: true })).toBeInTheDocument();
	const panel = page.getByTestId('share-panel');
	await expect.element(panel).toMatchTextContent(channel.name);
	await expect.element(panel).toMatchTextContent('@Geoff');
	await expect.element(panel).toMatchTextContent(channel.s1);
	await expect.element(panel).toMatchTextContent('CC-BY 4.0 · open-auri');
	// No link yet: the QR waits, there is nothing to copy.
	await expect.element(qrBox()).toHaveTextContent(m.comunidade_share_qr_pending());
	expect(urlLine()).toBeNull();
	expect(copyButton().elements()).toHaveLength(0);
	await expect.element(createButton()).not.toHaveAttribute('aria-disabled');
	expect(statusOf('share-panel')).toBe('');

	await cleanup();
	await render(SharePanel, { api, session: VERIFIED, channel: other, online: true });
	const card = page.getByTestId('share-panel');
	await expect.element(card).toMatchTextContent(m.comunidade_author_removed());
	await expect.element(card).toMatchTextContent('CC0 · open-auri');
	await expect.element(card).not.toMatchTextContent('@Geoff');
});

test('share: visitors, unverified accounts and offline accounts are told why no link can be made', async () => {
	const cases: [SessionView, boolean, string][] = [
		[ANONYMOUS, true, m.comunidade_v2_reason_account()],
		[UNVERIFIED, true, m.comunidade_verify_prompt()],
		[VERIFIED, false, m.comunidade_offline()]
	];
	for (const [session, online, reason] of cases) {
		const fetch = shareApi();
		await render(SharePanel, shareProps(fetch, { session, online }));
		await expect.element(createButton()).toHaveAttribute('aria-disabled', 'true');
		expect(reasonOf(createButton().element())).toBe(reason);
		domClick(createButton().element());
		expect(fetch).not.toHaveBeenCalled();
		expect(statusOf('share-panel')).toBe('');
		// The rest of the desk stays available.
		await expect
			.element(page.getByRole('link', { name: m.comunidade_share_download_png(), exact: true }))
			.toHaveAttribute('href', `/og/${channel.versionId}.png`);
		await cleanup();
	}
});

test('share: creating a link posts the curve and shows the tracked URL with its QR', async () => {
	const fetch = shareApi();
	await render(SharePanel, shareProps(fetch));
	await createButton().click();
	await expect.poll(() => urlLine()?.textContent).toBe(shareUrl());
	expect(fetch).toHaveBeenCalledOnce();
	const [url, init] = fetch.mock.calls[0] ?? [];
	expect(url).toBe('/api/v1/shares');
	expect(JSON.parse(String(init?.body))).toEqual({
		lineageId: channel.lineageId,
		versionId: channel.versionId,
		channel: 'qr'
	});
	await expect
		.element(page.getByRole('img', { name: m.comunidade_share_qr_alt(), exact: true }))
		.toHaveAttribute('src', `data:image/svg+xml,${encodeURIComponent(qrSvg(shareUrl()))}`);
	await expect.element(qrBox()).not.toMatchTextContent(m.comunidade_share_qr_pending());
	await expect.element(copyButton()).toBeVisible();
	expect(statusOf('share-panel')).toBe('');
});

test('share: while the link is being created the action is busy and cannot run twice', async () => {
	const gate = deferred<Response>();
	const fetch = shareApi(() => gate.promise);
	await render(SharePanel, shareProps(fetch));
	await createButton().click();
	await expect.element(createButton()).toHaveAttribute('aria-busy', 'true');
	domClick(createButton().element());
	expect(fetch).toHaveBeenCalledOnce();
	gate.resolve(json({ shareId: 'sh-0001', url: SHARE_PATH }));
	await expect.element(createButton()).not.toHaveAttribute('aria-busy');
	await expect.poll(() => urlLine()?.textContent).toBe(shareUrl());
	expect(fetch).toHaveBeenCalledOnce();
});

test('share: a refused link says why and shows no URL or QR', async () => {
	const fetch = shareApi(() => apiError('RATE_LIMITED', 429));
	await render(SharePanel, shareProps(fetch));
	await createButton().click();
	await expect.poll(() => statusOf('share-panel')).toBe(m.comunidade_error_rate());
	expect(urlLine()).toBeNull();
	expect(copyButton().elements()).toHaveLength(0);
	await expect.element(qrBox()).toHaveTextContent(m.comunidade_share_qr_pending());
	await expect.element(createButton()).not.toHaveAttribute('aria-busy');
	await expect.element(createButton()).not.toHaveAttribute('aria-disabled');
});

test('share: copy puts the tracked link on the clipboard and confirms', async () => {
	const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
	await render(SharePanel, shareProps(shareApi()));
	await createButton().click();
	await copyButton().click();
	await expect.poll(() => statusOf('share-panel')).toBe(m.comunidade_share_copied());
	expect(writeText).toHaveBeenCalledExactlyOnceWith(shareUrl());
});

test('share: a refused clipboard says so and logs only the error name', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const writeText = vi
		.spyOn(navigator.clipboard, 'writeText')
		.mockRejectedValueOnce(new Error('denied'))
		.mockRejectedValueOnce('denied');
	await render(SharePanel, shareProps(shareApi()));
	await createButton().click();
	await copyButton().click();
	await expect.poll(() => statusOf('share-panel')).toBe(m.comunidade_share_copy_failed());
	expect(warn).toHaveBeenCalledWith(
		JSON.stringify({ event: 'comunidade.copy_failed', error: 'Error' })
	);
	// A rejection that is not an Error is logged as unknown.
	await copyButton().click();
	await expect
		.poll(() => warn.mock.calls.map(([text]: unknown[]) => text))
		.toContain(JSON.stringify({ event: 'comunidade.copy_failed', error: 'unknown' }));
	expect(writeText).toHaveBeenCalledTimes(2);
	expect(statusOf('share-panel')).toBe(m.comunidade_share_copy_failed());
	expect(JSON.stringify(warn.mock.calls)).not.toContain(SHARE_PATH);
});

test('share: a link belongs to its curve, so another selection hides it and coming back shows it', async () => {
	const fetch = shareApi();
	const screen = await render(SharePanel, shareProps(fetch));
	await createButton().click();
	await expect.poll(() => urlLine()?.textContent).toBe(shareUrl());

	await screen.rerender({ channel: other });
	await expect.element(ogImage(other.name)).toHaveAttribute('src', `/og/${other.versionId}.png`);
	expect(urlLine()).toBeNull();
	expect(copyButton().elements()).toHaveLength(0);
	await expect.element(qrBox()).toHaveTextContent(m.comunidade_share_qr_pending());

	// Nothing selected: the desk asks for a curve again.
	await screen.rerender({ channel: null });
	await expect
		.element(page.getByTestId('share-panel'))
		.toHaveTextContent(m.comunidade_select_first());
	expect(urlLine()).toBeNull();

	await screen.rerender({ channel });
	await expect.poll(() => urlLine()?.textContent).toBe(shareUrl());
	await expect.element(copyButton()).toBeVisible();
	expect(fetch).toHaveBeenCalledOnce();
});
