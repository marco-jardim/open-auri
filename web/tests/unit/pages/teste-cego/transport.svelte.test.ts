import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { setLocale } from '#lib/paraglide/runtime.js';
import { m } from '#lib/paraglide/messages.js';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';

const engines: AudioEngine[] = [];

afterEach(async () => {
	await cleanup();
	for (const engine of engines.splice(0)) await engine.dispose();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

const randomStart = { startAt: 'random', session: 'teste-cego' } as const;

test('every trial starts at a random point; a pause keeps the round; a swap keeps the moment', async () => {
	await setLocale('en-US', { reload: false });
	const audio = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
	audio.setVolume(-40);
	engines.push(audio);
	const start = vi.spyOn(audio, 'start');
	const pause = vi.spyOn(audio, 'pause');
	const resume = vi.spyOn(audio, 'resume');
	const stop = vi.spyOn(audio, 'stop');
	const restart = vi.spyOn(audio, 'restart');
	await render(BlindTest, { audio, reducedMotion: true });

	// The console's Transport is there before any test runs, saying why it cannot start yet.
	const transport = page.getByRole('group', { name: m.transport_group() });
	await expect.element(transport).toBeVisible();
	await expect
		.element(transport.getByRole('slider', { name: m.transport_seek() }))
		.toBeInTheDocument();
	await expect
		.element(transport.getByRole('button', { name: m.transport_play(), exact: true }))
		.toHaveAccessibleDescription(m.cego_fux_reason_play_idle());

	await page.getByRole('radio', { name: /^Other output/ }).click();
	await page.getByRole('tab', { name: /Candidates/ }).click();
	await page.getByRole('checkbox', { name: /^Auri\b/ }).click();
	await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	// Starting the test silences whatever played before it; from here only the trial counts.
	stop.mockClear();
	const panel = page.getByRole('tabpanel');

	// Trial 1 starts at a random point of the file.
	await panel.getByRole('button', { name: m.cego_play(), exact: true }).click();
	await expect.poll(() => audio.state().playing).toBe(true);
	expect(start).toHaveBeenCalledExactlyOnceWith('chains', randomStart);

	// Pause (Transport): the round, its position and trims stay; nothing is stopped.
	await transport.getByRole('button', { name: m.transport_pause(), exact: true }).click();
	expect(pause).toHaveBeenCalledOnce();
	expect(stop).not.toHaveBeenCalled();
	expect(audio.state()).toMatchObject({ playing: false, paused: true, session: 'teste-cego' });

	// The Play key continues the same trial: no new random point.
	await panel.getByRole('button', { name: m.cego_play(), exact: true }).click();
	await expect.poll(() => resume.mock.calls.length).toBe(1);
	await expect.poll(() => audio.state().playing).toBe(true);
	expect(start).toHaveBeenCalledOnce();

	// A blind swap keeps the current position: no start, no restart, still playing. The scores
	// are given on the stage faders, under each bay.
	const score = (number: number) =>
		page.getByRole('slider', { name: m.cego_rating({ number }), exact: true });
	const press = async (number: number, keys: string) => {
		const input = score(number).element();
		if (!(input instanceof HTMLInputElement)) throw new Error('Missing score fader');
		input.focus();
		await userEvent.keyboard(keys);
	};
	await press(1, `{Home}${'{ArrowRight}'.repeat(8)}`);
	await expect.element(score(1)).toHaveAttribute('aria-valuetext', '4.0');
	await panel.getByRole('button', { name: /Position 2/ }).click();
	expect(start).toHaveBeenCalledOnce();
	expect(restart).not.toHaveBeenCalled();
	expect(audio.state()).toMatchObject({ playing: true, session: 'teste-cego' });
	await expect.element(score(2)).toBeEnabled();
	await press(2, `{End}${'{ArrowLeft}'.repeat(6)}`);
	await expect.element(score(2)).toHaveAttribute('aria-valuetext', '7.0');

	// The trial ends (its session with it); the next one starts at its own random point.
	await panel.getByRole('button', { name: 'Next round', exact: true }).click();
	expect(stop).toHaveBeenCalledOnce();
	expect(audio.state()).toMatchObject({ playing: false, paused: false, session: null });
	await panel.getByRole('button', { name: m.cego_play(), exact: true }).click();
	await expect.poll(() => start.mock.calls.length).toBe(2);
	expect(start).toHaveBeenLastCalledWith('chains', randomStart);
}, 30000);
