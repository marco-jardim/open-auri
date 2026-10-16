import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import AudioLoader from '#lib/components/audio/AudioLoader.svelte';
import {
	AudioEngineError,
	getAudioEngine,
	IDLE_STATE,
	MAX_FILE_BYTES,
	type AudioEngine,
	type AudioEngineState,
	type AudioErrorCode
} from '#lib/audio/engine.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';

vi.mock(import('#lib/audio/engine.ts'), async (original) => ({
	...(await original()),
	getAudioEngine: vi.fn()
}));

const fileInfo = {
	name: 'Reference.wav',
	type: 'audio/wav',
	size: 1048576,
	addedAt: 1,
	duration: 65.9
};

function audioUi(initial: Partial<AudioEngineState> = {}) {
	let state: AudioEngineState = { ...IDLE_STATE, ...initial };
	const listeners = new Set<(state: AudioEngineState) => void>();
	const unsubscribe = vi.fn();
	const unavailable = () => {
		throw new Error('Audio graph must not be used by the loader');
	};
	const engine: AudioEngine = {
		state: () => state,
		onChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				unsubscribe();
			};
		},
		loadFile: vi.fn<AudioEngine['loadFile']>().mockResolvedValue(undefined),
		removeFile: vi.fn<AudioEngine['removeFile']>().mockResolvedValue(undefined),
		start: vi.fn<AudioEngine['start']>().mockResolvedValue(undefined),
		stop: vi.fn(),
		setVolume: vi.fn(),
		restore: vi.fn<AudioEngine['restore']>().mockResolvedValue(undefined),
		toggleRaw: unavailable,
		getContext: unavailable,
		buildChain: unavailable,
		matchGains: unavailable,
		createAB: unavailable,
		getAnalyserTap: unavailable,
		getMeterBus: unavailable,
		getChainOutput: unavailable,
		getSourceBus: unavailable,
		dispose: vi.fn<AudioEngine['dispose']>().mockResolvedValue(undefined)
	};
	return {
		engine,
		unsubscribe,
		publish(next: Partial<AudioEngineState>) {
			state = { ...state, ...next };
			for (const listener of listeners) listener(state);
		}
	};
}

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
	vi.mocked(getAudioEngine).mockReset();
});

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

test('opens and closes the idle popover without starting audio, and unsubscribes without disposing the shared engine', async () => {
	const fake = audioUi();
	vi.mocked(getAudioEngine).mockReturnValue(fake.engine);
	const screen = await render(AudioLoader);
	const trigger = page.getByRole('button', { name: m.audio_button_aria({ name: m.audio_none() }) });
	const dialog = screen.container.querySelector<HTMLDivElement>('[role="dialog"]')!;
	expect(dialog.hidden).toBe(true);
	expect(getAudioEngine).toHaveBeenCalledOnce();
	expect(fake.engine.start).not.toHaveBeenCalled();
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
	await trigger.click();
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await expect.element(trigger).toHaveAttribute('aria-expanded', 'true');
	await expect
		.element(page.getByRole('button', { name: m.audio_play(), exact: true }))
		.toBeDisabled();
	await expect.element(page.getByRole('button', { name: m.audio_remove() })).toBeDisabled();
	await expect.element(page.getByText(m.audio_rate_idle())).toBeVisible();
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
	dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await tick();
	expect(dialog.hidden).toBe(false);
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
	await tick();
	expect(dialog.hidden).toBe(true);
	await trigger.click();
	document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await tick();
	expect(dialog.hidden).toBe(true);
	await trigger.click();
	await trigger.click();
	expect(dialog.hidden).toBe(true);
	await cleanup();
	expect(fake.unsubscribe).toHaveBeenCalledOnce();
	expect(fake.engine.dispose).not.toHaveBeenCalled();
});

test('file picking resets the input, ignores cancellation and reports both typed and unknown load failures', async () => {
	const fake = audioUi();
	const screen = await render(AudioLoader, { engine: fake.engine });
	await page.getByRole('button').click();
	const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]')!;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	expect(fake.engine.loadFile).not.toHaveBeenCalled();
	const file = new File(['audio'], 'Preview.wav', { type: 'audio/wav' });
	const pick = () => {
		const transfer = new DataTransfer();
		transfer.items.add(file);
		input.files = transfer.files;
		input.dispatchEvent(new Event('change', { bubbles: true }));
	};
	vi.mocked(fake.engine.loadFile).mockRejectedValueOnce(new AudioEngineError('too-large'));
	pick();
	await expect
		.element(page.getByRole('alert'))
		.toHaveTextContent(m.audio_error_too_large({ limit: String(MAX_FILE_BYTES / 1048576) }));
	expect(input.value).toBe('');
	expect(fake.engine.loadFile).toHaveBeenCalledWith(file);
	vi.mocked(fake.engine.loadFile).mockRejectedValueOnce(new Error('Unexpected file error'));
	pick();
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.audio_error_invalid());
	pick();
	await tick();
	expect(page.getByRole('alert').elements()).toHaveLength(0);
	expect(fake.engine.loadFile).toHaveBeenCalledTimes(3);
	expect(getAudioEngine).not.toHaveBeenCalled();
});

test('drag/drop highlights only during a drag, ignores empty drops and detaches its listeners', async () => {
	const fake = audioUi();
	const screen = await render(AudioLoader, { engine: fake.engine });
	await page.getByRole('button').click();
	const zone = screen.container.querySelector<HTMLDivElement>('.oa-audio-drop')!;
	const over = new DragEvent('dragover', { cancelable: true });
	zone.dispatchEvent(over);
	await tick();
	expect(over.defaultPrevented).toBe(true);
	expect(zone.classList.contains('dragging')).toBe(true);
	zone.dispatchEvent(new DragEvent('dragleave'));
	await tick();
	expect(zone.classList.contains('dragging')).toBe(false);
	zone.dispatchEvent(new DragEvent('drop', { cancelable: true }));
	expect(fake.engine.loadFile).not.toHaveBeenCalled();
	const transfer = new DataTransfer();
	const file = new File(['audio'], 'Dropped.mp3', { type: 'audio/mpeg' });
	transfer.items.add(file);
	zone.dispatchEvent(new DragEvent('dragover'));
	zone.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, cancelable: true }));
	await tick();
	expect(zone.classList.contains('dragging')).toBe(false);
	expect(fake.engine.loadFile).toHaveBeenCalledExactlyOnceWith(file);
	const remove = vi.spyOn(zone, 'removeEventListener');
	await cleanup();
	for (const type of ['dragover', 'dragleave', 'drop']) {
		expect(remove).toHaveBeenCalledWith(type, expect.any(Function));
	}
});

test('metadata, rate, volume and persistence follow engine updates; playback and removal require clicks', async () => {
	const fake = audioUi({ file: fileInfo, persisted: false });
	const screen = await render(AudioLoader, { engine: fake.engine });
	await page.getByRole('button', { name: m.audio_button_aria({ name: fileInfo.name }) }).click();
	const meta = screen.container.querySelector('.oa-audio-meta')!;
	expect(meta.textContent).toContain('Reference.wav');
	expect(meta.textContent).toContain('1:05');
	expect(meta.textContent).toContain('1 MB');
	await expect.element(page.getByText(m.audio_not_saved())).toBeVisible();
	expect(fake.engine.start).not.toHaveBeenCalled();
	await page.getByRole('button', { name: m.audio_play(), exact: true }).click();
	expect(fake.engine.start).toHaveBeenCalledExactlyOnceWith('raw');
	fake.publish({ playing: true, mode: 'raw', ready: true, exact: true, persisted: true });
	await expect.element(page.getByText(m.audio_rate_exact())).toBeVisible();
	expect(page.getByText(m.audio_not_saved()).elements()).toHaveLength(0);
	await page.getByRole('button', { name: m.audio_pause(), exact: true }).click();
	expect(fake.engine.stop).toHaveBeenCalledExactlyOnceWith();
	fake.publish({ playing: false, exact: false, rate: 48000, file: { ...fileInfo, duration: NaN } });
	await expect.element(page.getByText(m.audio_rate_approx({ rate: '48.000' }))).toBeVisible();
	expect(meta.textContent).toContain('…');
	const volume = screen.container.querySelector<HTMLInputElement>('input[type="range"]')!;
	volume.value = '0';
	volume.dispatchEvent(new Event('input', { bubbles: true }));
	expect(fake.engine.setVolume).toHaveBeenCalledExactlyOnceWith(0);
	fake.publish({ volumeDb: 0 });
	await expect.element(page.getByRole('slider')).toHaveAttribute('aria-valuetext', '0 dB');
	fake.publish({ volumeDb: -20 });
	await expect.element(page.getByRole('slider')).toHaveAttribute('aria-valuetext', '−20 dB');
	await page.getByRole('button', { name: m.audio_remove() }).click();
	expect(fake.engine.removeFile).toHaveBeenCalledExactlyOnceWith();
	fake.publish({ file: null });
	await expect.element(page.getByRole('button', { name: m.audio_remove() })).toBeDisabled();
});

test('play failures use engine codes or the suspended fallback and can be cleared by removal', async () => {
	const fake = audioUi({ file: fileInfo });
	await render(AudioLoader, { engine: fake.engine });
	await page.getByRole('button').click();
	vi.mocked(fake.engine.start).mockRejectedValueOnce(new AudioEngineError('gesture'));
	await page.getByRole('button', { name: m.audio_play(), exact: true }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.audio_error_gesture());
	vi.mocked(fake.engine.start).mockRejectedValueOnce('Not resumable');
	await page.getByRole('button', { name: m.audio_play(), exact: true }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.audio_error_suspended());
	await page.getByRole('button', { name: m.audio_remove() }).click();
	expect(page.getByRole('alert').elements()).toHaveLength(0);
});

test('the popover carries the global 0 VU reference selector bound to the store it is given', async () => {
	const fake = audioUi();
	let value: -18 | -20 | -14 = -18;
	const store = {
		get value() {
			return value;
		},
		set: vi.fn((next: -18 | -20 | -14) => {
			value = next;
			return true;
		})
	};
	await render(AudioLoader, { engine: fake.engine, meterRef: store });
	await page.getByRole('button').first().click();
	const group = page.getByRole('group', { name: m.meters_vu_reference() });
	await expect.element(group).toBeVisible();
	const minus20 = m.meters_vu_reference_option({ value: '−20' });
	await page.getByRole('radio', { name: minus20 }).click();
	expect(store.set).toHaveBeenCalledExactlyOnceWith(-20);
	expect(fake.engine.start).not.toHaveBeenCalled();
});

test('without a store (and without the app context) the selector is not rendered', async () => {
	const fake = audioUi();
	await render(AudioLoader, { engine: fake.engine });
	await page.getByRole('button').click();
	expect(page.getByRole('group', { name: m.meters_vu_reference() }).elements()).toHaveLength(0);
});

const errors: [AudioErrorCode, () => string][] = [
	['invalid-file', () => m.audio_error_invalid()],
	['too-large', () => m.audio_error_too_large({ limit: '200' })],
	['decode', () => m.audio_error_decode()],
	['suspended', () => m.audio_error_suspended()],
	['gesture', () => m.audio_error_gesture()],
	['tab-hidden', () => m.audio_error_tab_hidden()],
	['unsupported', () => m.audio_error_unsupported()]
];

test.each(errors)('announces the engine %s error', async (error, text) => {
	const fake = audioUi({ error });
	await render(AudioLoader, { engine: fake.engine });
	await page.getByRole('button').click();
	await expect.element(page.getByRole('alert')).toHaveTextContent(text());
});
