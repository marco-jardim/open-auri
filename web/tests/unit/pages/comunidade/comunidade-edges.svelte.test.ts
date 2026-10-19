import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import Comunidade from '#lib/components/pages/comunidade/Comunidade.svelte';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { createTour } from '#lib/comprehension/tour.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { encodeS1 } from 'open-auri/share';
import { createYoloState, YOLO_PHRASE } from '#lib/state/yolo.svelte.ts';
import { fakeAppOptions } from '../../app/fakes.ts';
import { fakeEnv } from '../../audio/fake-audio.ts';
import {
	ANONYMOUS,
	NEUTRAL,
	VERIFIED,
	S1_BOOST,
	apiError,
	apiWith,
	fakeFetch,
	feedItem,
	feedPage,
	json,
	type Route
} from './fixtures.ts';

const apps: ClientApp[] = [];
const engines: AudioEngine[] = [];
function appFixture() {
	const audio = createAudioEngine(fakeEnv(null).env);
	engines.push(audio);
	const app = createClientApp({ ...fakeAppOptions().options, audio });
	apps.push(app);
	return app;
}
function setup(route: Route, session = ANONYMOUS) {
	const fetch = fakeFetch(route);
	return {
		fetch,
		props: {
			api: apiWith(fetch),
			session,
			storage: null,
			remember: vi.fn(async () => undefined),
			tourController: createTour({ storage: () => undefined, isDesktop: () => false }),
			isOnline: () => true
		}
	};
}
const select = (name: string) =>
	page.getByRole('button', { name: m.comunidade_channel_select({ name }) });
const listen = (name: string) =>
	page.getByRole('button', { name: m.comunidade_channel_listen({ name }) });
afterEach(async () => {
	await cleanup();
	apps.splice(0).forEach((app) => app.dispose());
	await Promise.all(engines.splice(0).map((audio) => audio.dispose()));
	vi.restoreAllMocks();
});

test('a feed error can be retried without reloading the page', async () => {
	let failed = true;
	const { props, fetch } = setup((url) =>
		url.pathname === '/api/v1/feed'
			? failed
				? apiError('RATE_LIMITED', 429)
				: json(feedPage([feedItem()]))
			: undefined
	);
	await render(Comunidade, props);
	// Scoped to the console: "Comunidade prefere" has its own alert (PrefersPanel.svelte:69) for
	// the 404 its preferences request gets from this route.
	const desk = page.getByRole('region', { name: m.comunidade_console_title(), exact: true });
	await expect.element(desk.getByRole('alert')).toMatchTextContent(m.comunidade_error_rate());
	failed = false;
	await desk.getByRole('button', { name: m.comunidade_retry() }).click();
	await expect.element(page.getByRole('link', { name: 'Rádio de madrugada' })).toBeVisible();
	expect(fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/feed'))).toHaveLength(2);
	await expect.element(page.getByTestId('feed-signal')).toHaveAttribute('data-on', 'true');
});

test('pagination retains the first page on error, retries its cursor, then appends and removes the control', async () => {
	let failMore = true;
	const { props, fetch } = setup((url) => {
		if (url.pathname !== '/api/v1/feed') return undefined;
		if (!url.searchParams.has('cursor')) return json(feedPage([feedItem()], 'next-page'));
		return failMore
			? apiError('INTERNAL', 500)
			: json(feedPage([feedItem({ id: 'lin-bbbbbbbbbbbb', name: 'Página dois' })]));
	});
	await render(Comunidade, props);
	const more = page.getByRole('button', { name: m.comunidade_load_more() });
	await more.click();
	await expect
		.poll(() => document.querySelector('.page-notice')?.textContent)
		.toBe(m.comunidade_error_generic());
	await expect.element(page.getByRole('link', { name: 'Rádio de madrugada' })).toBeVisible();
	failMore = false;
	await more.click();
	await expect.element(page.getByRole('link', { name: 'Página dois' })).toBeVisible();
	expect(document.querySelectorAll('[data-testid="channel-strip"]')).toHaveLength(2);
	expect(more.elements()).toHaveLength(0);
	expect(fetch.mock.calls.filter(([url]) => url.includes('cursor=next-page'))).toHaveLength(2);
});

test.each([200, 500])(
	'a stale feed response cannot overwrite a newer sort (HTTP %s)',
	async (status) => {
		let finish: (response: Response) => void = () => undefined;
		const old = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		const { props } = setup((url) => {
			if (url.pathname !== '/api/v1/feed') return undefined;
			return url.searchParams.get('sort') === 'new'
				? old
				: json(feedPage([feedItem({ name: 'Ranking atual' })]));
		});
		await render(Comunidade, props);
		await page.getByRole('button', { name: m.comunidade_sort_installs() }).click();
		await expect.element(page.getByRole('link', { name: 'Ranking atual' })).toBeVisible();
		finish(
			status === 200
				? json(feedPage([feedItem({ name: 'Resposta antiga' })]))
				: apiError('INTERNAL', status)
		);
		await old;
		await expect.element(page.getByRole('link', { name: 'Ranking atual' })).toBeVisible();
		expect(page.getByRole('link', { name: 'Resposta antiga' }).elements()).toHaveLength(0);
	}
);

test('all ranking windows are sent, and returning to recent omits the window', async () => {
	const { props, fetch } = setup((url) =>
		url.pathname === '/api/v1/feed' ? json(feedPage([])) : undefined
	);
	await render(Comunidade, props);
	await page.getByRole('button', { name: m.comunidade_sort_installs() }).click();
	await page.getByRole('button', { name: m.comunidade_window_all() }).click();
	await expect
		.poll(() => fetch.mock.calls.map(([url]) => url))
		.toContainEqual(expect.stringContaining('sort=installs&window=all'));
	await page.getByRole('button', { name: m.comunidade_window_7d() }).click();
	await expect
		.poll(() => fetch.mock.calls.map(([url]) => url))
		.toContainEqual(expect.stringContaining('sort=installs&window=7d'));
	await page.getByRole('button', { name: m.comunidade_sort_new() }).click();
	await expect
		.element(page.getByTestId('feed-empty'))
		.toMatchTextContent(m.empty_community_title());
	const last = fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/feed')).at(-1)?.[0] ?? '';
	expect(new URL(last, location.origin).searchParams.has('window')).toBe(false);
});

test('offline retains loaded strips, disables pagination, and reconnect refreshes the feed', async () => {
	let online = true;
	const { props, fetch } = setup((url) =>
		url.pathname === '/api/v1/feed' ? json(feedPage([feedItem()], 'next')) : undefined
	);
	await render(Comunidade, { ...props, isOnline: () => online });
	await expect.element(page.getByRole('link', { name: 'Rádio de madrugada' })).toBeVisible();
	const reads = fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/feed')).length;
	online = false;
	window.dispatchEvent(new Event('offline'));
	await expect
		.element(page.getByRole('button', { name: m.comunidade_load_more() }))
		.toHaveAccessibleDescription(m.comunidade_offline());
	await expect.element(page.getByTestId('feed-signal')).toHaveAttribute('data-on', 'false');
	expect(document.querySelectorAll('[data-testid="channel-strip"]')).toHaveLength(1);
	expect(fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/feed'))).toHaveLength(reads);
	online = true;
	window.dispatchEvent(new Event('online'));
	await expect
		.poll(() => fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/feed')).length)
		.toBe(reads + 1);
});

test('selection is newest-first, capped at four, and deselection removes its scope trace', async () => {
	const items = Array.from({ length: 5 }, (_, index) =>
		feedItem({ id: `lin-${String(index).repeat(12)}`, name: `Canal ${index}` })
	);
	const { props } = setup((url) =>
		url.pathname === '/api/v1/feed' ? json(feedPage(items)) : undefined
	);
	await render(Comunidade, props);
	for (let index = 0; index < 5; index++) await select(`Canal ${index}`).click();
	expect(document.querySelectorAll('[data-testid="scope-trace"]')).toHaveLength(4);
	await expect.element(select('Canal 0')).toHaveAttribute('aria-pressed', 'false');
	await expect.element(select('Canal 4')).toHaveAttribute('aria-pressed', 'true');
	await select('Canal 4').click();
	expect(document.querySelectorAll('[data-testid="scope-trace"]')).toHaveLength(3);
	await expect.element(select('Canal 4')).toHaveAttribute('aria-pressed', 'false');
	expect(props.remember).toHaveBeenCalledTimes(5);
});

test('using and installing a channel update only the editor and open the write checklist', async () => {
	const app = appFixture();
	const { props } = setup((url) =>
		url.pathname === '/api/v1/feed' ? json(feedPage([feedItem({ s1: S1_BOOST })])) : undefined
	);
	const write = vi.spyOn(app, 'requestWrite');
	await render(Comunidade, { ...props, app });
	await select('Rádio de madrugada').click();
	await page.getByRole('button', { name: m.comunidade_use_curve(), exact: true }).click();
	expect(app.state.curve.current).toMatchObject({
		name: 'Rádio de madrugada',
		source: 'community:lin-aaaaaaaaaaaa',
		preampDb: -3
	});
	await expect
		.poll(() => document.querySelector('.page-notice')?.textContent)
		.toBe(m.comunidade_used({ name: 'Rádio de madrugada' }));
	await page.getByRole('button', { name: m.comunidade_install(), exact: true }).click();
	expect(write).toHaveBeenCalledOnce();
	expect(app.pendingWrite).toMatchObject({
		name: 'Rádio de madrugada',
		source: 'community:lin-aaaaaaaaaaaa'
	});
	expect(app.cableState.writing).toBe(false);
});

const S1_YOLO = encodeS1({
	preampDb: -0.5,
	bands: [{ kind: 'HP' as const, freqHz: 30, qFactor: 0.71 }, ...NEUTRAL.bands.slice(1)]
});

test('a YOLO channel offers "Ativar Modo YOLO" until YOLO is ready, then writes with the YOLO profile', async () => {
	const audio = createAudioEngine(fakeEnv(null).env);
	engines.push(audio);
	const yolo = createYoloState();
	const app = createClientApp({ ...fakeAppOptions().options, audio, yolo });
	apps.push(app);
	const { props } = setup((url) =>
		url.pathname === '/api/v1/feed' ? json(feedPage([feedItem({ s1: S1_YOLO })])) : undefined
	);
	const write = vi.spyOn(app, 'requestWrite');
	await render(Comunidade, { ...props, app });
	await select('Rádio de madrugada').click();
	// YOLO off: the standard checklist would refuse the curve, so the action opens Engenharia.
	const enable = page.getByTestId('scope-yolo-enable');
	await expect.element(enable).toHaveTextContent(m.yolopub_enable_yolo());
	expect(enable.element().getAttribute('href')).toMatch(
		/^\/\?camada=engenharia&l=lin-aaaaaaaaaaaa&v=[^#]+#p=/
	);
	await expect.element(page.getByTestId('scope-yolo-why')).toBeVisible();
	expect(
		page.getByRole('button', { name: m.comunidade_install(), exact: true }).elements()
	).toEqual([]);
	expect(write).not.toHaveBeenCalled();
	// YOLO on in Engenharia: the button is labelled YOLO and opens the YOLO checklist.
	expect(yolo.enable(YOLO_PHRASE, 'engenharia')).toBe(true);
	await page.getByRole('button', { name: m.qa1y_write_yolo(), exact: true }).click();
	expect(write).toHaveBeenCalledOnce();
	expect(write.mock.calls[0]?.[1]).toEqual({ profile: 'yolo' });
	expect(app.pendingProfile).toBe('yolo');
	expect(app.pendingWrite).toMatchObject({ source: 'community:lin-aaaaaaaaaaaa', preampDb: -0.5 });
	expect(page.getByTestId('scope-yolo-enable').elements()).toEqual([]);
});

test('a standard channel keeps the standard checklist while Modo YOLO is on', async () => {
	const audio = createAudioEngine(fakeEnv(null).env);
	engines.push(audio);
	const yolo = createYoloState();
	const app = createClientApp({ ...fakeAppOptions().options, audio, yolo });
	apps.push(app);
	expect(yolo.enable(YOLO_PHRASE, 'engenharia')).toBe(true);
	const { props } = setup((url) =>
		url.pathname === '/api/v1/feed' ? json(feedPage([feedItem({ s1: S1_BOOST })])) : undefined
	);
	const write = vi.spyOn(app, 'requestWrite');
	await render(Comunidade, { ...props, app });
	await select('Rádio de madrugada').click();
	await page.getByRole('button', { name: m.comunidade_install(), exact: true }).click();
	expect(write).toHaveBeenCalledOnce();
	expect(write.mock.calls[0]?.[1]).toBeUndefined();
	expect(app.pendingProfile).toBe('standard');
});

test('without the app, use/install actions show notices instead of mutating anything', async () => {
	const { props } = setup((url) =>
		url.pathname === '/api/v1/feed' ? json(feedPage([feedItem()])) : undefined
	);
	await render(Comunidade, props);
	await select('Rádio de madrugada').click();
	await page.getByRole('button', { name: m.comunidade_use_curve(), exact: true }).click();
	await expect
		.poll(() => document.querySelector('.page-notice')?.textContent)
		.toBe(m.comunidade_audio_unavailable());
	await page.getByRole('button', { name: m.comunidade_install(), exact: true }).click();
	await expect
		.poll(() => document.querySelector('.page-notice')?.textContent)
		.toBe(m.comunidade_install_unavailable());
});

test('channel preview starts on B, records its origin and a second press stops it', async () => {
	const app = appFixture();
	const start = vi.spyOn(app.audio, 'start');
	const stop = vi.spyOn(app.audio, 'stop');
	const { props } = setup((url) =>
		url.pathname === '/api/v1/feed' ? json(feedPage([feedItem()])) : undefined
	);
	// Avoid a real worklet: the channel still attempts to attach a meter to the audible chain.
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const tap = vi.fn().mockRejectedValue(new Error('no meter'));
	await render(Comunidade, { ...props, app, tap });
	await listen('Rádio de madrugada').click();
	await expect.poll(() => props.remember.mock.calls.length).toBe(1);
	expect(start).toHaveBeenCalledWith('chains', { startAt: 'random', session: 'comunidade' });
	expect(app.audio.state().playing).toBe(true);
	// The accessible name changes to the channel stop action while it plays.
	await page
		.getByRole('button', { name: m.comunidade_channel_stop({ name: 'Rádio de madrugada' }) })
		.click();
	await expect.poll(() => app.audio.state().playing).toBe(false);
	expect(stop).toHaveBeenCalled();
});

test.each([new Error('blocked'), 'blocked'])(
	'audio rejection leaves no origin and displays a safe notice (%s)',
	async (error) => {
		const app = appFixture();
		vi.spyOn(app.audio, 'start').mockRejectedValueOnce(error);
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { props } = setup((url) =>
			url.pathname === '/api/v1/feed' ? json(feedPage([feedItem()])) : undefined
		);
		await render(Comunidade, { ...props, app });
		await listen('Rádio de madrugada').click();
		await expect
			.poll(() => document.querySelector('.page-notice')?.textContent)
			.toBe(m.comunidade_audio_error());
		expect(props.remember).not.toHaveBeenCalled();
		expect(app.audio.state().playing).toBe(false);
	}
);

test('signed-in users load creations; selecting their own channel prefers its recall log', async () => {
	const item = feedItem();
	const { props, fetch } = setup(
		(url) => {
			if (url.pathname === '/api/v1/feed') return json(feedPage([item]));
			if (url.pathname === '/api/v1/me/library')
				return json({
					items: [
						{
							...item.lineage,
							id: 'lin-other',
							head: { ...item.lineage.head, name: 'Outra criação' }
						},
						item.lineage
					],
					nextCursor: null
				});
			if (url.pathname.startsWith('/api/v1/lineages/'))
				return json({ lineage: item.lineage, author: null, versions: [], nextCursor: null });
			return undefined;
		},
		{ ...VERIFIED, nickname: 'GEOFF' }
	);
	await render(Comunidade, props);
	await expect.element(page.getByTestId('total-recall')).toBeVisible();
	await select('Rádio de madrugada').click();
	await expect
		.poll(() => fetch.mock.calls.map(([url]) => url))
		.toContainEqual(expect.stringContaining('/api/v1/lineages/lin-aaaaaaaaaaaa'));
	expect(document.querySelector('[data-testid="login-prompt"]')).toBeNull();
	expect(fetch.mock.calls.map(([url]) => url)).toContainEqual(
		expect.stringContaining('shelf=created')
	);
});

test.each([new Error('private failure'), 'private failure'])(
	'failed owned-library loading leaves recall empty but browsing remains usable (%s)',
	async (error) => {
		const { props } = setup(
			(url) => (url.pathname === '/api/v1/feed' ? json(feedPage([feedItem()])) : undefined),
			VERIFIED
		);
		vi.spyOn(props.api, 'myLibrary').mockRejectedValueOnce(error);
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await render(Comunidade, props);
		await expect.element(page.getByText(m.comunidade_recall_none())).toBeVisible();
		await expect.element(page.getByRole('link', { name: 'Rádio de madrugada' })).toBeVisible();
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('comunidade.owned_failed'));
	}
);

test('empty-console publishing action focuses the desk and packs drawer mounts on demand', async () => {
	const { props } = setup((url) =>
		url.pathname === '/api/v1/feed' ? json(feedPage([])) : undefined
	);
	await render(Comunidade, props);
	await page.getByRole('link', { name: m.empty_community_action(), exact: true }).click();
	expect(document.activeElement).toBe(document.querySelector('#publicar input:not(:disabled)'));
	expect(document.querySelector('[data-testid="packs-panel"]')).toBeNull();
	await page.getByText(m.comunidade_packs_title(), { exact: true }).click();
	await expect.element(page.getByTestId('packs-panel')).toBeVisible();
});

test.each([false, true])(
	'a successful publication refreshes creations and lights the matching page tally (ranked=%s)',
	async (ranked) => {
		const app = appFixture();
		const { props, fetch } = setup((url, init) => {
			if (url.pathname === '/api/v1/feed') return json(feedPage([]));
			if (url.pathname === '/api/v1/me/library') return json({ items: [], nextCursor: null });
			if (url.pathname === '/api/v1/curves' && init.method === 'POST')
				return json({ lineageId: 'lin-new', versionId: 'ver-new', curveId: 'cnew' }, 201);
			return undefined;
		}, VERIFIED);
		await render(Comunidade, { ...props, app });
		await expect.element(page.getByTestId('feed-empty')).toBeVisible();
		if (ranked) {
			await page.getByRole('button', { name: m.comunidade_sort_favorites() }).click();
			await expect
				.element(page.getByTestId('feed-empty'))
				.toHaveTextContent(m.comunidade_feed_empty_ranking());
		}
		const feeds = fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/feed')).length;
		const libraries = fetch.mock.calls.filter(([url]) =>
			url.startsWith('/api/v1/me/library')
		).length;
		await page.getByRole('button', { name: m.comunidade_onair_publish(), exact: true }).click();
		await expect.element(page.getByTestId('onair-lamp')).toHaveAttribute('data-lit', 'true');
		await expect
			.poll(() => document.querySelector('.mini-tally')?.classList.contains('lit'))
			.toBe(true);
		await expect
			.poll(() => fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/me/library')).length)
			.toBe(libraries + 1);
		expect(fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/feed'))).toHaveLength(
			feeds + (ranked ? 0 : 1)
		);
		expect(props.remember).toHaveBeenCalledWith(
			expect.objectContaining({ lineageId: 'lin-new', versionId: 'ver-new' })
		);
	}
);

test.each([
	{ session: VERIFIED, queue: true, reason: 'storage' as const, expected: 1 },
	{ session: VERIFIED, queue: true, reason: 'signed-out' as const, expected: 1 },
	{ session: VERIFIED, queue: true, reason: 'unverified' as const, expected: 1 },
	{ session: ANONYMOUS, queue: true, reason: 'storage' as const, expected: 0 },
	{
		session: { ...VERIFIED, verified: false },
		queue: true,
		reason: 'storage' as const,
		expected: 0
	},
	{ session: VERIFIED, queue: false, reason: 'storage' as const, expected: 0 }
])(
	'ten audible seconds queue activity only for a verified account with an outbox ($expected, $reason)',
	async ({ session, queue, reason, expected }) => {
		const app = appFixture();
		const { props } = setup((url) => {
			if (url.pathname === '/api/v1/feed') return json(feedPage([feedItem()]));
			if (url.pathname === '/api/v1/me/library') return json({ items: [], nextCursor: null });
			return undefined;
		}, session);
		const enqueue = vi.fn(async () => ({ ok: false as const, reason }));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		let now = 100000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		let fire: (() => void) | undefined;
		const original = globalThis.setTimeout.bind(globalThis);
		vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, ms, ...args) => {
			if (ms === 10000 && typeof handler === 'function') {
				fire = () => handler(...args);
				// Preserve the platform's timer-handle type without waiting ten wall-clock seconds.
				return original(() => undefined, 0);
			}
			return original(handler, ms, ...args);
		});
		await render(Comunidade, {
			...props,
			app,
			outbox: queue ? { enqueue } : null,
			tap: vi.fn().mockRejectedValue(new Error('no worklet'))
		});
		await listen('Rádio de madrugada').click();
		await expect.poll(() => props.remember.mock.calls.length).toBe(1);
		if (!fire) throw new Error('Expected audible-preview threshold timer');
		now += 10000;
		fire();
		await Promise.resolve();
		expect(enqueue).toHaveBeenCalledTimes(expected);
		if (expected) {
			expect(enqueue).toHaveBeenCalledWith({
				kind: 'previewed',
				lineageId: 'lin-aaaaaaaaaaaa',
				durationMs: 10000
			});
		}
		const dropped = warn.mock.calls.filter(([value]) =>
			String(value).includes('comunidade.previewed_not_queued')
		);
		expect(dropped).toHaveLength(expected && reason === 'storage' ? 1 : 0);
	}
);
