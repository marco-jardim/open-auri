import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { gateForWrite } from 'open-auri/safety';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import { createAudioEngine, IDLE_STATE, type AudioEngineState } from '#lib/audio/engine.ts';
import type { MeterFrame, MeterUpdate } from '#lib/audio/meters.ts';
import { neutralCurve } from '#lib/state/model.ts';
import { m } from '#lib/paraglide/messages.js';
import TrackSheet from '#lib/components/pages/biblioteca/TrackSheet.svelte';
import { archiveTapes } from '#lib/components/pages/biblioteca/archive.ts';

const { fakeTap } = vi.hoisted(() => ({ fakeTap: vi.fn() }));
vi.mock('#lib/audio/meters.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/audio/meters.ts')>()),
	tap: fakeTap
}));

interface FakeTap {
	node: AudioNode;
	disconnect: ReturnType<typeof vi.fn>;
	emit(update: MeterUpdate): void;
}

let app: ClientApp | null = null;
let taps: FakeTap[] = [];
afterEach(async () => {
	await cleanup();
	app?.dispose();
	await app?.audio.dispose();
	app = null;
	taps = [];
	fakeTap.mockReset();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const sheetPlaying: AudioEngineState = {
	...IDLE_STATE,
	playing: true,
	mode: 'chains',
	session: 'biblioteca'
};

const frame = (vu: number): MeterFrame => ({
	vuL: vu,
	vuR: vu - 1,
	ppmL: -15,
	ppmR: -16,
	truePeakDb: -14,
	lufsM: -18,
	lufsS: -19,
	correlation: 0.7,
	active: true
});

function makeTap(node: AudioNode) {
	const listeners = new Set<(update: MeterUpdate) => void>();
	const handle = {
		node,
		disconnect: vi.fn(),
		setReference: vi.fn(),
		emit(update: MeterUpdate) {
			for (const listener of listeners) listener(update);
		},
		subscribe(listener: (update: MeterUpdate) => void) {
			listeners.add(listener);
			listener({ mode: 'data', frame: null });
			return () => {
				listeners.delete(listener);
			};
		}
	};
	taps.push(handle);
	return handle;
}

async function setupSheet() {
	fakeTap.mockImplementation(async (node: AudioNode) => makeTap(node));
	app = createClientApp({
		storage: { local: null, session: null, indexedDB: null, channel: null },
		audio: createAudioEngine({ indexedDB: null })
	});
	await app.state.ready;
	const client = app;
	vi.spyOn(client.audio, 'start').mockResolvedValue(undefined);
	vi.spyOn(client.audio, 'state').mockReturnValue({ ...sheetPlaying });
	const createAB = vi.spyOn(client.audio, 'createAB');
	const onOutputMeter = vi.fn<(update: MeterUpdate) => void>();
	const tape = archiveTapes([])[0];
	const screen = await render(TrackSheet, {
		tape,
		current: neutralCurve(),
		origin: 'https://example.test',
		locale: 'pt-BR',
		app: client,
		verdict: gateForWrite(tape.bands, tape.preampDb),
		audioState: { ...sheetPlaying },
		onClose: vi.fn(),
		onStatus: vi.fn(),
		onOutputMeter
	});
	return { screen, client, createAB, onOutputMeter };
}

// Native activation keeps these timer-boundary tests independent of driver polling timers.
async function press(container: HTMLElement, label: string) {
	const button = [...container.querySelectorAll('button')].find(
		(node) => node.textContent?.trim() === label
	);
	if (!button) throw new Error(`Missing sheet button: ${label}`);
	button.click();
	await tick();
	await Promise.resolve();
	await tick();
}

test('the Preamp tap is the selected A/B chain output, only while the sheet audition plays', async () => {
	const { screen, client, createAB, onOutputMeter } = await setupSheet();
	// Nothing of this sheet is audible yet: no tap.
	expect(fakeTap).not.toHaveBeenCalled();

	await page.getByRole('button', { name: m.biblioteca_listen_tape(), exact: true }).click();
	await expect.poll(() => fakeTap.mock.calls.length).toBe(1);
	const created = createAB.mock.results[0];
	if (created?.type !== 'return') throw new Error('Missing sheet preview');
	const preview = created.value;
	expect(fakeTap.mock.calls[0]?.[0]).toBe(preview.b.output);
	expect(fakeTap.mock.calls[0]?.[1]).toMatchObject({ kinds: ['vu'], reference: -18 });
	// Never the shared buses: those feed Nível, Correlator and Pico.
	expect(fakeTap.mock.calls[0]?.[0]).not.toBe(client.audio.getMeterBus());
	expect(fakeTap.mock.calls[0]?.[0]).not.toBe(client.audio.getSourceBus());
	await expect.poll(() => taps.length).toBe(1);
	taps[0].emit({ mode: 'live', frame: frame(-2) });
	expect(onOutputMeter).toHaveBeenLastCalledWith({ mode: 'live', frame: frame(-2) });

	// Switching sides moves the tap to the other chain; the old one is released.
	await page.getByRole('button', { name: m.biblioteca_listen_current(), exact: true }).click();
	await expect.poll(() => fakeTap.mock.calls.length).toBe(2);
	expect(fakeTap.mock.calls[1]?.[0]).toBe(preview.a.output);
	expect(taps[0].disconnect).toHaveBeenCalledOnce();
	await expect.poll(() => taps.length).toBe(2);
	taps[1].emit({ mode: 'live', frame: frame(-5) });
	expect(onOutputMeter).toHaveBeenLastCalledWith({ mode: 'live', frame: frame(-5) });

	// Paused: nothing plays, so the dial returns to DATA until the audition resumes.
	await screen.rerender({ audioState: { ...sheetPlaying, playing: false, paused: true } });
	await expect.poll(() => taps[1].disconnect.mock.calls.length).toBe(1);
	expect(onOutputMeter).toHaveBeenLastCalledWith({ mode: 'data', frame: null });
	await screen.rerender({ audioState: { ...sheetPlaying } });
	await expect.poll(() => fakeTap.mock.calls.length).toBe(3);
	expect(fakeTap.mock.calls[2]?.[0]).toBe(preview.a.output);

	// Another page's session is what is heard now: the sheet chain is not the output.
	await screen.rerender({
		audioState: { ...sheetPlaying, mode: 'raw', session: 'audio-panel' }
	});
	await expect.poll(() => taps.length).toBe(3);
	await expect.poll(() => taps[2].disconnect.mock.calls.length).toBe(1);
	expect(onOutputMeter).toHaveBeenLastCalledWith({ mode: 'data', frame: null });
	await screen.rerender({ audioState: { ...sheetPlaying } });
	await expect.poll(() => taps.length).toBe(4);

	// "Parar prévia" ends the audition and its tap.
	await page.getByRole('button', { name: m.biblioteca_stop(), exact: true }).click();
	await expect.poll(() => taps[3].disconnect.mock.calls.length).toBe(1);
	expect(onOutputMeter).toHaveBeenLastCalledWith({ mode: 'data', frame: null });
	expect(fakeTap).toHaveBeenCalledTimes(4);
});

test('A/B and reference handoffs keep a fresh reading until the first replacement frame or 250 ms', async () => {
	const { screen, client, onOutputMeter } = await setupSheet();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	await press(screen.container, m.biblioteca_listen_tape());
	expect(taps).toHaveLength(1);
	// A tap with no real frames must stay in DATA, even while the audition is playing.
	expect(onOutputMeter).toHaveBeenLastCalledWith({ mode: 'data', frame: null });
	const first = { mode: 'live', frame: frame(-2) } as const;
	taps[0].emit(first);
	onOutputMeter.mockClear();
	await vi.advanceTimersByTimeAsync(100);
	await press(screen.container, m.biblioteca_listen_current());
	expect(taps[0].disconnect).toHaveBeenCalledOnce();
	expect(taps).toHaveLength(2);
	taps[1].emit({ mode: 'live', frame: null });
	// Neither teardown nor the new subscription's initial DATA may flash the dial to DATA.
	expect(onOutputMeter).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(149);
	expect(onOutputMeter).not.toHaveBeenCalled();
	const replacement = { mode: 'live', frame: frame(-5) } as const;
	taps[1].emit(replacement);
	expect(onOutputMeter).toHaveBeenLastCalledWith(replacement);
	await vi.advanceTimersByTimeAsync(100);
	// Silence can still arrive labelled live within the shared tap's grace window, but cannot
	// extend the last active frame's expiry when the tap is replaced.
	taps[1].emit({ mode: 'live', frame: { ...frame(-5), active: false } });
	client.state.meterRef.set(-14);
	await tick();
	await Promise.resolve();
	await tick();
	expect(fakeTap.mock.calls[2]?.[1]).toMatchObject({ kinds: ['vu'], reference: -14 });
	expect(taps[1].disconnect).toHaveBeenCalledOnce();
	expect(onOutputMeter).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(149);
	expect(onOutputMeter).toHaveBeenLastCalledWith(replacement);
	await vi.advanceTimersByTimeAsync(1);
	expect(onOutputMeter).toHaveBeenLastCalledWith({ mode: 'data', frame: null });
	// A late but real replacement can go LIVE again; its own DATA clears immediately.
	taps[2].emit(first);
	expect(onOutputMeter).toHaveBeenLastCalledWith(first);
	taps[2].emit({ mode: 'data', frame: null });
	expect(onOutputMeter).toHaveBeenLastCalledWith({ mode: 'data', frame: null });
});

test('rapid side changes and a pending tap cannot renew the last reading or revive a cancelled tap', async () => {
	const { screen, onOutputMeter } = await setupSheet();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	await press(screen.container, m.biblioteca_listen_tape());
	const live = { mode: 'live', frame: frame(-3) } as const;
	taps[0].emit(live);
	let finish: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	fakeTap.mockImplementationOnce(async (node: AudioNode) => {
		const source = makeTap(node);
		await pending;
		return source;
	});
	await vi.advanceTimersByTimeAsync(100);
	await press(screen.container, m.biblioteca_listen_current());
	expect(onOutputMeter).toHaveBeenLastCalledWith(live);
	await vi.advanceTimersByTimeAsync(100);
	await press(screen.container, m.biblioteca_listen_tape());
	await vi.advanceTimersByTimeAsync(49);
	expect(onOutputMeter).toHaveBeenLastCalledWith(live);
	await vi.advanceTimersByTimeAsync(1);
	expect(onOutputMeter).toHaveBeenLastCalledWith({ mode: 'data', frame: null });
	finish?.();
	await pending;
	await tick();
	expect(taps[1].disconnect).toHaveBeenCalledOnce();
	onOutputMeter.mockClear();
	taps[0].emit(live);
	taps[1].emit(live);
	expect(onOutputMeter).not.toHaveBeenCalled();
	taps[2].emit(live);
	expect(onOutputMeter).toHaveBeenLastCalledWith(live);
	await cleanup();
	expect(taps[2].disconnect).toHaveBeenCalledOnce();
	expect(onOutputMeter).toHaveBeenLastCalledWith({ mode: 'data', frame: null });
	onOutputMeter.mockClear();
	await vi.advanceTimersByTimeAsync(300);
	expect(onOutputMeter).not.toHaveBeenCalled();
});

test('a failed replacement expires at the original last-frame deadline', async () => {
	const { screen, onOutputMeter } = await setupSheet();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	await press(screen.container, m.biblioteca_listen_tape());
	const live = { mode: 'live', frame: frame(-4) } as const;
	taps[0].emit(live);
	await vi.advanceTimersByTimeAsync(100);
	fakeTap.mockRejectedValueOnce(new Error('worklet unavailable'));
	await press(screen.container, m.biblioteca_listen_current());
	expect(onOutputMeter).toHaveBeenLastCalledWith(live);
	await vi.advanceTimersByTimeAsync(149);
	expect(onOutputMeter).toHaveBeenLastCalledWith(live);
	await vi.advanceTimersByTimeAsync(1);
	expect(onOutputMeter).toHaveBeenLastCalledWith({ mode: 'data', frame: null });
});
