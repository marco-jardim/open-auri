// T4.13: the Comunidade page (Chromium). Feed rendering by channel, empty and offline states,
// anonymous browsing with login prompts, no LEDs while nothing plays, user text only as text.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import Comunidade from '#lib/components/pages/comunidade/Comunidade.svelte';
import { m } from '#lib/paraglide/messages.js';
import { requireLoginHref } from '#lib/social/index.ts';
import { ANONYMOUS, apiWith, fakeFetch, feedItem, feedPage, json, S1_BOOST } from './fixtures.ts';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function setup(items: unknown[], options: { online?: boolean } = {}) {
	const fetch = fakeFetch((url) => {
		if (url.pathname === '/api/v1/feed') return json(feedPage(items));
		return undefined;
	});
	const remember = vi.fn(async () => undefined);
	return {
		fetch,
		remember,
		props: {
			api: apiWith(fetch, options.online ?? true),
			session: ANONYMOUS,
			storage: null,
			remember,
			isOnline: () => options.online ?? true
		}
	};
}

test('renders one channel strip per feed item with the identification tape', async () => {
	const { props, fetch } = setup([
		feedItem({ id: 'lin-aaaaaaaaaaaa', name: 'Rádio de madrugada' }),
		feedItem({ id: 'lin-bbbbbbbbbbbb', name: 'Bancada fria', s1: S1_BOOST, license: 'CC0-1.0' })
	]);
	await render(Comunidade, props);
	await expect.element(page.getByRole('link', { name: 'Bancada fria' })).toBeVisible();
	expect(document.querySelectorAll('[data-testid="channel-strip"]')).toHaveLength(2);
	await expect
		.element(page.getByRole('link', { name: '@Geoff' }).first())
		.toHaveAttribute('href', '/u/geoff');
	await expect
		.element(page.getByRole('link', { name: 'Rádio de madrugada' }))
		.toHaveAttribute('href', '/c/lin-aaaaaaaaaaaa');
	const avatars = document.querySelectorAll('[data-testid="curve-avatar"]');
	expect(avatars.length).toBeGreaterThanOrEqual(2);
	const urls = fetch.mock.calls.map(([url]) => url);
	expect(urls).toContainEqual(expect.stringContaining('/api/v1/feed?sort=new'));
});

test('ranked sorts send the window; the window keys appear only then', async () => {
	const { props, fetch } = setup([feedItem()]);
	await render(Comunidade, props);
	await expect.element(page.getByRole('link', { name: 'Rádio de madrugada' })).toBeVisible();
	expect(page.getByRole('button', { name: m.comunidade_window_30d() }).elements()).toHaveLength(0);
	await page.getByRole('button', { name: m.comunidade_sort_favorites() }).click();
	await page.getByRole('button', { name: m.comunidade_window_30d() }).click();
	await expect
		.poll(() => fetch.mock.calls.map(([url]) => url))
		.toContainEqual(expect.stringContaining('sort=favorites&window=30d'));
});

test('an empty feed says so', async () => {
	const { props } = setup([]);
	await render(Comunidade, props);
	await expect.element(page.getByTestId('feed-empty')).toHaveTextContent(m.comunidade_feed_empty());
});

test('offline: the feed shows the notice in place of the list and the page stays usable', async () => {
	const fetch = fakeFetch(() => {
		throw new TypeError('Failed to fetch');
	});
	await render(Comunidade, {
		api: apiWith(fetch, false),
		session: ANONYMOUS,
		storage: null,
		isOnline: () => false
	});
	await expect.element(page.getByTestId('feed-offline')).toBeVisible();
	expect(document.querySelector('[data-testid="feed-empty"]')).toBeNull();
	await expect
		.element(page.getByRole('heading', { level: 1 }))
		.toHaveTextContent(m.comunidade_title());
});

test('without an account: browsing works and social actions show the sign-in prompt', async () => {
	const { props, fetch } = setup([feedItem()]);
	await render(Comunidade, props);
	await page
		.getByRole('button', { name: m.comunidade_channel_select({ name: 'Rádio de madrugada' }) })
		.click();
	await expect
		.element(page.getByRole('link', { name: m.comunidade_login_link() }).first())
		.toHaveAttribute('href', requireLoginHref('/comunidade'));
	const prompts = document.querySelectorAll('[data-testid="login-prompt"]');
	expect(prompts.length).toBeGreaterThanOrEqual(4);
	await expect
		.element(page.getByRole('button', { name: m.comunidade_onair_publish() }))
		.toBeDisabled();
	expect(page.getByRole('button', { name: m.comunidade_share_create() }).elements()).toHaveLength(
		0
	);
	expect(fetch.mock.calls.every(([, init]) => (init.method ?? 'GET') === 'GET')).toBe(true);
	expect(props.remember).toHaveBeenCalledWith({
		s1: feedItem().lineage.curve.s1,
		lineageId: 'lin-aaaaaaaaaaaa',
		versionId: 'ver-lin-aaaaaaaaaaaa'
	});
});

test('no LEDs while no channel is playing (no decorative meters)', async () => {
	const { props } = setup([feedItem(), feedItem({ id: 'lin-bbbbbbbbbbbb', name: 'Outra' })]);
	await render(Comunidade, props);
	await expect.element(page.getByRole('link', { name: 'Outra' })).toBeVisible();
	expect(document.querySelectorAll('[data-testid="channel-leds"]')).toHaveLength(0);
	expect(document.querySelectorAll('.oa-leds')).toHaveLength(0);
});

test('listening without the audio engine shows a notice and lights nothing', async () => {
	const { props } = setup([feedItem()]);
	await render(Comunidade, props);
	await page
		.getByRole('button', { name: m.comunidade_channel_listen({ name: 'Rádio de madrugada' }) })
		.click();
	await expect
		.poll(() => document.querySelector('.page-notice')?.textContent)
		.toBe(m.comunidade_audio_unavailable());
	expect(document.querySelectorAll('[data-testid="channel-leds"]')).toHaveLength(0);
});

test('user text is rendered as text, never as HTML', async () => {
	const hostile = '<img src=x onerror="window.__pwned=1">';
	const { props } = setup([
		feedItem({ name: hostile, author: { username: 'x', displayUsername: hostile } })
	]);
	await render(Comunidade, props);
	await expect.element(page.getByRole('link', { name: hostile }).first()).toBeVisible();
	expect(document.querySelector('img[src="x"]')).toBeNull();
	expect(Reflect.get(window, '__pwned')).toBeUndefined();
});

test('a removed author is credited as such', async () => {
	const { props } = setup([feedItem({ author: null })]);
	await render(Comunidade, props);
	await expect.element(page.getByText(m.comunidade_author_removed()).first()).toBeVisible();
});

test('the homage cites both sources', async () => {
	const { props } = setup([]);
	await render(Comunidade, props);
	await expect
		.element(page.getByRole('link', { name: m.comunidade_homage_source_bob() }))
		.toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Bob_Clearmountain');
	await expect
		.element(page.getByRole('link', { name: m.comunidade_homage_source_live_aid() }))
		.toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Live_Aid');
});
