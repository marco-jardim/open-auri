import axe from 'axe-core';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { neutralCurve } from '#lib/state/model.ts';
import { m } from '#lib/paraglide/messages.js';
import Preview from '#lib/components/pages/soe-como-x/Preview.svelte';

let engine: AudioEngine | null = null;
afterEach(async () => {
	await cleanup();
	await engine?.dispose();
	engine = null;
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
	// Unmount must not stop or dispose the engine shared with the chrome and other pages.
	expect(audio.state().playing).toBe(true);
}, 20000);

async function accessible(container: HTMLElement) {
	const { violations } = await axe.run(container);
	const blocking = violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
	expect(blocking).toEqual([]);
}
