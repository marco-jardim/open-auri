import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { gateForWrite } from 'open-auri/safety';
import { parseEnvelope } from 'open-auri/share';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import { createAudioEngine, IDLE_STATE, type AudioEngineState } from '#lib/audio/engine.ts';
import { neutralCurve } from '#lib/state/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import Biblioteca from '#lib/components/pages/biblioteca/Biblioteca.svelte';
import TrackSheet from '#lib/components/pages/biblioteca/TrackSheet.svelte';
import DataDial from '#lib/components/pages/biblioteca/DataDial.svelte';
import { archiveTapes, type Tape } from '#lib/components/pages/biblioteca/archive.ts';
import { downloadBlob, sheetPng } from '#lib/components/pages/biblioteca/sheet-export.ts';
import { fakeEnv, resetAudioConfig } from '../../audio/fake-audio.ts';

vi.mock('#lib/components/pages/biblioteca/sheet-export.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/components/pages/biblioteca/sheet-export.ts')>()),
	downloadBlob: vi.fn(),
	sheetPng: vi.fn()
}));

let app: ClientApp | null = null;
afterEach(async () => {
	await cleanup();
	app?.dispose();
	await app?.audio.dispose();
	app = null;
	vi.restoreAllMocks();
	vi.mocked(downloadBlob).mockReset();
	vi.mocked(sheetPng).mockReset();
	await setLocale('pt-BR', { reload: false });
});

async function isolatedApp(audio = createAudioEngine({ indexedDB: null })) {
	app = createClientApp({
		storage: { local: null, session: null, indexedDB: null, channel: null },
		audio
	});
	await app.state.ready;
	return app;
}

/** The sheet's own audition as the engine reports it (tagged with its SEEK.2 session). */
const sheetPlaying: AudioEngineState = {
	...IDLE_STATE,
	playing: true,
	mode: 'chains',
	session: 'biblioteca'
};

function sheetProps(tape: Tape = archiveTapes([])[0]) {
	return {
		tape,
		current: neutralCurve(),
		origin: 'https://example.test',
		locale: 'pt-BR' as const,
		app,
		verdict: gateForWrite(tape.bands, tape.preampDb),
		audioState: { ...IDLE_STATE },
		onClose: vi.fn(),
		onStatus: vi.fn()
	};
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`archive empty filters reset and local saves recover from refusal in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const client = await isolatedApp();
		const save = vi
			.spyOn(client.state.library, 'save')
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error('quota exceeded'));
		const screen = await render(Biblioteca, { app: client, origin: 'https://example.test' });
		await page.getByRole('button', { name: m.biblioteca_bass(), exact: true }).click();
		await page.getByRole('searchbox', { name: m.biblioteca_search() }).fill('no such tape');
		await expect.element(page.getByText(m.biblioteca_empty(), { exact: true })).toBeVisible();
		expect(screen.container.querySelectorAll('.tape')).toHaveLength(0);
		await page.getByRole('button', { name: m.biblioteca_clear(), exact: true }).click();
		expect(screen.container.querySelectorAll('.tape')).toHaveLength(11);
		await expect
			.element(page.getByRole('button', { name: m.biblioteca_all(), exact: true }))
			.toHaveAttribute('aria-pressed', 'true');
		await page.getByRole('combobox', { name: m.biblioteca_sort() }).selectOptions('name');
		await page.getByRole('button', { name: m.biblioteca_save(), exact: true }).click();
		await expect
			.element(screen.container.querySelector<HTMLElement>('.notice'))
			.toHaveTextContent(m.biblioteca_local_error());
		await page.getByRole('button', { name: m.biblioteca_save(), exact: true }).click();
		expect(save).toHaveBeenCalledTimes(2);
		await expect
			.element(page.getByRole('button', { name: m.biblioteca_save(), exact: true }))
			.toBeEnabled();
		vi.mocked(downloadBlob).mockImplementationOnce(() => {
			throw new Error('download refused');
		});
		await page.getByRole('button', { name: m.biblioteca_pack_export(), exact: true }).click();
		await expect
			.element(screen.container.querySelector<HTMLElement>('.notice'))
			.toHaveTextContent(m.biblioteca_export_error());
	});
}

test('sheet reports audio, clipboard and export failures without closing or writing', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	const client = await isolatedApp();
	vi.spyOn(client.audio, 'createAB').mockImplementation(() => {
		throw new Error('audio refused');
	});
	vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('clipboard refused'));
	const props = sheetProps();
	await render(TrackSheet, props);
	await page.getByRole('button', { name: m.biblioteca_listen_tape(), exact: true }).click();
	expect(props.onStatus).toHaveBeenLastCalledWith(m.biblioteca_audio_error());
	await page.getByRole('button', { name: m.biblioteca_copy(), exact: true }).click();
	await expect.poll(() => props.onStatus.mock.lastCall?.[0]).toBe(m.biblioteca_copy_error());
	vi.mocked(sheetPng).mockRejectedValueOnce(new Error('canvas refused'));
	await page.getByRole('button', { name: m.biblioteca_png(), exact: true }).click();
	await expect.poll(() => props.onStatus.mock.lastCall?.[0]).toBe(m.biblioteca_export_error());
	expect(downloadBlob).not.toHaveBeenCalled();
	await page.getByRole('button', { name: m.biblioteca_svg(), exact: true }).click();
	await expect.poll(() => vi.mocked(downloadBlob).mock.calls.length).toBe(1);
	expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'open-auri-sheet.svg');
	expect(props.onClose).not.toHaveBeenCalled();
	expect(client.pendingWrite).toBeNull();
});

test('sheet use refusal preserves the dialog; write only requests the shared checklist', async () => {
	const client = await isolatedApp();
	const set = vi
		.spyOn(client.state.curve, 'set')
		.mockReturnValueOnce(false)
		.mockReturnValueOnce(true);
	const props = sheetProps();
	await render(TrackSheet, props);
	await page.getByRole('button', { name: m.biblioteca_use(), exact: true }).click();
	expect(props.onStatus).toHaveBeenLastCalledWith(m.biblioteca_local_error());
	expect(props.onClose).not.toHaveBeenCalled();
	await page.getByRole('button', { name: m.biblioteca_use(), exact: true }).click();
	expect(set).toHaveBeenCalledTimes(2);
	expect(props.onStatus).toHaveBeenLastCalledWith(m.biblioteca_used());
	expect(props.onClose).toHaveBeenCalledOnce();
	await page.getByRole('button', { name: m.biblioteca_write(), exact: true }).click();
	expect(client.pendingWrite).toMatchObject({ schema: 1, name: props.tape.name });
	expect(client.cableState.writing).toBe(false);
});

test('local S5 rights require an explicit license and attribution before exporting', async () => {
	const tape: Tape = {
		...archiveTapes([])[0],
		...neutralCurve(),
		source: 'custom',
		id: 'local:one',
		group: 'local',
		createdAt: Date.UTC(2026, 9, 16),
		description: '',
		descriptionEn: null
	};
	const props = sheetProps(tape);
	const screen = await render(TrackSheet, props);
	await page.getByText(m.biblioteca_s5(), { exact: true }).click();
	const exportButton = page.getByRole('button', { name: m.biblioteca_s5_export(), exact: true });
	await expect.element(exportButton).toBeDisabled();
	await page.getByRole('combobox', { name: m.biblioteca_s5_license() }).selectOptions('CC-BY-4.0');
	await expect.element(exportButton).toBeDisabled();
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.biblioteca_s5_error());
	await page.getByRole('textbox', { name: m.biblioteca_author() }).fill('Local author');
	await expect.element(exportButton).toBeEnabled();
	await exportButton.click();
	await expect.poll(() => vi.mocked(downloadBlob).mock.calls.length).toBe(1);
	const blob = vi.mocked(downloadBlob).mock.calls[0][0];
	const json = await blob.text();
	expect(json).toContain('Local author');
	expect(parseEnvelope(json).ok).toBe(true);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	vi.mocked(downloadBlob).mockImplementationOnce(() => {
		throw new Error('envelope download refused');
	});
	await exportButton.click();
	await expect.poll(() => props.onStatus.mock.lastCall?.[0]).toBe(m.biblioteca_export_error());
	await screen.rerender({ verdict: { ...props.verdict, ok: false } });
	await tick();
	await expect
		.element(page.getByRole('button', { name: m.biblioteca_write(), exact: true }))
		.toBeDisabled();
});

test('a data dial has no needle without data and clamps only its drawing, not the readout', async () => {
	const screen = await render(DataDial, {
		label: 'Output',
		value: null,
		min: -24,
		max: 0,
		locale: 'en-US'
	});
	expect(screen.container.querySelector('.needle')).toBeNull();
	await expect.element(page.getByRole('img')).toHaveAccessibleName('Output: ∅ dB');
	await screen.rerender({ value: 6 });
	expect(screen.container.querySelector('.needle')?.getAttribute('transform')).toBe(
		'rotate(50 100 112)'
	);
	await expect.element(page.getByRole('meter')).toHaveAccessibleName('Output: 6.0 dB');
	await screen.rerender({ value: -30 });
	expect(screen.container.querySelector('.needle')?.getAttribute('transform')).toBe(
		'rotate(-50 100 112)'
	);
});

test('sheet A/B reuses its audition and an editor change releases that frozen comparison', async () => {
	const client = await isolatedApp();
	const start = vi.spyOn(client.audio, 'start').mockResolvedValue(undefined);
	// The (mocked) start put the engine in chain mode: the sheet's own audition (its session tag).
	vi.spyOn(client.audio, 'state').mockReturnValue({ ...sheetPlaying });
	const createAB = vi.spyOn(client.audio, 'createAB');
	const stop = vi.spyOn(client.audio, 'stop');
	const props = sheetProps();
	const screen = await render(TrackSheet, {
		...props,
		audioState: { ...sheetPlaying, exact: false }
	});
	await expect.element(page.getByText(m.biblioteca_approximate(), { exact: true })).toBeVisible();
	await page.getByRole('button', { name: m.biblioteca_listen_current(), exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: m.biblioteca_listen_current(), exact: true }))
		.toHaveAttribute('aria-pressed', 'true');
	// A comparison starts at a random point of the file (SEEK.2).
	expect(start).toHaveBeenCalledExactlyOnceWith('chains', {
		startAt: 'random',
		session: 'biblioteca'
	});
	const created = createAB.mock.results[0];
	if (created.type !== 'return') throw new Error('Missing sheet preview');
	const select = vi.spyOn(created.value, 'select');
	await page.getByRole('button', { name: m.biblioteca_listen_tape(), exact: true }).click();
	expect(select).toHaveBeenCalledWith('B');
	expect(createAB).toHaveBeenCalledOnce();
	await screen.rerender({ current: { ...neutralCurve(), preampDb: -1 } });
	expect(stop).toHaveBeenCalled();
	expect(client.audio.getChainOutput(created.value.a.id)).toBeNull();
	expect(client.audio.getChainOutput(created.value.b.id)).toBeNull();
	await expect.element(page.getByRole('button', { name: m.biblioteca_stop() })).toBeDisabled();
});

test('stopping a pending sheet start prevents a late audition from becoming selected', async () => {
	const client = await isolatedApp();
	let finish: (() => void) | undefined;
	vi.spyOn(client.audio, 'start').mockImplementation(
		() => new Promise<void>((resolve) => (finish = resolve))
	);
	vi.spyOn(client.audio, 'state').mockReturnValue({ ...sheetPlaying });
	const stop = vi.spyOn(client.audio, 'stop');
	await render(TrackSheet, {
		...sheetProps(),
		audioState: { ...sheetPlaying }
	});
	await page.getByRole('button', { name: m.biblioteca_listen_tape(), exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: m.biblioteca_listen_current(), exact: true }))
		.toHaveAttribute('aria-busy', 'true');
	// Button primitive contract (spec §2.6): a pending start is busy (clicks swallowed), not a
	// native disabled; both A/B keys share the busy state.
	await expect
		.element(page.getByRole('button', { name: m.biblioteca_listen_tape(), exact: true }))
		.toHaveAttribute('aria-busy', 'true');
	await page.getByRole('button', { name: m.biblioteca_stop(), exact: true }).click();
	// Not started yet, so not stopped by the button; the late start is stopped once it lands.
	expect(stop).not.toHaveBeenCalled();
	finish?.();
	await tick();
	await expect.poll(() => stop.mock.calls.length).toBe(1);
	await expect
		.element(page.getByRole('button', { name: m.biblioteca_listen_tape(), exact: true }))
		.toHaveAttribute('aria-pressed', 'false');
});

test('Gravar on a tape selected in the archive (deep $state) opens the checklist (R2-02)', async () => {
	const client = await isolatedApp();
	const screen = await render(Biblioteca, { app: client, origin: 'https://example.test' });
	const tape = screen.container.querySelector<HTMLButtonElement>('.tape');
	const name = tape?.querySelector('.tape-label strong')?.textContent;
	if (!tape || !name) throw new Error('Missing tape');
	tape.click();
	const write = page.getByRole('button', { name: m.biblioteca_write(), exact: true });
	await expect.element(write).toBeEnabled();
	await write.click();
	await expect.poll(() => client.pendingWrite).not.toBeNull();
	expect(client.pendingWrite).toMatchObject({ schema: 1, name });
	expect(() => structuredClone(client.pendingWrite)).not.toThrow();
	expect(client.cableState.writing).toBe(false);
});

test('the sheet stops only the audition it started, never raw playback (R2-08)', async () => {
	const client = await isolatedApp();
	let mode: AudioEngineState['mode'] = 'raw';
	vi.spyOn(client.audio, 'start').mockImplementation((next = 'chains') => {
		mode = next;
		return Promise.resolve();
	});
	vi.spyOn(client.audio, 'state').mockImplementation(() => ({
		...IDLE_STATE,
		playing: true,
		mode,
		// Raw is the ♪ Áudio panel's session; chains the sheet's own.
		session: mode === 'chains' ? 'biblioteca' : 'audio-panel'
	}));
	const stop = vi.spyOn(client.audio, 'stop');
	// Raw playback (♪ Áudio) running, no audition: closing the sheet leaves it alone.
	const idle = sheetProps();
	await render(TrackSheet, { ...idle, audioState: client.audio.state() });
	await page.getByRole('button', { name: m.biblioteca_close(), exact: true }).click();
	expect(idle.onClose).toHaveBeenCalledOnce();
	expect(stop).not.toHaveBeenCalled();
	await cleanup();

	// An audition, then the user switched to raw playback: no longer the sheet's to stop.
	const props = sheetProps();
	await render(TrackSheet, {
		...props,
		audioState: { ...IDLE_STATE, playing: true, mode: 'chains' }
	});
	await page.getByRole('button', { name: m.biblioteca_listen_current(), exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: m.biblioteca_listen_current(), exact: true }))
		.toHaveAttribute('aria-pressed', 'true');
	mode = 'raw';
	await page.getByRole('button', { name: m.biblioteca_close(), exact: true }).click();
	expect(props.onClose).toHaveBeenCalledOnce();
	expect(stop).not.toHaveBeenCalled();
	await cleanup();

	// Still its own chains audition: closing stops it.
	const own = sheetProps();
	await render(TrackSheet, {
		...own,
		audioState: { ...IDLE_STATE, playing: true, mode: 'chains' }
	});
	await page.getByRole('button', { name: m.biblioteca_listen_current(), exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: m.biblioteca_listen_current(), exact: true }))
		.toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('button', { name: m.biblioteca_close(), exact: true }).click();
	expect(stop).toHaveBeenCalledOnce();
});

test('the sheet Transport renders, and its pause keeps the comparison for a resume', async () => {
	resetAudioConfig();
	const client = await isolatedApp(createAudioEngine(fakeEnv(null).env));
	const start = vi.spyOn(client.audio, 'start');
	const stop = vi.spyOn(client.audio, 'stop');
	const pause = vi.spyOn(client.audio, 'pause');
	const resume = vi.spyOn(client.audio, 'resume');
	const props = sheetProps();
	const screen = await render(TrackSheet, { ...props, audioState: client.audio.state() });
	const unsubscribe = client.audio.onChange((state) => {
		void screen.rerender({ audioState: state });
	});
	try {
		const transport = page.getByRole('group', { name: m.transport_group() });
		await expect.element(transport).toBeVisible();
		await expect
			.element(transport.getByRole('slider', { name: m.transport_seek() }))
			.toBeInTheDocument();
		// Nothing paused: Transport play is the sheet's own A/B start, at a random point.
		await transport.getByRole('button', { name: m.transport_play(), exact: true }).click();
		await expect.poll(() => client.audio.state().session).toBe('biblioteca');
		expect(start).toHaveBeenCalledExactlyOnceWith('chains', {
			startAt: 'random',
			session: 'biblioteca'
		});
		await transport.getByRole('button', { name: m.transport_pause(), exact: true }).click();
		expect(pause).toHaveBeenCalledOnce();
		expect(stop).not.toHaveBeenCalled();
		expect(client.audio.state()).toMatchObject({ paused: true, session: 'biblioteca' });
		// A listen key on the paused comparison continues it (no new A/B, no new random point).
		await page.getByRole('button', { name: m.biblioteca_listen_current(), exact: true }).click();
		await expect.poll(() => resume.mock.calls.length).toBe(1);
		expect(start).toHaveBeenCalledOnce();
		expect(client.audio.state()).toMatchObject({ playing: true, session: 'biblioteca' });
		await page.getByRole('button', { name: m.biblioteca_close(), exact: true }).click();
		expect(stop).toHaveBeenCalledOnce();
	} finally {
		unsubscribe();
	}
});

test('invalid share origins disable exports but do not prevent copying the standalone S1 code', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
	const props = sheetProps();
	await render(TrackSheet, { ...props, origin: 'not a URL' });
	await expect.element(page.getByRole('button', { name: m.biblioteca_svg() })).toBeDisabled();
	await expect.element(page.getByRole('button', { name: m.biblioteca_png() })).toBeDisabled();
	await page.getByRole('button', { name: m.biblioteca_copy(), exact: true }).click();
	expect(copy).toHaveBeenCalledWith(expect.any(String));
	await expect.poll(() => props.onStatus.mock.lastCall?.[0]).toBe(m.biblioteca_copied());
	expect(downloadBlob).not.toHaveBeenCalled();
});
