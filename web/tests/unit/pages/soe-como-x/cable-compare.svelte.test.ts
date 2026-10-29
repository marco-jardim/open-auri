import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { snapshotBands } from 'open-auri/dsp';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { createAudioEngine, type ABPreview, type AudioEngine } from '#lib/audio/engine.ts';
import { createGestureToken } from '#lib/cable/gesture.ts';
import { CABLE_LIVE_KEY } from '#lib/cable/service.ts';
import { initialTracks } from '#lib/components/pages/comparar/comparison.ts';
import Preview from '#lib/components/pages/soe-como-x/Preview.svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { fakeAppOptions } from '../../app/fakes.ts';

const [first, second, third] = initialTracks().map((track) => track.curve);
let apps: ClientApp[] = [];
let engine: AudioEngine | null = null;

beforeEach(async () => {
	localStorage.removeItem(CABLE_LIVE_KEY);
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	await engine?.dispose();
	engine = null;
	for (const app of apps) app.dispose();
	apps = [];
	vi.restoreAllMocks();
	localStorage.removeItem(CABLE_LIVE_KEY);
});

function curves() {
	if (!first || !second || !third) throw new Error('expected three curves');
	return { current: first, candidate: second, other: third };
}

/** A real app with a connected FakeHID cable (gestures minted as trusted clicks). */
async function connectedApp() {
	const fake = fakeAppOptions();
	const app = createClientApp(fake.options);
	apps.push(app);
	await app.start();
	expect(await app.cable.connect()).not.toBeNull();
	vi.spyOn(app.cable, 'createGesture').mockImplementation(() =>
		createGestureToken(
			{ isTrusted: true, type: 'click' },
			{ now: () => fake.time.value, userActivation: null }
		)
	);
	return app;
}

function realEngine() {
	engine = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
	return engine;
}

async function startComparison(app: ClientApp) {
	await page.getByRole('button', { name: m.cable_x2_start(), exact: true }).click();
	const group = page.getByRole('group', { name: m.cable_x2_checklist_title() });
	await group.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	await group.getByRole('button', { name: m.cable_live_start() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.comparison?.status).toBe('ready'));
}

async function listening(audio: AudioEngine) {
	await page.getByRole('button', { name: m.soe_listen(), exact: true }).click();
	await expect.poll(() => audio.state().playing).toBe(true);
	await expect.element(page.getByRole('meter', { name: 'B / VU', exact: true })).toBeVisible();
}

function created(spy: { mock: { results: { type: string; value: unknown }[] } }, index: number) {
	const result = spy.mock.results.at(index);
	if (!result || result.type !== 'return') throw new Error('missing preview');
	return result.value as ABPreview;
}

test('(a) with an app and a connected cable: the sum notice and "Comparar no cabo"', async () => {
	const app = await connectedApp();
	const { current, candidate } = curves();
	await render(Preview, { app, audio: realEngine(), current, candidate });
	await expect
		.poll(() => document.querySelector('.preview [role="note"]')?.textContent)
		.toContain(m.cable_sum_note());
	await expect
		.element(page.getByRole('button', { name: m.cable_x2_start(), exact: true }))
		.toBeVisible();
	expect(document.querySelector('[data-cable-ab]')).not.toBeNull();
});

test('(b) the cable comparison makes the browser flat, rebuilt in place with its taps', async () => {
	const app = await connectedApp();
	const audio = realEngine();
	const createAB = vi.spyOn(audio, 'createAB');
	const { current, candidate } = curves();
	await render(Preview, { app, audio, current, candidate });
	await listening(audio);
	expect(createAB).toHaveBeenCalledOnce();
	const [editorSent, resultSent] = createAB.mock.calls[0] ?? [];
	expect(editorSent?.bands).toEqual(current.bands);
	expect(resultSent?.bands).toEqual(candidate.bands);
	const old = created(createAB, 0);
	const start = vi.spyOn(audio, 'start');
	const stop = vi.spyOn(audio, 'stop');
	const connect = vi.spyOn(AudioNode.prototype, 'connect');

	await startComparison(app);
	await expect.poll(() => createAB.mock.calls.length).toBe(2);
	const neutral = snapshotBands(NEUTRO.bands);
	const [editorFlat, resultFlat, options] = createAB.mock.calls[1] ?? [];
	expect(editorFlat).toMatchObject({ bands: neutral, preampDb: NEUTRO.preampDb });
	expect(resultFlat).toMatchObject({ bands: neutral, preampDb: NEUTRO.preampDb });
	// The browser side stays B (the comparison's first side follows it).
	expect(options).toMatchObject({ initial: 'B' });
	expect(app.cableState.live?.comparison?.index).toBe(1);
	const rebuilt = created(createAB, 1);
	// The old chains went, the new ones play: the session never stopped.
	expect(audio.getChainOutput(old.a.id)).toBeNull();
	expect(audio.getChainOutput(old.b.id)).toBeNull();
	const aNode = audio.getChainOutput(rebuilt.a.id);
	const bNode = audio.getChainOutput(rebuilt.b.id);
	expect(aNode).not.toBeNull();
	expect(bNode).not.toBeNull();
	expect(stop).not.toHaveBeenCalled();
	expect(start).not.toHaveBeenCalled();
	expect(audio.state()).toMatchObject({ playing: true, mode: 'chains', session: 'soe-como-x' });
	// The meter taps follow the new chains (a worklet on each new output).
	const tapped = (node: AudioNode | null) =>
		connect.mock.calls.some(
			(call, index) => connect.mock.contexts[index] === node && call[0] instanceof AudioWorkletNode
		);
	await expect.poll(() => tapped(aNode) && tapped(bNode)).toBe(true);
	await expect.element(page.getByRole('meter', { name: 'B / VU', exact: true })).toBeVisible();
	await expect
		.element(page.getByRole('button', { name: m.soe_stop_preview(), exact: true }))
		.toBeVisible();
	// The browser's A also switches the cable.
	await page.getByRole('button', { name: m.soe_current(), exact: true }).click();
	await vi.waitFor(() => {
		expect(app.cableState.live?.comparison?.index).toBe(0);
		expect(app.cableState.live?.comparison?.status).toBe('ready');
	});
	expect(createAB).toHaveBeenCalledTimes(2);
	expect(stop).not.toHaveBeenCalled();
}, 30000);

test('(c) the level line is hidden while the browser plays flat', async () => {
	const app = await connectedApp();
	const audio = realEngine();
	const createAB = vi.spyOn(audio, 'createAB');
	const { current, candidate } = curves();
	const screen = await render(Preview, { app, audio, current, candidate });
	await listening(audio);
	await expect.poll(() => screen.container.querySelector('.level')).not.toBeNull();
	await startComparison(app);
	await expect.poll(() => createAB.mock.calls.length).toBe(2);
	await expect.poll(() => screen.container.querySelector('.level')).toBeNull();
	// The trims still exist (the flat chains are level-matched too); only their line hides.
	await expect
		.element(page.getByRole('button', { name: m.soe_stop_preview(), exact: true }))
		.toBeVisible();
}, 30000);

test('(d) a new result ends the cable comparison, saying the lanes changed', async () => {
	const app = await connectedApp();
	const { current, candidate, other } = curves();
	const screen = await render(Preview, { app, audio: realEngine(), current, candidate });
	await startComparison(app);
	await screen.rerender({ candidate: other });
	await expect
		.poll(() => document.querySelector('[data-cable-ab-ended]')?.textContent?.trim())
		.toBe(m.cable_x2_lanes_changed());
	expect(app.cableState.live?.comparison?.active).not.toBe(true);
}, 30000);

test('(d2) the cable lever moves the browser A/B, without switching the cable back', async () => {
	const app = await connectedApp();
	const audio = realEngine();
	const createAB = vi.spyOn(audio, 'createAB');
	const { current, candidate } = curves();
	await render(Preview, { app, audio, current, candidate });
	await listening(audio);
	await startComparison(app);
	await expect.poll(() => createAB.mock.calls.length).toBe(2);
	expect(app.cableState.live?.comparison?.index).toBe(1);
	const rebuilt = created(createAB, 1);
	const select = vi.spyOn(rebuilt, 'select');
	const switchComparison = vi.spyOn(app.cable, 'switchComparison');
	const browserA = page.getByRole('button', { name: m.soe_current(), exact: true });
	await expect.element(browserA).toHaveAttribute('aria-pressed', 'false');
	await page
		.getByRole('radio', { name: m.cable_x2_side({ side: 'A', name: current.name }) })
		.click();
	await vi.waitFor(() => {
		expect(app.cableState.live?.comparison?.index).toBe(0);
		expect(app.cableState.live?.comparison?.status).toBe('ready');
	});
	// The browser follows the cable: A selected on the same chains, no rebuild, no loop.
	await expect.element(browserA).toHaveAttribute('aria-pressed', 'true');
	expect(select).toHaveBeenCalledExactlyOnceWith('A');
	expect(switchComparison).toHaveBeenCalledExactlyOnceWith(0);
	expect(createAB).toHaveBeenCalledTimes(2);
}, 30000);

test('(e) without an app there is no cable UI', async () => {
	const { current, candidate } = curves();
	const screen = await render(Preview, { audio: realEngine(), current, candidate });
	await expect.element(page.getByRole('button', { name: m.soe_listen() })).toBeVisible();
	expect(screen.container.querySelector('[data-cable-ab]')).toBeNull();
	expect(screen.container.querySelector('[role="note"]')).toBeNull();
	expect(screen.container.querySelector('[data-live-orphan]')).toBeNull();
});
