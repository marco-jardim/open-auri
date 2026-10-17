import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import CableBar from '#lib/components/chrome/CableBar.svelte';
import { playbackShortcut } from '#lib/components/chrome/shortcuts.ts';
import { createPlaybackEngine } from './playback-fixture.ts';
import '../primitives/design-system.ts';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
	await page.viewport(1440, 900);
});

afterEach(cleanup);

test('the existing preview label and glyph follow playing, without starting playback', async () => {
	const preview = createPlaybackEngine({ playing: false, paused: true });
	const screen = await render(CableBar, { playbackEngine: preview.engine });
	const resume = page.getByRole('button', { name: m.transport_toggle_resume(), exact: true });
	await expect.element(resume).toBeVisible();
	await expect.element(resume).toHaveTextContent('▶');
	await expect.element(resume).toHaveAttribute('aria-keyshortcuts', 'k');
	preview.setState({ playing: true, paused: false });
	const pause = page.getByRole('button', { name: m.transport_toggle_pause(), exact: true });
	await expect.element(pause).toHaveTextContent('❚❚');
	preview.setState({ playing: false, paused: true });
	await expect.element(resume).toHaveTextContent('▶');
	expect(preview.togglePlayback).not.toHaveBeenCalled();
	expect(preview.listeners.size).toBe(1);
	await screen.unmount();
	expect(preview.listeners.size).toBe(0);
});

test('before the lazy runtime arrives the placeholder explains that the engine is loading', async () => {
	const screen = await render(CableBar);
	const button = page.getByRole('button', { name: m.transport_toggle_resume(), exact: true });
	await expect.element(button).toHaveAttribute('aria-disabled', 'true');
	await expect.element(button).toHaveAccessibleDescription('Carregando o motor de áudio…');
	const preview = createPlaybackEngine();
	await screen.rerender({ playbackEngine: preview.engine });
	await expect
		.element(page.getByRole('button', { name: m.transport_toggle_pause(), exact: true }))
		.not.toHaveAttribute('aria-disabled');
	expect(preview.togglePlayback).not.toHaveBeenCalled();
});

for (const reason of ['no-session', 'unsupported'] as const) {
	test(`an unavailable preview explains ${reason} and a click never creates a session`, async () => {
		const preview = createPlaybackEngine({
			mode: 'off',
			playing: false,
			paused: false,
			session: null,
			canToggle: false,
			toggleReason: reason
		});
		await render(CableBar, { playbackEngine: preview.engine });
		const button = page.getByRole('button', { name: m.transport_toggle_resume(), exact: true });
		await expect.element(button).toHaveAttribute('aria-disabled', 'true');
		await expect
			.element(button)
			.toHaveAccessibleDescription(
				reason === 'no-session' ? m.transport_toggle_no_session() : m.transport_toggle_unsupported()
			);
		(button.element() as HTMLElement).click();
		await expect.element(page.getByRole('tooltip')).toBeVisible();
		expect(preview.togglePlayback).not.toHaveBeenCalled();
	});
}

test('one click calls togglePlayback exactly once', async () => {
	const preview = createPlaybackEngine();
	await render(CableBar, { playbackEngine: preview.engine });
	expect(preview.togglePlayback).not.toHaveBeenCalled();
	await page.getByRole('button', { name: m.transport_toggle_pause(), exact: true }).click();
	expect(preview.togglePlayback).toHaveBeenCalledExactlyOnceWith();
});

test('a failed resume reports the engine error instead of claiming playback resumed', async () => {
	const preview = createPlaybackEngine({ playing: false, paused: true, error: 'gesture' });
	preview.togglePlayback.mockResolvedValue('failed');
	const onPlaybackError = vi.fn();
	await render(CableBar, { playbackEngine: preview.engine, onPlaybackError });
	await page.getByRole('button', { name: m.transport_toggle_resume(), exact: true }).click();
	await expect.poll(() => onPlaybackError.mock.calls).toEqual([[m.audio_error_gesture()]]);
});

test('the layout k handler toggles once, but leaves typing, modifiers and open dialogs alone', async () => {
	const preview = createPlaybackEngine();
	const screen = await render(CableBar, { playbackEngine: preview.engine });
	// Same window handler as +layout, without mounting its unrelated runtime and routes.
	const keydown = (event: KeyboardEvent) => playbackShortcut(event, preview.engine);
	window.addEventListener('keydown', keydown);
	const key = (options: KeyboardEventInit = {}) =>
		new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true, ...options });
	try {
		const toggle = key();
		window.dispatchEvent(toggle);
		expect(toggle.defaultPrevented).toBe(true);
		expect(preview.togglePlayback).toHaveBeenCalledExactlyOnceWith();
		preview.togglePlayback.mockClear();

		for (const tag of ['input', 'textarea', 'select']) {
			const field = document.createElement(tag);
			screen.container.append(field);
			field.dispatchEvent(key());
			field.remove();
		}
		const editable = document.createElement('div');
		editable.contentEditable = 'true';
		const text = document.createElement('span');
		editable.append(text);
		screen.container.append(editable);
		text.dispatchEvent(key());
		editable.remove();

		for (const options of [
			{ ctrlKey: true },
			{ metaKey: true },
			{ altKey: true },
			{ shiftKey: true },
			{ repeat: true },
			{ isComposing: true },
			{ key: ' ' }
		]) {
			const event = key(options);
			window.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
		}
		const prevented = key();
		prevented.preventDefault();
		window.dispatchEvent(prevented);

		const dialog = document.createElement('dialog');
		dialog.open = true;
		screen.container.append(dialog);
		window.dispatchEvent(key());
		dialog.remove();
		const modal = document.createElement('div');
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');
		screen.container.append(modal);
		window.dispatchEvent(key());
		modal.remove();
		expect(preview.togglePlayback).not.toHaveBeenCalled();

		// Closing the dialog makes the same shortcut available again.
		window.dispatchEvent(key());
		expect(preview.togglePlayback).toHaveBeenCalledExactlyOnceWith();
	} finally {
		window.removeEventListener('keydown', keydown);
	}
});

test('k cannot start a session or load an absent runtime', () => {
	const preview = createPlaybackEngine({ canToggle: false, toggleReason: 'no-session' });
	const event = () => new KeyboardEvent('keydown', { key: 'k', cancelable: true });
	expect(playbackShortcut(event())).toBe(false);
	const unavailable = event();
	expect(playbackShortcut(unavailable, preview.engine)).toBe(false);
	expect(unavailable.defaultPrevented).toBe(false);
	expect(preview.togglePlayback).not.toHaveBeenCalled();
});
