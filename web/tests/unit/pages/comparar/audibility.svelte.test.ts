import { tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import CompararPage from '#lib/components/pages/comparar/CompararPage.svelte';
import { copy } from '#lib/components/pages/comparar/copy.ts';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import { createAudioEngine, type AudioEngine, type PreviewChain } from '#lib/audio/engine.ts';
import type { MeterUpdate } from '#lib/audio/meters.ts';
import { setLocale } from '#lib/paraglide/runtime.js';
import { m } from '#lib/paraglide/messages.js';
import { FakeGainNode, asFake, fakeEnv, resetAudioConfig } from '../../audio/fake-audio.ts';

const { fakeTap } = vi.hoisted(() => ({ fakeTap: vi.fn() }));
vi.mock('#lib/audio/meters.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/audio/meters.ts')>()),
	tap: fakeTap
}));
vi.mock('#lib/workers/gate-client.ts', () => ({
	createGateWorker: () => ({ commit: vi.fn(), dispose: vi.fn(), cancel: vi.fn() })
}));

const t = copy('en-US');
let app: ClientApp | null = null;

function meter() {
	return {
		disconnect: vi.fn(),
		setReference: vi.fn(),
		subscribe: vi.fn((listener: (update: MeterUpdate) => void) => {
			listener({ mode: 'data', frame: null });
			return () => undefined;
		})
	};
}

beforeEach(async () => {
	resetAudioConfig();
	fakeTap.mockReset();
	fakeTap.mockImplementation(async () => meter());
	await setLocale('en-US', { reload: false });
});

afterEach(async () => {
	await cleanup();
	app?.dispose();
	await app?.audio.dispose();
	app = null;
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

/** A client app on a fake Web Audio graph (gains are inspectable, start needs no real device). */
async function setup(): Promise<{ client: ClientApp; engine: AudioEngine }> {
	const engine = createAudioEngine(fakeEnv(null).env);
	const client = createClientApp({
		storage: { local: null, session: null, indexedDB: null, channel: null },
		audio: engine
	});
	app = client;
	await client.state.ready;
	return { client, engine };
}

function built(build: { mock: { results: { type: string; value: unknown }[] } }): PreviewChain[] {
	return build.mock.results
		.filter((result) => result.type === 'return')
		.map((result) => result.value as PreviewChain);
}

const audibleCount = (chains: PreviewChain[]) =>
	chains.filter((chain) => asFake(chain.output, FakeGainNode).gain.value > 0).length;

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

test('chain mode left on by another page builds no chain here and plays nothing until Play', async () => {
	const { client, engine } = await setup();
	// Another page left the shared engine playing in chain mode.
	await engine.start('chains');
	const build = vi.spyOn(engine, 'buildChain');
	await render(CompararPage, { app: client, locale: 'en-US' });
	await tick();
	await settle();
	expect(build).not.toHaveBeenCalled();
	expect(fakeTap).not.toHaveBeenCalled();
	// The transport reflects this page's own audition, not the foreign playback.
	await expect.element(page.getByRole('button', { name: t.play, exact: true })).toBeVisible();

	await page.getByRole('button', { name: t.play, exact: true }).click();
	await expect.poll(() => build.mock.calls.length).toBeGreaterThan(0);
	await expect.poll(() => audibleCount(built(build))).toBe(1);
	expect(engine.state().mode).toBe('chains');
	await expect.element(page.getByRole('button', { name: t.stop, exact: true })).toBeVisible();
});

test('the page own Stop pauses: lanes, A/B and position stay, and Play continues them', async () => {
	const { client, engine } = await setup();
	const build = vi.spyOn(engine, 'buildChain');
	const start = vi.spyOn(engine, 'start');
	const stop = vi.spyOn(engine, 'stop');
	const resume = vi.spyOn(engine, 'resume');
	await render(CompararPage, { app: client, locale: 'en-US' });
	await page.getByRole('button', { name: t.play, exact: true }).click();
	await expect.poll(() => audibleCount(built(build))).toBe(1);
	// A comparison starts at a random point of the file (SEEK.2), tagged with the page session.
	expect(start).toHaveBeenCalledExactlyOnceWith('chains', {
		startAt: 'random',
		session: 'comparar'
	});
	await page.getByRole('button', { name: t.stop, exact: true }).click();
	expect(engine.state()).toMatchObject({ playing: false, paused: true, session: 'comparar' });
	expect(stop).not.toHaveBeenCalled();
	// The engine's master fade silences the pause; the lane selection is kept for the resume.
	expect(audibleCount(built(build))).toBe(1);
	const chains = build.mock.calls.length;
	await page.getByRole('button', { name: t.play, exact: true }).click();
	await expect.poll(() => engine.state().playing).toBe(true);
	expect(resume).toHaveBeenCalledOnce();
	expect(start).toHaveBeenCalledOnce();
	expect(build.mock.calls.length).toBe(chains);
});

test('the Transport renders and pauses or continues this page session', async () => {
	const { client, engine } = await setup();
	const pause = vi.spyOn(engine, 'pause');
	const stop = vi.spyOn(engine, 'stop');
	await render(CompararPage, { app: client, locale: 'en-US' });
	const transport = page.getByRole('group', { name: m.transport_group() });
	await expect.element(transport).toBeVisible();
	await expect
		.element(transport.getByRole('slider', { name: m.transport_seek() }))
		.toBeInTheDocument();
	// Nothing paused: Transport play is the Play key's own start.
	await transport.getByRole('button', { name: m.transport_play(), exact: true }).click();
	await expect.poll(() => engine.state().session).toBe('comparar');
	await expect.element(page.getByRole('button', { name: t.stop, exact: true })).toBeVisible();
	await transport.getByRole('button', { name: m.transport_pause(), exact: true }).click();
	expect(pause).toHaveBeenCalledOnce();
	expect(stop).not.toHaveBeenCalled();
	expect(engine.state()).toMatchObject({ paused: true, session: 'comparar' });
	await transport.getByRole('button', { name: m.transport_resume(), exact: true }).click();
	await expect.poll(() => engine.state().playing).toBe(true);
	await cleanup();
	expect(stop).toHaveBeenCalledOnce();
	expect(engine.state()).toMatchObject({ playing: false, paused: false, session: null });
});

test('unmount stops the engine when this page started it', async () => {
	const { client, engine } = await setup();
	const stop = vi.spyOn(engine, 'stop');
	await render(CompararPage, { app: client, locale: 'en-US' });
	await page.getByRole('button', { name: t.play, exact: true }).click();
	await expect.poll(() => engine.state().mode).toBe('chains');
	await cleanup();
	expect(stop).toHaveBeenCalled();
	expect(engine.state().playing).toBe(false);
});

test('unmount does not stop playback that another page started', async () => {
	const { client, engine } = await setup();
	await engine.start('raw');
	const stop = vi.spyOn(engine, 'stop');
	await render(CompararPage, { app: client, locale: 'en-US' });
	await cleanup();
	expect(stop).not.toHaveBeenCalled();
	expect(engine.state().mode).toBe('raw');
});

test('unmount during the engine start leaves nothing playing', async () => {
	const { client, engine } = await setup();
	const realStart = engine.start.bind(engine);
	let resume: (() => void) | undefined;
	vi.spyOn(engine, 'start').mockImplementationOnce(async (mode, options) => {
		await new Promise<void>((resolve) => (resume = resolve));
		// The session tag is what tells the late start apart from another page's audio.
		await realStart(mode, options);
	});
	await render(CompararPage, { app: client, locale: 'en-US' });
	await page.getByRole('button', { name: t.play, exact: true }).click();
	await expect.poll(() => resume).toBeDefined();
	await cleanup();
	resume?.();
	await expect.poll(() => engine.state().mode).toBe('off');
	expect(engine.state().playing).toBe(false);
});

test('lane taps receive the app 0 VU reference', async () => {
	const { client } = await setup();
	client.state.meterRef.set(-20);
	await render(CompararPage, { app: client, locale: 'en-US' });
	await page.getByRole('button', { name: t.play, exact: true }).click();
	await expect.poll(() => fakeTap.mock.calls.length).toBeGreaterThan(0);
	for (const [, options] of fakeTap.mock.calls) {
		expect(options).toEqual({ kinds: ['vu'], reference: -20 });
	}
});
