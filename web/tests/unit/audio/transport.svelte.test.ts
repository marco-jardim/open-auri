// SEEK.1: the reusable Transport (seek bar, back to start, play/pause) on a fake engine.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import Transport from '#lib/components/audio/Transport.svelte';
import {
	AudioEngineError,
	IDLE_STATE,
	type AudioEngine,
	type AudioEngineState
} from '#lib/audio/engine.ts';
import { SEEK_END_GUARD_S } from '#lib/audio/transport.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import '#lib/styles/index.css';

const FILE_STATE: Partial<AudioEngineState> = {
	source: 'file',
	file: { name: 'Mix.wav', type: 'audio/wav', size: 1048576, addedAt: 1, duration: 225 },
	duration: 225,
	position: 83
};

function fakeEngine(initial: Partial<AudioEngineState> = {}) {
	let state: AudioEngineState = { ...IDLE_STATE, ...initial };
	const listeners = new Set<(state: AudioEngineState) => void>();
	const unsubscribe = vi.fn();
	const mocks = {
		state: () => state,
		onChange: vi.fn((listener: (state: AudioEngineState) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				unsubscribe();
			};
		}),
		pause: vi.fn<AudioEngine['pause']>(),
		resume: vi.fn<AudioEngine['resume']>().mockResolvedValue(true),
		seek: vi.fn<AudioEngine['seek']>().mockReturnValue(true),
		restart: vi.fn<AudioEngine['restart']>().mockReturnValue(true),
		getContext: vi.fn<AudioEngine['getContext']>(() => {
			throw new Error('No audio context in this test');
		})
	} satisfies Partial<AudioEngine>;
	return {
		engine: mocks as unknown as AudioEngine,
		mocks,
		unsubscribe,
		publish(next: Partial<AudioEngineState>) {
			state = { ...state, ...next };
			for (const listener of listeners) listener(state);
		}
	};
}

const valueText = (elapsed: string, total: string) => m.transport_valuetext({ elapsed, total });

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
	vi.spyOn(console, 'info').mockImplementation(() => undefined);
	vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

test('the seek bar is a named slider whose value reads "1:23 de 3:45"', async () => {
	const fake = fakeEngine(FILE_STATE);
	await render(Transport, { engine: fake.engine });
	expect(valueText('1:23', '3:45')).toBe('1:23 de 3:45');
	await expect.element(page.getByRole('group', { name: m.transport_group() })).toBeVisible();
	const seek = page.getByRole('slider', { name: m.transport_seek() });
	await expect.element(seek).toHaveAttribute('aria-valuetext', '1:23 de 3:45');
	await expect.element(seek).toHaveAttribute('aria-valuemin', '0');
	await expect.element(seek).toHaveAttribute('aria-valuemax', '225');
	await expect.element(seek).toHaveAttribute('aria-valuenow', '83');
	await expect.element(seek).toHaveAttribute('tabindex', '0');
	await expect.element(seek).not.toHaveAttribute('aria-disabled');
	// Elapsed and total in tabular mono; actions never in mono.
	const elapsed = page.getByText('1:23', { exact: true });
	await expect.element(elapsed).toBeVisible();
	await expect.element(page.getByText('3:45', { exact: true })).toBeVisible();
	const style = getComputedStyle(elapsed.element());
	expect(style.fontFamily).toMatch(/JetBrains Mono/);
	expect(style.fontVariantNumeric).toContain('tabular-nums');
	const play = page.getByRole('button', { name: m.transport_play(), exact: true });
	expect(getComputedStyle(play.element()).fontFamily).not.toMatch(/JetBrains Mono/);
	await expect.element(page.getByRole('button', { name: m.transport_restart() })).toBeVisible();
	// Compact rows carry no loop caption; the full variant does.
	expect(page.getByText(m.transport_loop()).elements()).toHaveLength(0);
});

test('keyboard: arrows ±5 s, PageUp/PageDown ±10 %, Home and End; other keys are left alone', async () => {
	const fake = fakeEngine(FILE_STATE);
	await render(Transport, { engine: fake.engine });
	const seek = page.getByRole('slider', { name: m.transport_seek() });
	(seek.element() as HTMLElement).focus();
	for (const key of [
		'{ArrowRight}',
		'{ArrowLeft}',
		'{ArrowUp}',
		'{ArrowDown}',
		'{PageUp}',
		'{PageDown}',
		'{Home}',
		'{End}',
		'a'
	]) {
		await userEvent.keyboard(key);
	}
	const targets = fake.mocks.seek.mock.calls.map(([seconds]) => seconds);
	expect(targets.slice(0, 7)).toEqual([88, 78, 88, 78, 105.5, 60.5, 0]);
	expect(targets).toHaveLength(8);
	expect(targets[7]).toBeCloseTo(225 - SEEK_END_GUARD_S, 9);
	const press = new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true });
	seek.element().dispatchEvent(press);
	expect(press.defaultPrevented).toBe(true);
	const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
	seek.element().dispatchEvent(tab);
	expect(tab.defaultPrevented).toBe(false);
	expect(fake.mocks.seek).toHaveBeenCalledTimes(9);
});

test('pointer scrubbing previews the time while dragging and commits on release only', async () => {
	const fake = fakeEngine(FILE_STATE);
	await render(Transport, { engine: fake.engine, variant: 'full' });
	const seek = page.getByRole('slider', { name: m.transport_seek() });
	const node = seek.element() as HTMLElement;
	const rect = node.getBoundingClientRect();
	expect(rect.width).toBeGreaterThan(0);
	const at = (fraction: number) => rect.left + rect.width * fraction;
	const pointer = (type: string, id: number, fraction: number) =>
		node.dispatchEvent(
			new PointerEvent(type, { pointerId: id, button: 0, clientX: at(fraction), bubbles: true })
		);

	pointer('pointerdown', 7, 0.5);
	await expect.element(seek).toHaveAttribute('aria-valuetext', valueText('1:52', '3:45'));
	await expect.element(seek).toHaveAttribute('data-scrubbing', 'true');
	expect(document.activeElement).toBe(node);
	pointer('pointermove', 7, 0.25);
	await expect.element(seek).toHaveAttribute('aria-valuetext', valueText('0:56', '3:45'));
	// Another pointer's moves do not steer the drag.
	pointer('pointermove', 9, 0.9);
	await expect.element(seek).toHaveAttribute('aria-valuetext', valueText('0:56', '3:45'));
	expect(fake.mocks.seek).not.toHaveBeenCalled();
	pointer('pointerup', 7, 0.25);
	expect(fake.mocks.seek).toHaveBeenCalledOnce();
	expect(fake.mocks.seek.mock.calls[0]?.[0]).toBeCloseTo(56.25, 6);
	await expect.element(seek).toHaveAttribute('aria-valuetext', valueText('1:23', '3:45'));
	await expect.element(seek).not.toHaveAttribute('data-scrubbing');

	// A cancelled drag is discarded; beyond the track the value clamps to the ends.
	pointer('pointerdown', 8, 1.4);
	await expect.element(seek).toHaveAttribute('aria-valuetext', valueText('3:44', '3:45'));
	pointer('pointercancel', 8, 1.4);
	await expect.element(seek).toHaveAttribute('aria-valuetext', valueText('1:23', '3:45'));
	pointer('pointerdown', 10, -0.5);
	pointer('pointerup', 10, -0.5);
	expect(fake.mocks.seek).toHaveBeenCalledTimes(2);
	expect(fake.mocks.seek).toHaveBeenLastCalledWith(0);
	// The loop caption belongs to the full variant.
	await expect.element(page.getByText(m.transport_loop())).toBeVisible();
});

test('pink noise: the seek bar reads "ruído rosa · contínuo", stays focusable and says why it is off', async () => {
	const fake = fakeEngine({ position: 0 });
	await render(Transport, { engine: fake.engine, onplay: vi.fn() });
	expect(m.transport_noise()).toBe('ruído rosa · contínuo');
	const seek = page.getByRole('slider', { name: m.transport_seek() });
	await expect.element(seek).toHaveAttribute('aria-disabled', 'true');
	await expect.element(seek).toHaveAttribute('aria-valuetext', m.transport_noise());
	await expect.element(seek).toHaveAccessibleDescription(m.transport_reason_noise());
	await expect.element(page.getByText(m.transport_noise(), { exact: true })).toBeVisible();
	const node = seek.element() as HTMLElement;
	node.focus();
	expect(document.activeElement).toBe(node);
	// Keyboard focus opens the reason at once (the restart button has its own tooltip).
	const tipId = node.getAttribute('aria-describedby');
	const tip = tipId ? document.getElementById(tipId) : null;
	expect(tip?.getAttribute('role')).toBe('tooltip');
	await expect.poll(() => tip?.matches(':popover-open')).toBe(true);
	await userEvent.keyboard('{End}');
	node.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, button: 0, bubbles: true }));
	node.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, button: 0, bubbles: true }));
	expect(fake.mocks.seek).not.toHaveBeenCalled();
	const restart = page.getByRole('button', { name: m.transport_restart() });
	await expect.element(restart).toHaveAttribute('aria-disabled', 'true');
	await expect.element(restart).toHaveAccessibleDescription(m.transport_reason_noise());
	(restart.element() as HTMLElement).click();
	expect(fake.mocks.restart).not.toHaveBeenCalled();
	// Play still works with noise: the page decides what to start.
	const play = page.getByRole('button', { name: m.transport_play(), exact: true });
	await expect.element(play).not.toHaveAttribute('aria-disabled');
});

test('a tap or click on the unavailable seek bar opens its reason, without seeking', async () => {
	const fake = fakeEngine({ ...FILE_STATE, duration: null, position: 0 });
	await render(Transport, { engine: fake.engine });
	const seek = page.getByRole('slider', { name: m.transport_seek() });
	await expect.element(seek).toHaveAttribute('aria-disabled', 'true');
	const node = seek.element() as HTMLElement;
	const tipId = node.getAttribute('aria-describedby');
	const tip = tipId ? document.getElementById(tipId) : null;
	expect(tip?.textContent?.trim()).toBe(m.transport_reason_loading());
	// No hover and no focus (a synthetic press moves neither): only the press can open it.
	expect(tip?.matches(':popover-open')).toBe(false);
	// A secondary button press is not a request for the reason.
	node.dispatchEvent(
		new PointerEvent('pointerdown', {
			pointerId: 4,
			button: 2,
			pointerType: 'touch',
			bubbles: true
		})
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(tip?.matches(':popover-open')).toBe(false);
	node.dispatchEvent(
		new PointerEvent('pointerdown', {
			pointerId: 5,
			button: 0,
			pointerType: 'touch',
			bubbles: true
		})
	);
	node.dispatchEvent(
		new PointerEvent('pointerup', { pointerId: 5, button: 0, pointerType: 'touch', bubbles: true })
	);
	await expect.poll(() => tip?.matches(':popover-open')).toBe(true);
	expect(fake.mocks.seek).not.toHaveBeenCalled();
	await expect.element(seek).not.toHaveAttribute('data-scrubbing');
	// Once the length is known the bar works and the reason tooltip is gone.
	fake.publish({ duration: 225 });
	await expect.element(seek).not.toHaveAttribute('aria-disabled');
	expect(document.getElementById(tipId ?? '')).toBeNull();
});

test('a file whose length is not read yet keeps the bar unavailable with its own reason', async () => {
	const fake = fakeEngine({ ...FILE_STATE, duration: null, position: 0 });
	await render(Transport, { engine: fake.engine });
	const seek = page.getByRole('slider', { name: m.transport_seek() });
	await expect.element(seek).toHaveAttribute('aria-disabled', 'true');
	await expect.element(seek).toHaveAccessibleDescription(m.transport_reason_loading());
	await expect.element(seek).toHaveAttribute('aria-valuetext', valueText('0:00', '…'));
	fake.publish({ duration: 225 });
	await expect.element(seek).not.toHaveAttribute('aria-disabled');
	await expect.element(seek).toHaveAttribute('aria-valuetext', valueText('0:00', '3:45'));
});

test('back to start calls restart', async () => {
	const fake = fakeEngine(FILE_STATE);
	await render(Transport, { engine: fake.engine });
	await page.getByRole('button', { name: m.transport_restart() }).click();
	expect(fake.mocks.restart).toHaveBeenCalledExactlyOnceWith();
});

test('play pauses while playing, continues its own paused session, else runs the page’s onplay', async () => {
	const fake = fakeEngine({ ...FILE_STATE, playing: true, mode: 'chains', session: 'curva' });
	const onplay = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
	await render(Transport, { engine: fake.engine, session: 'curva', onplay });

	await page.getByRole('button', { name: m.transport_pause(), exact: true }).click();
	expect(fake.mocks.pause).toHaveBeenCalledExactlyOnceWith();

	fake.publish({ playing: false, mode: 'off', paused: true, canToggle: true, toggleReason: null });
	await page.getByRole('button', { name: m.transport_resume(), exact: true }).click();
	expect(fake.mocks.resume).toHaveBeenCalledExactlyOnceWith();
	expect(onplay).not.toHaveBeenCalled();

	// Another page's paused preview is not this transport's to continue.
	fake.publish({ session: 'comparar' });
	await page.getByRole('button', { name: m.transport_play(), exact: true }).click();
	expect(onplay).toHaveBeenCalledOnce();
	expect(fake.mocks.resume).toHaveBeenCalledOnce();

	fake.publish({ paused: false, session: null, canToggle: false, toggleReason: 'no-session' });
	await page.getByRole('button', { name: m.transport_play(), exact: true }).click();
	expect(onplay).toHaveBeenCalledTimes(2);
});

test('without onplay and nothing paused, play says why and never acts', async () => {
	const fake = fakeEngine(FILE_STATE);
	const screen = await render(Transport, { engine: fake.engine });
	const play = page.getByRole('button', { name: m.transport_play(), exact: true });
	await expect.element(play).toHaveAttribute('aria-disabled', 'true');
	await expect.element(play).toHaveAccessibleDescription(m.transport_toggle_no_session());
	(play.element() as HTMLElement).click();
	expect(fake.mocks.resume).not.toHaveBeenCalled();
	expect(fake.mocks.pause).not.toHaveBeenCalled();

	fake.publish({ toggleReason: 'unsupported' });
	await expect.element(play).toHaveAccessibleDescription(m.transport_toggle_unsupported());

	// Any paused session is resumable when no session tag is given (the audio panel).
	fake.publish({ paused: true, session: 'teste-cego', canToggle: true, toggleReason: null });
	await page.getByRole('button', { name: m.transport_resume(), exact: true }).click();
	expect(fake.mocks.resume).toHaveBeenCalledOnce();

	// The host's reason blocks starting a new preview only.
	await screen.rerender({ onplay: vi.fn(), playDisabledReason: 'Carregue um arquivo.' });
	fake.publish({ paused: false, session: null, canToggle: false, toggleReason: 'no-session' });
	await expect.element(play).toHaveAccessibleDescription('Carregue um arquivo.');
	fake.publish({ playing: true, mode: 'raw' });
	const pause = page.getByRole('button', { name: m.transport_pause(), exact: true });
	await expect.element(pause).not.toHaveAttribute('aria-disabled');
});

test('a failed start reaches onerror and the button is usable again', async () => {
	const failure = new AudioEngineError('gesture');
	const onplay = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
	const onerror = vi.fn();
	const fake = fakeEngine(FILE_STATE);
	await render(Transport, {
		engine: fake.engine,
		onplay,
		onerror,
		startLabel: 'Ouvir prévia'
	});
	const play = page.getByRole('button', { name: 'Ouvir prévia', exact: true });
	await play.click();
	await expect.poll(() => onerror.mock.calls.length).toBe(1);
	expect(onerror).toHaveBeenCalledWith(failure);
	await expect.element(play).not.toHaveAttribute('aria-busy');
	await play.click();
	expect(onplay).toHaveBeenCalledTimes(2);
});

test('it follows the engine through its own subscription, or the host state when given', async () => {
	const fake = fakeEngine(FILE_STATE);
	await render(Transport, { engine: fake.engine });
	const seek = page.getByRole('slider', { name: m.transport_seek() });
	fake.publish({ position: 100 });
	await expect.element(seek).toHaveAttribute('aria-valuetext', valueText('1:40', '3:45'));
	expect(fake.mocks.onChange).toHaveBeenCalledOnce();
	await cleanup();
	expect(fake.unsubscribe).toHaveBeenCalledOnce();

	const hosted = fakeEngine(FILE_STATE);
	await render(Transport, {
		engine: hosted.engine,
		state: { ...IDLE_STATE, ...FILE_STATE, position: 10 }
	});
	await expect
		.element(page.getByRole('slider', { name: m.transport_seek() }))
		.toHaveAttribute('aria-valuetext', valueText('0:10', '3:45'));
	expect(hosted.mocks.onChange).not.toHaveBeenCalled();
});

test('without an engine yet, every control says the audio is still loading', async () => {
	await render(Transport, { engine: null, onplay: vi.fn() });
	const seek = page.getByRole('slider', { name: m.transport_seek() });
	await expect.element(seek).toHaveAttribute('aria-disabled', 'true');
	await expect.element(seek).toHaveAccessibleDescription(m.transport_reason_no_engine());
	const play = page.getByRole('button', { name: m.transport_play(), exact: true });
	await expect.element(play).toHaveAccessibleDescription(m.transport_reason_no_engine());
});
