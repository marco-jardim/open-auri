// T4.5: the shared-curve card of /c/[id] (Chromium). Rendering, OG tags, and the actions: the
// `#p=` link, favorite (login prompt when anonymous), install through app.requestWrite only.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { encodeS1 } from 'open-auri/share';
import type { ClientApp } from '#lib/app/client.svelte.ts';
import {
	IDLE_STATE,
	type AudioEngineState,
	type PlayMode,
	type StartOptions
} from '#lib/audio/engine.ts';
import SharedCurve from '#lib/components/pages/shared-curve/SharedCurve.svelte';
import type { SharedCurveData, SharedCurveMeta } from '#lib/components/pages/shared-curve/types.ts';
import { m } from '#lib/paraglide/messages.js';
import { neutralCurve } from '#lib/state/model.ts';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const S1 = encodeS1(neutralCurve());

function data(overrides: Partial<SharedCurveData> = {}): SharedCurveData {
	return {
		lineageId: 'lin-abcdef123456',
		versionId: 'ver-abcdef123456',
		isHead: true,
		name: 'Warm vocal',
		description: 'A gentle lift around 3 kHz.',
		license: 'CC-BY-4.0',
		lang: 'en-US',
		author: { username: 'geoff', displayUsername: 'Geoff' },
		s1: S1,
		visibility: 'public',
		shareId: 'share-abcdef1234',
		...overrides
	};
}

const META: SharedCurveMeta = {
	canonical: 'https://example.test/c/lin-abcdef123456',
	image: 'https://example.test/og/ver-abcdef123456.png',
	indexable: true
};

/** A stateful fake engine: sessions, pause and resume as the SEEK.1 transport reports them. */
function fakeAudio() {
	let current: AudioEngineState = { ...IDLE_STATE };
	const listeners = new Set<(state: AudioEngineState) => void>();
	const set = (next: Partial<AudioEngineState>) => {
		current = { ...current, ...next };
		for (const listener of listeners) listener(current);
	};
	return {
		createAB: vi.fn(() => ({ dispose: vi.fn(), select: vi.fn() })),
		start: vi.fn(async (mode: PlayMode = 'chains', options: StartOptions = {}) => {
			set({ mode, playing: true, paused: false, session: options.session ?? null });
		}),
		stop: vi.fn(() => set({ mode: 'off', playing: false, paused: false, session: null })),
		pause: vi.fn(() => set({ mode: 'off', playing: false, paused: true })),
		resume: vi.fn(async () => {
			set({ mode: 'chains', playing: true, paused: false });
			return true;
		}),
		seek: vi.fn(() => false),
		restart: vi.fn(() => false),
		// The Transport warms the engine on press; a running context needs nothing more.
		getContext: () => ({ state: 'running', resume: async () => undefined }),
		state: () => current,
		onChange: (listener: (state: AudioEngineState) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}

function fakeApp() {
	const requestWrite = vi.fn();
	const audio = fakeAudio();
	const app = {
		requestWrite,
		state: { curve: { current: neutralCurve() } },
		audio
	};
	return { app: app as unknown as ClientApp, requestWrite, audio };
}

test('renders the card, the #p= fallback link and the OG meta tags', async () => {
	await render(SharedCurve, { curve: data(), meta: META, signedIn: false });
	await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent('Warm vocal');
	await expect
		.element(page.getByRole('link', { name: 'Geoff' }))
		.toHaveAttribute('href', '/u/geoff');
	await expect.element(page.getByTestId('shared-curve-license')).toHaveTextContent('CC-BY-4.0');
	await expect
		.element(page.getByRole('link', { name: m.shared_curve_open() }))
		.toHaveAttribute('href', `/?l=lin-abcdef123456&v=ver-abcdef123456#p=${S1}`);
	expect(document.querySelector('figure, svg')).not.toBeNull();

	const metaOf = (selector: string) =>
		document.head.querySelector(selector)?.getAttribute('content');
	expect(metaOf('meta[property="og:image"]')).toBe(META.image);
	expect(metaOf('meta[property="og:url"]')).toBe(META.canonical);
	expect(metaOf('meta[property="og:title"]')).toBe('Warm vocal');
	expect(metaOf('meta[property="og:description"]')).toBe('A gentle lift around 3 kHz.');
	expect(metaOf('meta[name="twitter:card"]')).toBe('summary_large_image');
	expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
		META.canonical
	);
	expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
});

test('unlisted cards are noindex', async () => {
	await render(SharedCurve, {
		curve: data({ visibility: 'unlisted' }),
		meta: { ...META, indexable: false },
		signedIn: false
	});
	await expect.element(page.getByText(m.shared_curve_unlisted())).toBeVisible();
	expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
		'noindex'
	);
});

test('a removed author is shown as such; user text is never HTML', async () => {
	const hostile = '<img src=x onerror="window.__pwned=1">';
	await render(SharedCurve, {
		curve: data({ author: null, name: hostile, description: hostile }),
		meta: META,
		signedIn: false
	});
	await expect
		.element(page.getByTestId('shared-curve-author'))
		.toMatchTextContent(m.shared_curve_author_removed());
	await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent(hostile);
	expect(document.querySelector('img[src="x"]')).toBeNull();
});

test('favorite prompts login when anonymous and never calls the API', async () => {
	const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
	await render(SharedCurve, { curve: data(), meta: META, signedIn: false, fetcher });
	await page.getByRole('button', { name: m.shared_curve_favorite() }).click();
	await expect.element(page.getByText(m.shared_curve_login_prompt())).toBeVisible();
	await expect
		.element(page.getByRole('link', { name: m.shared_curve_login() }))
		.toHaveAttribute('href', '/entrar');
	expect(fetcher).not.toHaveBeenCalled();
});

test('favorite when signed in calls PUT with the share id', async () => {
	const fetcher = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
		async () => new Response(null, { status: 204 })
	);
	await render(SharedCurve, { curve: data(), meta: META, signedIn: true, fetcher });
	await page.getByRole('button', { name: m.shared_curve_favorite() }).click();
	await expect
		.element(page.getByRole('button', { name: m.shared_curve_favorited() }))
		.toHaveAttribute('aria-pressed', 'true');
	expect(fetcher).toHaveBeenCalledTimes(1);
	const [url, init] = fetcher.mock.calls[0] ?? [];
	expect(url).toBe('/api/v1/curves/lin-abcdef123456/favorite?s=share-abcdef1234');
	expect(init?.method).toBe('PUT');
});

test('favorite failure keeps the #p= link and shows the error', async () => {
	const fetcher = vi.fn(async () => {
		throw new TypeError('offline');
	});
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	await render(SharedCurve, { curve: data(), meta: META, signedIn: true, fetcher });
	await page.getByRole('button', { name: m.shared_curve_favorite() }).click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.shared_curve_favorite_error());
	await expect.element(page.getByRole('link', { name: m.shared_curve_open() })).toBeVisible();
});

test('install only opens the checklist with the decoded curve', async () => {
	const { app, requestWrite } = fakeApp();
	await render(SharedCurve, { curve: data(), meta: META, signedIn: false, app });
	await page.getByRole('button', { name: m.shared_curve_install() }).click();
	expect(requestWrite).toHaveBeenCalledTimes(1);
	const curve = requestWrite.mock.calls[0]?.[0] as {
		name: string;
		source: string;
		bands: unknown;
		preampDb: number;
	};
	const neutral = neutralCurve();
	expect(curve.name).toBe('Warm vocal');
	expect(curve.source).toBe('community:lin-abcdef123456');
	expect(curve.bands).toEqual(neutral.bands);
	expect(curve.preampDb).toBe(neutral.preampDb);
});

test('install and listen without the app show a notice instead of acting', async () => {
	await render(SharedCurve, { curve: data(), meta: META, signedIn: false });
	await page.getByRole('button', { name: m.shared_curve_install() }).click();
	await expect
		.element(page.getByRole('status'))
		.toHaveTextContent(m.shared_curve_install_unavailable());
	await page.getByRole('button', { name: m.shared_curve_listen() }).click();
	await expect
		.element(page.getByRole('status'))
		.toHaveTextContent(m.shared_curve_audio_unavailable());
});

test('listen previews through the shared audio engine and stops again', async () => {
	const { app } = fakeApp();
	await render(SharedCurve, { curve: data(), meta: META, signedIn: false, app });
	await page.getByRole('button', { name: m.shared_curve_listen() }).click();
	await expect
		.element(page.getByRole('button', { name: m.shared_curve_stop() }))
		.toHaveAttribute('aria-pressed', 'true');
	const audio = (
		app as unknown as {
			audio: { createAB: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
		}
	).audio;
	expect(audio.createAB).toHaveBeenCalledTimes(1);
	await page.getByRole('button', { name: m.shared_curve_stop() }).click();
	expect(audio.stop).toHaveBeenCalled();
});

test('the Transport renders, starts at a random point and its pause keeps the session', async () => {
	const { app, audio } = fakeApp();
	await render(SharedCurve, { curve: data(), meta: META, signedIn: false, app });
	const transport = page.getByRole('group', { name: m.transport_group() });
	await expect.element(transport).toBeVisible();
	await expect
		.element(transport.getByRole('slider', { name: m.transport_seek() }))
		.toBeInTheDocument();
	// Nothing paused: Transport play is the page's own A/B start (level-matched by createAB).
	await transport.getByRole('button', { name: m.transport_play(), exact: true }).click();
	await expect.poll(() => audio.start.mock.calls.length).toBe(1);
	expect(audio.createAB).toHaveBeenCalledOnce();
	expect(audio.start).toHaveBeenCalledWith('chains', {
		startAt: 'random',
		session: 'shared-curve'
	});
	await transport.getByRole('button', { name: m.transport_pause(), exact: true }).click();
	expect(audio.pause).toHaveBeenCalledOnce();
	expect(audio.stop).not.toHaveBeenCalled();
	expect(audio.state()).toMatchObject({ paused: true, session: 'shared-curve' });
	await transport.getByRole('button', { name: m.transport_resume(), exact: true }).click();
	await expect.poll(() => audio.resume.mock.calls.length).toBe(1);
	expect(audio.start).toHaveBeenCalledOnce();
});

test('another session taking the engine ends the comparison: "Parar" goes and the A/B is disposed', async () => {
	const { app, audio } = fakeApp();
	await render(SharedCurve, { curve: data(), meta: META, signedIn: false, app });
	await page.getByRole('button', { name: m.shared_curve_listen() }).click();
	await expect
		.element(page.getByRole('button', { name: m.shared_curve_stop() }))
		.toHaveAttribute('aria-pressed', 'true');
	const chains = audio.createAB.mock.results[0]?.value;
	if (!chains) throw new Error('Missing A/B preview');

	// A pause from the Transport or the navbar keeps the comparison (same session).
	audio.pause();
	await expect.element(page.getByRole('button', { name: m.shared_curve_stop() })).toBeVisible();
	expect(chains.dispose).not.toHaveBeenCalled();

	// Another page starts its own session: no longer this page's to show or to stop.
	await audio.start('raw', { session: 'audio-panel' });
	await expect
		.element(page.getByRole('button', { name: m.shared_curve_stop() }))
		.not.toBeInTheDocument();
	await expect
		.element(page.getByRole('button', { name: m.shared_curve_listen() }))
		.toHaveAttribute('aria-pressed', 'false');
	expect(chains.dispose).toHaveBeenCalledOnce();
	// The other session keeps playing: this page never stops what it did not start.
	expect(audio.stop).not.toHaveBeenCalled();
	expect(audio.state()).toMatchObject({ playing: true, session: 'audio-panel' });

	// Released for good: later engine changes do not touch this page again.
	audio.stop();
	expect(chains.dispose).toHaveBeenCalledOnce();
});

test('a stop from elsewhere (navbar) also releases the comparison and its chains', async () => {
	const { app, audio } = fakeApp();
	await render(SharedCurve, { curve: data(), meta: META, signedIn: false, app });
	await page.getByRole('button', { name: m.shared_curve_listen() }).click();
	await expect.element(page.getByRole('button', { name: m.shared_curve_stop() })).toBeVisible();
	const chains = audio.createAB.mock.results[0]?.value;
	if (!chains) throw new Error('Missing A/B preview');
	audio.stop();
	await expect
		.element(page.getByRole('button', { name: m.shared_curve_stop() }))
		.not.toBeInTheDocument();
	expect(chains.dispose).toHaveBeenCalledOnce();
	expect(audio.stop).toHaveBeenCalledOnce();
});

test('an S1 that does not decode shows an error and keeps the page', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	await render(SharedCurve, { curve: data({ s1: 'not-an-s1' }), meta: META, signedIn: false });
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.shared_curve_invalid());
});
