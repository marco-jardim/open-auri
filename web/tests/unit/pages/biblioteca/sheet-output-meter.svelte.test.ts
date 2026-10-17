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

test('the Preamp tap is the selected A/B chain output, only while the sheet audition plays', async () => {
	fakeTap.mockImplementation(async (node: AudioNode) => {
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
	});
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
