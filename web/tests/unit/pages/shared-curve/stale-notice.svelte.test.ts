// The audio-error notice of a failed playback attempt goes when a new attempt begins and stays
// gone once a retry (the page's "Ouvir" or the Transport's play) succeeds; a late failure of an
// earlier attempt never ends or flags the attempt that replaced it.
import { tick } from 'svelte';
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

const DATA: SharedCurveData = {
	lineageId: 'lin-abcdef123456',
	versionId: 'ver-abcdef123456',
	isHead: true,
	name: 'Warm vocal',
	description: 'A gentle lift around 3 kHz.',
	license: 'CC-BY-4.0',
	lang: 'en-US',
	author: { username: 'geoff', displayUsername: 'Geoff' },
	s1: encodeS1(neutralCurve()),
	visibility: 'public',
	shareId: 'share-abcdef1234'
};

const META: SharedCurveMeta = {
	canonical: 'https://example.test/c/lin-abcdef123456',
	image: 'https://example.test/og/ver-abcdef123456.png',
	indexable: true
};

/** Same stateful fake engine as shared-curve.svelte.test.ts. */
function fakeApp() {
	let current: AudioEngineState = { ...IDLE_STATE };
	const listeners = new Set<(state: AudioEngineState) => void>();
	const set = (next: Partial<AudioEngineState>) => {
		current = { ...current, ...next };
		for (const listener of listeners) listener(current);
	};
	const audio = {
		set,
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
		getContext: () => ({ state: 'running', resume: async () => undefined }),
		state: () => current,
		onChange: (listener: (state: AudioEngineState) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
	const requestWrite = vi.fn();
	const app = { requestWrite, state: { curve: { current: neutralCurve() } }, audio };
	return { app: app as unknown as ClientApp, audio, requestWrite };
}

const noticeText = () => page.getByRole('status').element().textContent?.trim();

test.each(['listen', 'transport'] as const)(
	'a successful retry (%s) clears the earlier audio error during playback',
	async (retry) => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { app, audio } = fakeApp();
		audio.start.mockRejectedValueOnce(new Error('audio denied'));
		await render(SharedCurve, { curve: DATA, meta: META, signedIn: false, app });
		await page.getByRole('button', { name: m.shared_curve_listen() }).click();
		await expect.element(page.getByRole('status')).toHaveTextContent(m.shared_curve_audio_error());

		const transport = page.getByRole('group', { name: m.transport_group() });
		const again =
			retry === 'listen'
				? page.getByRole('button', { name: m.shared_curve_listen() })
				: transport.getByRole('button', { name: m.transport_play(), exact: true });
		await again.click();

		await expect.poll(() => audio.start.mock.calls.length).toBe(2);
		await expect.element(page.getByRole('button', { name: m.shared_curve_stop() })).toBeVisible();
		expect(audio.state()).toMatchObject({ playing: true, session: 'shared-curve' });
		await expect.poll(noticeText).toBe('');
	}
);

test('a new attempt clears the earlier audio error while it is still starting', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	const { app, audio } = fakeApp();
	audio.start.mockRejectedValueOnce(new Error('audio denied'));
	let finish: (() => void) | undefined;
	audio.start.mockImplementationOnce(async () => {
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		audio.set({ mode: 'chains', playing: true, paused: false, session: 'shared-curve' });
	});
	await render(SharedCurve, { curve: DATA, meta: META, signedIn: false, app });
	const listen = page.getByRole('button', { name: m.shared_curve_listen() });
	await listen.click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.shared_curve_audio_error());

	await listen.click();
	await expect.poll(() => finish).toBeDefined();
	await expect.element(listen).toHaveAttribute('aria-busy', 'true');
	await expect.poll(noticeText).toBe('');

	finish?.();
	await expect.element(page.getByRole('button', { name: m.shared_curve_stop() })).toBeVisible();
	await expect.poll(noticeText).toBe('');
});

test('a late failure of an earlier attempt neither stops nor flags the attempt that replaced it', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	const { app, audio, requestWrite } = fakeApp();
	let fail: ((cause: unknown) => void) | undefined;
	audio.start.mockImplementationOnce(
		() =>
			new Promise<void>((_resolve, reject) => {
				fail = reject;
			})
	);
	await render(SharedCurve, { curve: DATA, meta: META, signedIn: false, app });
	const listen = page.getByRole('button', { name: m.shared_curve_listen() });
	await listen.click();
	await expect.poll(() => fail).toBeDefined();

	// "Instalar" ends the pending attempt; a new one then starts and plays.
	await page.getByRole('button', { name: m.shared_curve_install() }).click();
	expect(requestWrite).toHaveBeenCalledOnce();
	await expect.element(listen).not.toHaveAttribute('aria-busy', 'true');
	await listen.click();
	const stop = page.getByRole('button', { name: m.shared_curve_stop() });
	await expect.element(stop).toHaveAttribute('aria-pressed', 'true');
	expect(audio.start).toHaveBeenCalledTimes(2);

	// The first attempt's start fails only now.
	fail?.(new Error('late failure'));
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
	await expect.element(stop).toHaveAttribute('aria-pressed', 'true');
	expect(noticeText()).toBe('');
	expect(audio.stop).not.toHaveBeenCalled();
	expect(audio.createAB.mock.results[1]?.value.dispose).not.toHaveBeenCalled();
	expect(audio.state()).toMatchObject({ playing: true, session: 'shared-curve' });
});

test('a favorite confirmation is not cleared by a later playback start', async () => {
	const { app } = fakeApp();
	const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
	await render(SharedCurve, { curve: DATA, meta: META, signedIn: true, app, fetcher });
	await page.getByRole('button', { name: m.shared_curve_favorite() }).click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.shared_curve_favorited());
	await page.getByRole('button', { name: m.shared_curve_listen() }).click();
	await expect.element(page.getByRole('button', { name: m.shared_curve_stop() })).toBeVisible();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.shared_curve_favorited());
});
