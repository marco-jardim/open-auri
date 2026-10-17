// T4.13 + FUX.P4: the Comunidade page (Chromium). Feed rendering by channel, skeleton strips while
// loading, the empty console that teaches (EXAMPLE strips), offline, ONE account card for visitors
// (open and closed sign-up), actions unavailable with a reason, the legend as the tour door, the
// tour targets, drawers that mount on demand, no LEDs while nothing plays, user text only as text.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createTour } from '#lib/comprehension/tour.svelte.ts';
import Comunidade from '#lib/components/pages/comunidade/Comunidade.svelte';
import { m } from '#lib/paraglide/messages.js';
import { requireLoginHref, type SocialFetch } from '#lib/social/index.ts';
import { ANONYMOUS, apiWith, fakeFetch, feedItem, feedPage, json, S1_BOOST } from './fixtures.ts';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

/** A tour controller that never auto-opens and never touches localStorage. */
function quietTour() {
	return createTour({ storage: () => undefined, isDesktop: () => false });
}

function setup(items: unknown[], options: { online?: boolean; signupOpen?: boolean } = {}) {
	const fetch = fakeFetch((url) => {
		if (url.pathname === '/api/v1/feed') return json(feedPage(items));
		return undefined;
	});
	const remember = vi.fn(async () => undefined);
	const tourController = quietTour();
	return {
		fetch,
		remember,
		tourController,
		props: {
			api: apiWith(fetch, options.online ?? true),
			session: ANONYMOUS,
			storage: null,
			remember,
			tourController,
			signupOpen: options.signupOpen ?? true,
			isOnline: () => options.online ?? true
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

test('renders one channel strip per feed item with the identification tape', async () => {
	const { props, fetch } = setup([
		feedItem({ id: 'lin-aaaaaaaaaaaa', name: 'Rádio de madrugada' }),
		feedItem({ id: 'lin-bbbbbbbbbbbb', name: 'Bancada fria', s1: S1_BOOST, license: 'CC0-1.0' })
	]);
	await render(Comunidade, props);
	await expect.element(page.getByRole('link', { name: 'Bancada fria' })).toBeVisible();
	expect(document.querySelectorAll('[data-testid="channel-strip"]')).toHaveLength(2);
	expect(document.querySelectorAll('[data-testid="example-strip"]')).toHaveLength(0);
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
	await expect.element(page.getByText(m.comunidade_channel_count({ count: '2' }))).toBeVisible();
});

test('six skeleton strips hold the console while the first page loads', async () => {
	let release: (response: Response) => void = () => undefined;
	const pending = new Promise<Response>((resolve) => {
		release = resolve;
	});
	const fetch = vi.fn<SocialFetch>(async (input) => {
		const url = new URL(input, 'https://example.test');
		if (url.pathname === '/api/v1/feed') return pending;
		return json({ error: { code: 'NOT_FOUND' } }, 404);
	});
	await render(Comunidade, {
		api: apiWith(fetch, true),
		session: ANONYMOUS,
		storage: null,
		tourController: quietTour(),
		isOnline: () => true
	});
	const loading = page.getByTestId('feed-loading');
	await expect.element(loading).toHaveAttribute('aria-busy', 'true');
	expect(document.querySelectorAll('[data-testid="feed-loading"] .skel-strip')).toHaveLength(6);
	release(json(feedPage([feedItem()])));
	await expect.element(page.getByRole('link', { name: 'Rádio de madrugada' })).toBeVisible();
	expect(document.querySelector('[data-testid="feed-loading"]')).toBeNull();
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

test('an empty console teaches: §4.4 text, three EXAMPLE strips and the publish action', async () => {
	const { props } = setup([]);
	await render(Comunidade, props);
	const empty = page.getByTestId('feed-empty');
	await expect.element(empty).toBeVisible();
	await expect
		.element(page.getByRole('heading', { name: m.empty_community_title(), exact: true }))
		.toBeVisible();
	await expect.element(empty).toMatchTextContent(m.comunidade_v2_empty_why());
	const action = page.getByRole('link', { name: m.empty_community_action(), exact: true });
	await expect.element(action).toHaveAttribute('href', '#publicar');
	// Three official presets drawn as examples: labelled, not published, not interactive.
	const examples = document.querySelectorAll('[data-testid="example-strip"]');
	expect(examples).toHaveLength(3);
	for (const strip of examples) {
		expect(strip.textContent).toContain(m.empty_example());
		expect(strip.textContent).toContain(m.empty_example_unpublished());
		expect(strip.querySelector('button, a, input, select')).toBeNull();
		expect(strip.querySelector('[data-testid="channel-leds"]')).toBeNull();
	}
	expect(document.querySelectorAll('[data-testid="channel-strip"]')).toHaveLength(0);
	// No "0 channels on the desk" line under an empty console.
	expect(document.body.textContent).not.toContain(m.comunidade_channel_count({ count: '0' }));
});

test('an empty ranking window keeps its own short state (no examples)', async () => {
	const { props } = setup([]);
	await render(Comunidade, props);
	await expect.element(page.getByTestId('feed-empty')).toBeVisible();
	await page.getByRole('button', { name: m.comunidade_sort_favorites() }).click();
	await expect
		.element(page.getByTestId('feed-empty'))
		.toHaveTextContent(m.comunidade_feed_empty_ranking());
	expect(document.querySelectorAll('[data-testid="example-strip"]')).toHaveLength(0);
});

test('"Comunidade prefere" shows its empty state for the empty document of the first deploy', async () => {
	const fetch = fakeFetch((url) => {
		if (url.pathname === '/api/v1/feed') return json(feedPage([]));
		if (url.pathname === '/api/v1/s6/preferences') {
			return json({
				generatedAt: null,
				consentVersion: 's6-consent-v1',
				items: [],
				pairs: 0,
				converged: true
			});
		}
		return undefined;
	});
	await render(Comunidade, {
		api: apiWith(fetch, true),
		session: ANONYMOUS,
		storage: null,
		tourController: quietTour(),
		isOnline: () => true
	});
	await expect.element(page.getByText(m.comunidade_prefers_empty())).toBeVisible();
	expect(fetch.mock.calls.map(([url]) => url)).toContainEqual(
		expect.stringContaining('/api/v1/s6/preferences')
	);
});

test('offline: the feed shows the notice in place of the list and the page stays usable', async () => {
	const fetch = fakeFetch(() => {
		throw new TypeError('Failed to fetch');
	});
	await render(Comunidade, {
		api: apiWith(fetch, false),
		session: ANONYMOUS,
		storage: null,
		tourController: quietTour(),
		isOnline: () => false
	});
	await expect.element(page.getByTestId('feed-offline')).toBeVisible();
	expect(document.querySelector('[data-testid="feed-empty"]')).toBeNull();
	await expect
		.element(page.getByRole('heading', { level: 1 }))
		.toHaveTextContent(m.comunidade_title());
	await expect.element(page.getByTestId('feed-signal')).toHaveAttribute('data-on', 'false');
});

test('the server signal lamp lights only once the feed answered', async () => {
	const { props } = setup([feedItem()]);
	await render(Comunidade, props);
	await expect.element(page.getByTestId('feed-signal')).toHaveAttribute('data-on', 'true');
});

test('without an account: ONE account card, browsing works, actions say why they are off', async () => {
	const { props, fetch } = setup([feedItem()]);
	await render(Comunidade, props);
	await page
		.getByRole('button', { name: m.comunidade_channel_select({ name: 'Rádio de madrugada' }) })
		.click();
	// T9: a single card instead of a notice in every panel.
	expect(document.querySelectorAll('[data-testid="login-prompt"]')).toHaveLength(1);
	const card = page.getByTestId('login-prompt');
	await expect.element(card).toHaveAttribute('data-variant', 'open');
	await expect.element(card).toMatchTextContent(m.empty_guest_title());
	await expect.element(card).toMatchTextContent(m.empty_guest_open());
	await expect
		.element(card.getByRole('link', { name: m.comunidade_login_link(), exact: true }))
		.toHaveAttribute('href', requireLoginHref('/comunidade'));
	await expect
		.element(card.getByRole('link', { name: m.empty_guest_action(), exact: true }))
		.toHaveAttribute('href', '/criar-conta');
	// T8: publishing is unavailable and says why (aria-disabled, still focusable).
	const publish = page.getByRole('button', { name: m.comunidade_onair_publish(), exact: true });
	await expect.element(publish).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(publish.element())).toBe(m.comunidade_v2_reason_account());
	// The share drawer is closed: its panel (and the QR module) are not mounted.
	expect(document.querySelector('[data-testid="share-panel"]')).toBeNull();
	expect(fetch.mock.calls.every(([, init]) => (init.method ?? 'GET') === 'GET')).toBe(true);
	expect(props.remember).toHaveBeenCalledWith({
		s1: feedItem().lineage.curve.s1,
		lineageId: 'lin-aaaaaaaaaaaa',
		versionId: 'ver-lin-aaaaaaaaaaaa'
	});
});

test('with sign-up closed the card says accounts open soon and offers no sign-up', async () => {
	const { props } = setup([], { signupOpen: false });
	await render(Comunidade, props);
	const card = page.getByTestId('login-prompt');
	await expect.element(card).toHaveAttribute('data-variant', 'closed');
	await expect.element(card).toMatchTextContent(m.empty_guest_closed());
	expect(
		card.getByRole('link', { name: m.empty_guest_action(), exact: true }).elements()
	).toHaveLength(0);
});

test('Ouvir A/B is unavailable with a reason until a channel is selected', async () => {
	const { props } = setup([feedItem()]);
	await render(Comunidade, props);
	const play = page.getByRole('button', { name: m.comunidade_listen(), exact: true });
	await expect.element(play).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(play.element())).toBe(m.comunidade_v2_reason_ab_select());
	await page
		.getByRole('button', { name: m.comunidade_channel_select({ name: 'Rádio de madrugada' }) })
		.click();
	// Selected, but the audio runtime is not mounted (app is null): still a reason, never an error.
	await expect.poll(() => reasonOf(play.element())).toBe(m.comunidade_audio_unavailable());
});

test('the header legend is the door of the tour and every tour target exists', async () => {
	const { props, tourController } = setup([feedItem()]);
	await render(Comunidade, props);
	await expect.element(page.getByRole('link', { name: 'Rádio de madrugada' })).toBeVisible();
	for (const target of [
		'comunidade-channels',
		'comunidade-scope',
		'comunidade-publish',
		'comunidade-blind'
	]) {
		expect(document.querySelectorAll(`[data-tour="${target}"]`)).toHaveLength(1);
	}
	expect(tourController.activePage).toBeNull();
	await page.getByTestId('legend-onair').click();
	expect(tourController.activePage).toBe('comunidade');
	expect(tourController.stepIndex).toBe(2);
	await expect.element(page.getByRole('dialog')).toBeVisible();
});

test('no plan codes in visible headings', async () => {
	const { props } = setup([feedItem()]);
	await render(Comunidade, props);
	await expect.element(page.getByRole('link', { name: 'Rádio de madrugada' })).toBeVisible();
	const headings = Array.from(document.querySelectorAll('h1, h2, h3, summary, th'));
	for (const heading of headings) {
		expect(heading.textContent ?? '').not.toMatch(/\bS(10|[1-9])\b/);
	}
});

test('the drawers mount their panels only when opened', async () => {
	const { props, fetch } = setup([feedItem()]);
	await render(Comunidade, props);
	await expect.element(page.getByRole('link', { name: 'Rádio de madrugada' })).toBeVisible();
	expect(document.querySelector('[data-testid="report-panel"]')).toBeNull();
	expect(document.querySelector('[data-testid="packs-panel"]')).toBeNull();
	await page.getByText(m.comunidade_share_title(), { exact: true }).click();
	await expect.element(page.getByTestId('share-panel')).toBeVisible();
	await expect
		.element(page.getByTestId('share-panel'))
		.toMatchTextContent(m.comunidade_select_first());
	await page.getByText(m.comunidade_report_title(), { exact: true }).click();
	await expect.element(page.getByTestId('report-panel')).toBeVisible();
	// Visitors: no Turnstile anywhere (no widget, no third-party script).
	expect(document.querySelector('input[name="cf-turnstile-response"]')).toBeNull();
	expect(document.getElementById('cf-turnstile-api')).toBeNull();
	expect(fetch.mock.calls.every(([, init]) => (init.method ?? 'GET') === 'GET')).toBe(true);
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

test('the page renders no homage of its own (the layout footer carries it)', async () => {
	const { props } = setup([]);
	await render(Comunidade, props);
	await expect.element(page.getByTestId('feed-empty')).toBeVisible();
	expect(document.querySelector('aside')).toBeNull();
	expect(document.body.textContent).not.toContain('Bob Clearmountain');
	expect(document.querySelector('a[href*="wikipedia.org"]')).toBeNull();
});
