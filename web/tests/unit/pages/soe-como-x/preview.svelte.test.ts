import axe from 'axe-core';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { neutralCurve } from '#lib/state/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import Preview from '#lib/components/pages/soe-como-x/Preview.svelte';

let engine: AudioEngine | null = null;
afterEach(async () => {
	await cleanup();
	await engine?.dispose();
	engine = null;
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

test('real A/B meters and spectrum are gesture-started and release on unmount', async () => {
	engine = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
	const audio = engine;
	const createAB = vi.spyOn(audio, 'createAB');
	const curve = neutralCurve();
	const screen = await render(Preview, { audio, current: curve, candidate: curve });
	expect(audio.state().playing).toBe(false);
	expect(screen.container.querySelector('canvas')?.getAttribute('data-mode')).toBe('data');
	expect(screen.container.querySelectorAll('.idle-vu')).toHaveLength(2);
	expect(screen.container.querySelector('[role="meter"]')).toBeNull();
	expect(screen.container.querySelector('[role="img"][aria-valuetext]')).toBeNull();
	await expect
		.element(page.getByRole('img', { name: `A / VU: ${m.meter_no_data()}`, exact: true }))
		.toBeVisible();
	await expect
		.element(page.getByRole('img', { name: `B / VU: ${m.meter_no_data()}`, exact: true }))
		.toBeVisible();
	await accessible(screen.container);
	await page.getByRole('button', { name: m.soe_listen(), exact: true }).click();
	await expect.poll(() => audio.state().playing).toBe(true);
	await expect.element(page.getByRole('meter', { name: 'B / VU', exact: true })).toBeVisible();
	await expect
		.poll(() => screen.container.querySelector('canvas')?.getAttribute('data-mode'))
		.toBe('live');
	await page.getByRole('button', { name: m.soe_current(), exact: true }).click();
	await expect.element(page.getByRole('meter', { name: 'A / VU', exact: true })).toBeVisible();
	await accessible(screen.container);
	await page.getByRole('button', { name: m.soe_stop_preview(), exact: true }).click();
	expect(audio.state().playing).toBe(false);
	await expect
		.poll(() => screen.container.querySelector('canvas')?.getAttribute('data-mode'))
		.toBe('data');
	expect(screen.container.querySelectorAll('.idle-vu')).toHaveLength(2);
	expect(screen.container.querySelector('[role="meter"]')).toBeNull();
	await accessible(screen.container);
	await page.getByRole('button', { name: m.soe_listen(), exact: true }).click();
	await expect.poll(() => audio.state().playing).toBe(true);
	const created = createAB.mock.results.at(-1);
	if (!created || created.type !== 'return') throw new Error('Missing preview');
	const preview = created.value;
	await cleanup();
	expect(audio.getChainOutput(preview.a.id)).toBeNull();
	expect(audio.getChainOutput(preview.b.id)).toBeNull();
	// This preview started chain mode, so leaving the page stops it (the engine is not disposed).
	expect(audio.state().playing).toBe(false);
	expect(audio.state().ready).toBe(true);
}, 20000);

test('unmount stops the engine only when this preview started it', async () => {
	engine = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
	const audio = engine;
	const stop = vi.spyOn(audio, 'stop');
	const curve = neutralCurve();
	// Another page (or the chrome) left the engine playing: mounting/unmounting never touches it.
	const state = vi
		.spyOn(audio, 'state')
		.mockReturnValue({ ...audio.state(), mode: 'raw', playing: true });
	await render(Preview, { audio, current: curve, candidate: curve });
	await cleanup();
	expect(stop).not.toHaveBeenCalled();
	state.mockRestore();

	await render(Preview, { audio, current: curve, candidate: curve });
	await page.getByRole('button', { name: m.soe_listen(), exact: true }).click();
	await expect.poll(() => audio.state().mode).toBe('chains');
	await cleanup();
	expect(stop).toHaveBeenCalledOnce();
	expect(audio.state().playing).toBe(false);
}, 20000);

test('unmount while the engine is still starting leaves nothing playing', async () => {
	engine = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
	const audio = engine;
	const realStart = audio.start.bind(audio);
	let release: (() => void) | undefined;
	vi.spyOn(audio, 'start').mockImplementationOnce(async (mode) => {
		await new Promise<void>((resolve) => (release = resolve));
		await realStart(mode);
	});
	const curve = neutralCurve();
	await render(Preview, { audio, current: curve, candidate: curve });
	await page.getByRole('button', { name: m.soe_listen(), exact: true }).click();
	await expect.poll(() => release).toBeDefined();
	await cleanup();
	release?.();
	await expect.poll(() => audio.state().playing).toBe(false);
	expect(audio.state().mode).toBe('off');
}, 20000);

async function accessible(container: HTMLElement) {
	const { violations } = await axe.run(container);
	const blocking = violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
	expect(blocking).toEqual([]);
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`preview disables missing inputs and reports a rejected audio start in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const curve = neutralCurve();
		const screen = await render(Preview, { audio: null, current: null, candidate: curve });
		await expect
			.element(page.getByRole('button', { name: m.soe_listen() }))
			.toHaveAttribute('aria-disabled', 'true');
		await page.getByRole('button', { name: m.soe_current() }).click();
		await expect
			.element(page.getByRole('button', { name: m.soe_current() }))
			.toHaveAttribute('aria-pressed', 'true');
		await page.getByRole('button', { name: m.soe_candidate() }).click();
		engine = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
		vi.spyOn(engine, 'start').mockRejectedValueOnce(new Error('audio start refused'));
		const createAB = vi.spyOn(engine, 'createAB');
		await screen.rerender({ audio: engine, current: curve });
		await page.getByRole('button', { name: m.soe_listen() }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent(m.soe_audio_error());
		await expect
			.element(page.getByRole('button', { name: m.soe_listen() }))
			.not.toHaveAttribute('aria-disabled');
		expect(screen.container.querySelector('[role="meter"]')).toBeNull();
		const created = createAB.mock.results[0];
		if (created.type !== 'return') throw new Error('Missing preview snapshot');
		expect(engine.getChainOutput(created.value.a.id)).toBeNull();
		expect(engine.getChainOutput(created.value.b.id)).toBeNull();
	});
}

test('missing preview chain is reported rather than starting or retaining audio', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	engine = createAudioEngine({ indexedDB: null });
	vi.spyOn(engine, 'getChainOutput').mockReturnValue(null);
	const start = vi.spyOn(engine, 'start');
	const curve = neutralCurve();
	await render(Preview, { audio: engine, current: curve, candidate: curve });
	await page.getByRole('button', { name: m.soe_listen() }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.soe_audio_error());
	expect(start).not.toHaveBeenCalled();
});
