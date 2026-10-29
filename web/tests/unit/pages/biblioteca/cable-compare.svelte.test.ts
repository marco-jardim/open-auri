/**
 * "Comparar no cabo" on the Biblioteca track sheet (issue #89): the editor's curve (A) against
 * the selected tape (B) on the live cable preview, with the sheet's browser A/B playing flat
 * while the cable applies the EQ. A real client app with a FakeHID cable (auto-advancing fake
 * clock) and a fake Web Audio graph: what reaches the cable is read from the fake firmware, what
 * the browser plays from the A/B previews the sheet builds.
 */
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { snapshotBands } from 'open-auri/dsp';
import { gateForWrite } from 'open-auri/safety';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import {
	createAudioEngine,
	IDLE_STATE,
	type AudioEngine,
	type AudioEngineState
} from '#lib/audio/engine.ts';
import type { MeterUpdate } from '#lib/audio/meters.ts';
import { createGestureToken } from '#lib/cable/gesture.ts';
import { CABLE_LIVE_KEY } from '#lib/cable/service.ts';
import { planComparison } from '#lib/cable/compare.ts';
import type { Band } from '#lib/cable/types.ts';
import TrackSheet from '#lib/components/pages/biblioteca/TrackSheet.svelte';
import { archiveTapes, type Tape } from '#lib/components/pages/biblioteca/archive.ts';
import { initialTracks } from '#lib/components/pages/comparar/comparison.ts';
import { neutralCurve } from '#lib/state/model.ts';
import { createYoloState } from '#lib/state/yolo.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { fakeAppOptions } from '../../app/fakes.ts';
import { fakeEnv, resetAudioConfig } from '../../audio/fake-audio.ts';

const { fakeTap } = vi.hoisted(() => ({ fakeTap: vi.fn() }));
vi.mock('#lib/audio/meters.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/audio/meters.ts')>()),
	tap: fakeTap
}));

const OFF_BANDS: Band[] = Array.from({ length: 10 }, (): Band => ({ kind: 'OFF' }));
const FLAT = snapshotBands(NEUTRO.bands);
/** The editor's curve (A): Neutro, as the Comparar page's first lane. */
const current = neutralCurve();
/** The tape (B): the Comparar page's second default lane (a known-good level-matched pair). */
const tape: Tape = (() => {
	const source = initialTracks()[1]?.curve.source;
	const found = archiveTapes([]).find((item) => item.source === source);
	if (!found) throw new Error('expected the second default lane in the archive');
	return found;
})();

let apps: ClientApp[] = [];
let engines: AudioEngine[] = [];
let unsubscribers: (() => void)[] = [];

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
	localStorage.removeItem(CABLE_LIVE_KEY);
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	for (const unsubscribe of unsubscribers) unsubscribe();
	await cleanup();
	for (const app of apps) app.dispose();
	for (const engine of engines) await engine.dispose();
	apps = [];
	engines = [];
	unsubscribers = [];
	vi.restoreAllMocks();
	localStorage.removeItem(CABLE_LIVE_KEY);
});

interface SetupOptions {
	/** The cable's saved curve (journal): all filters off at this preamp. */
	savedPreampDb?: number;
}

async function setup(options: SetupOptions = {}) {
	const fake = fakeAppOptions();
	const engine = createAudioEngine(fakeEnv(null).env);
	engines.push(engine);
	const app = createClientApp({ ...fake.options, audio: engine });
	apps.push(app);
	await app.start();
	expect(await app.cable.connect()).not.toBeNull();
	if (options.savedPreampDb !== undefined) {
		const device = app.cable.getState().deviceLabel;
		expect(device).not.toBeNull();
		const crc = gateForWrite(OFF_BANDS, options.savedPreampDb, { experimental: false }).metrics
			.payloadCrc;
		expect(
			app.state.journal.append({
				schema: 1,
				at: fake.time.value,
				name: 'Salva',
				crc: Number(crc),
				preampDb: options.savedPreampDb,
				bands: OFF_BANDS,
				status: 'ok',
				device
			})
		).toBe(true);
	}
	// Component clicks are synthetic here: mint real single-use tokens for each gesture.
	vi.spyOn(app.cable, 'createGesture').mockImplementation(() =>
		createGestureToken(
			{ isTrusted: true, type: 'click' },
			{ now: () => fake.time.value, userActivation: null }
		)
	);
	const createAB = vi.spyOn(engine, 'createAB');
	const start = vi.spyOn(engine, 'start');
	const stop = vi.spyOn(engine, 'stop');
	const props = {
		tape,
		current,
		origin: 'https://example.test',
		locale: 'pt-BR' as const,
		app,
		verdict: gateForWrite(tape.bands, tape.preampDb),
		audioState: engine.state(),
		onClose: vi.fn(),
		onStatus: vi.fn()
	};
	const screen = await render(TrackSheet, props);
	unsubscribers.push(
		engine.onChange((state) => {
			void screen.rerender({ audioState: state });
		})
	);
	await tick();
	return { app, fake, engine, props, createAB, start, stop };
}

/** CRC-16 the fake firmware plays from RAM (bytes 218..219 of the live payload). */
function playingCrc(fake: ReturnType<typeof fakeAppOptions>): number | null {
	const payload = fake.device.firmware.live;
	if (payload === null) return null;
	return (payload[218] ?? 0) | ((payload[219] ?? 0) << 8);
}

const listenButton = (side: 'A' | 'B') =>
	page.getByRole('button', {
		name: side === 'A' ? m.biblioteca_listen_current() : m.biblioteca_listen_tape(),
		exact: true
	});

/** The sheet's own browser audition of `side`, until the engine plays it. */
async function listen(engine: AudioEngine, side: 'A' | 'B') {
	await listenButton(side).click();
	await expect
		.poll(() => engine.state())
		.toMatchObject({ playing: true, mode: 'chains', session: 'biblioteca' });
	await expect.element(listenButton(side)).toHaveAttribute('aria-pressed', 'true');
}

async function startComparison(app: ClientApp) {
	await page.getByRole('button', { name: m.cable_x2_start(), exact: true }).click();
	const group = page.getByRole('group', { name: m.cable_x2_checklist_title() });
	await expect.element(group).toBeVisible();
	await group.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	await group.getByRole('button', { name: m.cable_live_start() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.comparison?.status).toBe('ready'));
}

const plan = () => planComparison([current, tape], { match: true });

test('(a) starting the cable comparison rebuilds the browser A/B flat, without stopping the engine', async () => {
	const { app, engine, createAB, start, stop } = await setup();
	expect(JSON.stringify(tape.bands)).not.toBe(JSON.stringify(FLAT));
	await listen(engine, 'B');
	expect(createAB).toHaveBeenCalledOnce();
	expect(createAB.mock.calls[0]?.[1].bands).toEqual(tape.bands);
	const first = createAB.mock.results[0];
	if (first?.type !== 'return') throw new Error('expected the first preview');
	await expect.poll(() => fakeTap.mock.calls.at(-1)?.[0]).toBe(first.value.b.output);

	await startComparison(app);
	// The cable applies the EQ now: both browser sides play the flat Neutro curve.
	await expect.poll(() => createAB.mock.calls.length).toBe(2);
	const [heardA, heardB, options] = createAB.mock.calls[1] ?? [];
	expect(heardA?.bands).toEqual(FLAT);
	expect(heardA?.preampDb).toBe(NEUTRO.preampDb);
	expect(heardB?.bands).toEqual(FLAT);
	expect(heardB?.preampDb).toBe(NEUTRO.preampDb);
	expect(options).toMatchObject({ experimental: true, initial: 'B' });
	// The same engine session: never stopped, never restarted.
	expect(stop).not.toHaveBeenCalled();
	expect(start).toHaveBeenCalledOnce();
	expect(engine.state()).toMatchObject({ playing: true, session: 'biblioteca' });
	// The old chains are gone; the Preamp tap follows the new selected chain.
	expect(engine.getChainOutput(first.value.a.id)).toBeNull();
	expect(engine.getChainOutput(first.value.b.id)).toBeNull();
	const next = createAB.mock.results[1];
	if (next?.type !== 'return') throw new Error('expected the flat preview');
	await expect.poll(() => fakeTap.mock.calls.at(-1)?.[0]).toBe(next.value.b.output);
	await expect.element(page.getByText(m.cable_x2_browser_flat())).toBeVisible();
	// Both sides flat: the level match note is hidden.
	expect(page.getByText(m.biblioteca_listen_note()).all()).toHaveLength(0);
});

test('(b) "A · curva atual" mirrors to the cable candidate 0', async () => {
	const { app, fake, engine, createAB } = await setup();
	const [itemA, itemB] = plan().items;
	await listen(engine, 'B');
	await startComparison(app);
	// The sheet's side (B) is the cable's first candidate.
	expect(app.cableState.live?.comparison?.index).toBe(1);
	expect(playingCrc(fake)).toBe(itemB?.crc);

	await listenButton('A').click();
	await vi.waitFor(() =>
		expect(app.cableState.live?.comparison).toMatchObject({ index: 0, status: 'ready' })
	);
	expect(playingCrc(fake)).toBe(itemA?.crc);
	const latest = createAB.mock.results.at(-1);
	if (latest?.type !== 'return') throw new Error('expected a preview');
	expect(latest.value.selected()).toBe('A');
	expect(fake.device.firmware.commitCount).toBe(0);
});

test('(c) ending the comparison back on the saved curve plays the EQ again', async () => {
	const { app, engine, createAB, stop } = await setup({ savedPreampDb: -12 });
	await listen(engine, 'B');
	await startComparison(app);
	await expect.poll(() => createAB.mock.calls.at(-1)?.[1].bands).toEqual(FLAT);

	await page.getByRole('button', { name: m.cable_x2_end(), exact: true }).click();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('reverted'));
	await expect.poll(() => createAB.mock.calls.at(-1)?.[1].bands).toEqual(tape.bands);
	expect(createAB.mock.calls.at(-1)?.[0].bands).toEqual(current.bands);
	expect(createAB.mock.calls.at(-1)?.[2]).toMatchObject({ initial: 'B' });
	expect(stop).not.toHaveBeenCalled();
	expect(engine.state()).toMatchObject({ playing: true, session: 'biblioteca' });
	await expect.element(page.getByText(m.biblioteca_listen_note())).toBeVisible();
});

test('(d) closing the sheet ends the comparison as stopped, without reverting or committing', async () => {
	const { app, fake, engine, props, stop } = await setup();
	const [, itemB] = plan().items;
	await listen(engine, 'B');
	await startComparison(app);
	await page.getByRole('button', { name: m.biblioteca_close(), exact: true }).click();
	expect(props.onClose).toHaveBeenCalledOnce();
	// The sheet's browser audition ends with it.
	expect(stop).toHaveBeenCalledOnce();
	// The parent drops the sheet.
	await cleanup();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
	// The cable keeps the candidate it played; nothing was written to flash.
	expect(playingCrc(fake)).toBe(itemB?.crc);
	expect(fake.device.firmware.commitCount).toBe(0);
});

test('(e) "Salvar esta" requests the write of the original curve and closes the sheet', async () => {
	const { app, props } = await setup();
	const item = plan().items[1];
	if (item === undefined) throw new Error('expected the tape candidate');
	const requestWrite = vi.spyOn(app, 'requestWrite');
	// No audition: the sheet's side is B, the cable's first candidate.
	await startComparison(app);
	expect(app.cableState.live?.comparison?.index).toBe(1);
	await page.getByRole('button', { name: m.cable_x2_save() }).click();
	expect(requestWrite).toHaveBeenCalledOnce();
	expect(requestWrite.mock.calls[0]?.[0]).toMatchObject({
		schema: 1,
		name: tape.name,
		source: tape.source,
		bands: item.original.bands,
		preampDb: item.original.preampDb
	});
	expect(props.onClose).toHaveBeenCalledOnce();
	// The sheet's own note goes with it: the page's status reports the comparison's end.
	expect(props.onStatus).toHaveBeenCalledExactlyOnceWith(m.cable_x2_ended_stopped());
	expect(app.pendingWrite).not.toBeNull();
	expect(() => structuredClone(app.pendingWrite)).not.toThrow();
});

test('(f) the sum notice shows while a cable is connected and nothing is compared', async () => {
	const { app } = await setup();
	expect(app.cableState.connection).toBe('connected');
	expect(app.cableState.live).toBeNull();
	await expect
		.poll(() => document.querySelector('.listen [role="note"]')?.textContent ?? '')
		.toContain(m.cable_sum_note());
	await expect.element(page.getByText(m.biblioteca_listen_note())).toBeVisible();
	await expect
		.element(page.getByRole('button', { name: m.cable_x2_start(), exact: true }))
		.toBeVisible();
});

test('(g) an app without cableState renders the sheet without any cable UI', async () => {
	const listeners = new Set<(state: AudioEngineState) => void>();
	const stub = {
		audio: {
			state: () => ({ ...IDLE_STATE }),
			onChange: (listener: (state: AudioEngineState) => void) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			}
		},
		yolo: createYoloState(),
		state: { meterRef: { value: -18 } }
	};
	await render(TrackSheet, {
		tape,
		current,
		origin: 'https://example.test',
		locale: 'pt-BR',
		app: stub as unknown as ClientApp,
		verdict: gateForWrite(tape.bands, tape.preampDb),
		audioState: { ...IDLE_STATE },
		onClose: vi.fn(),
		onStatus: vi.fn()
	});
	await expect.element(listenButton('A')).toBeVisible();
	await expect.element(page.getByText(m.biblioteca_listen_note())).toBeVisible();
	expect(document.querySelector('[data-cable-ab]')).toBeNull();
	expect(page.getByRole('button', { name: m.cable_x2_start(), exact: true }).all()).toHaveLength(0);
	expect(document.querySelector('.listen [role="note"]')).toBeNull();
});
