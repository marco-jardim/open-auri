import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import Preview from '#lib/components/pages/soe-como-x/Preview.svelte';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import type { MeterUpdate } from '#lib/audio/meters.ts';
import { neutralCurve } from '#lib/state/model.ts';
import { m } from '#lib/paraglide/messages.js';
import PreviewReferenceHarness from './PreviewReferenceHarness.svelte';

const { fakeTap } = vi.hoisted(() => ({ fakeTap: vi.fn() }));
vi.mock('#lib/audio/meters.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/audio/meters.ts')>()),
	tap: fakeTap
}));

let audio: AudioEngine | null = null;
afterEach(async () => {
	await cleanup();
	await audio?.dispose();
	audio = null;
	vi.restoreAllMocks();
	fakeTap.mockReset();
});

function meter() {
	return {
		disconnect: vi.fn(),
		setReference: vi.fn(),
		subscribe: vi.fn((listener: (update: MeterUpdate) => void) => {
			listener({ mode: 'data', frame: null });
			return vi.fn();
		})
	};
}

async function setup() {
	audio = createAudioEngine({ indexedDB: null });
	const start = vi.spyOn(audio, 'start').mockResolvedValue(undefined);
	const curve = neutralCurve();
	const screen = await render(Preview, { audio, current: curve, candidate: curve });
	return { screen, start };
}

test('changing the candidate during audio start does not attach taps to the old graph', async () => {
	const { screen, start } = await setup();
	let finish: (() => void) | undefined;
	start.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
	await page.getByRole('button', { name: m.soe_listen(), exact: true }).click();
	await screen.rerender({ candidate: { ...neutralCurve(), preampDb: -1 } });
	finish?.();
	await tick();
	expect(fakeTap).not.toHaveBeenCalled();
	await expect.element(page.getByRole('button', { name: m.soe_listen() })).toBeEnabled();
});

for (const pendingSide of ['first', 'second'] as const) {
	test(`a late ${pendingSide} VU tap disconnects instead of reviving an obsolete preview`, async () => {
		const { screen } = await setup();
		const first = meter();
		const late = meter();
		if (pendingSide === 'second') fakeTap.mockResolvedValueOnce(first);
		let finish: ((value: ReturnType<typeof meter>) => void) | undefined;
		fakeTap.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		await page.getByRole('button', { name: m.soe_listen(), exact: true }).click();
		await expect.poll(() => fakeTap.mock.calls.length).toBe(pendingSide === 'first' ? 1 : 2);
		await screen.rerender({ current: { ...neutralCurve(), preampDb: -1 } });
		finish?.(late);
		await tick();
		expect(late.disconnect).toHaveBeenCalledOnce();
		expect(late.subscribe).not.toHaveBeenCalled();
		if (pendingSide === 'second') expect(first.disconnect).toHaveBeenCalledOnce();
		await expect.element(page.getByRole('button', { name: m.soe_listen() })).toBeEnabled();
		expect(screen.container.querySelector('[role="meter"]')).toBeNull();
	});
}

test('tap failure from an obsolete audition cannot overwrite the new idle preview with an error', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const { screen } = await setup();
	let fail: ((cause: Error) => void) | undefined;
	fakeTap.mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				fail = reject;
			})
	);
	await page.getByRole('button', { name: m.soe_listen(), exact: true }).click();
	await expect.poll(() => fakeTap.mock.calls.length).toBe(1);
	await screen.rerender({ candidate: { ...neutralCurve(), preampDb: -1 } });
	fail?.(new Error('old worklet rejected'));
	await tick();
	await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
	await expect.element(page.getByRole('button', { name: m.soe_listen() })).toBeEnabled();
});

test('changing the VU reference updates both existing taps without starting another audition', async () => {
	const first = meter();
	const second = meter();
	fakeTap.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
	audio = createAudioEngine({ indexedDB: null });
	const start = vi.spyOn(audio, 'start').mockResolvedValue(undefined);
	const curve = neutralCurve();
	await render(PreviewReferenceHarness, { audio, current: curve, candidate: curve });
	await page.getByRole('button', { name: m.soe_listen(), exact: true }).click();
	await expect.poll(() => second.subscribe.mock.calls.length).toBe(1);
	// Change an independent parent signal, not the test library's shared props object:
	// rerender would also invalidate the snapshot effect that watches audio/current/candidate.
	await page.getByRole('button', { name: 'Set VU reference to −14', exact: true }).click();
	expect(first.setReference).toHaveBeenCalledWith(-14);
	expect(second.setReference).toHaveBeenCalledWith(-14);
	expect(first.disconnect).not.toHaveBeenCalled();
	expect(second.disconnect).not.toHaveBeenCalled();
	expect(fakeTap).toHaveBeenCalledTimes(2);
	expect(start).toHaveBeenCalledOnce();
	await page.getByRole('button', { name: m.soe_stop_preview(), exact: true }).click();
	expect(first.disconnect).toHaveBeenCalledOnce();
	expect(second.disconnect).toHaveBeenCalledOnce();
});
