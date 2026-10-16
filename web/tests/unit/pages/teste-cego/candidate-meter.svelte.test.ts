import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import CandidateMeter from '#lib/components/pages/teste-cego/CandidateMeter.svelte';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { neutralCurve } from '#lib/state/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';

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
	fakeTap.mockReset();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

function chain() {
	audio = createAudioEngine({ indexedDB: null });
	const curve = neutralCurve();
	return audio.buildChain(curve.bands, curve.preampDb);
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`failed candidate taps stay dark and show a localized explanation in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		fakeTap.mockRejectedValueOnce(new Error('worklet refused'));
		const screen = await render(CandidateMeter, {
			chain: chain(),
			enabled: true,
			label: 'Position'
		});
		await expect.element(page.getByText(m.cego_meter_error(), { exact: true })).toBeVisible();
		expect(screen.container.querySelector('meter')).toBeNull();
		await expect
			.element(page.getByRole('img', { name: `Position: ${m.meter_no_data()}` }))
			.toBeVisible();
	});
}

test('disabling a live candidate unsubscribes and clears its actual peak reading', async () => {
	const disconnect = vi.fn();
	const unsubscribe = vi.fn();
	fakeTap.mockResolvedValue({
		disconnect,
		subscribe: (listener: (value: unknown) => void) => {
			listener({
				mode: 'live',
				frame: {
					active: true,
					vuL: -10,
					vuR: -11,
					ppmL: -9,
					ppmR: -8,
					truePeakDb: -7,
					lufsM: -18,
					lufsS: -18,
					correlation: 1
				}
			});
			return unsubscribe;
		}
	});
	const screen = await render(CandidateMeter, { chain: chain(), enabled: true, label: 'Position' });
	await expect
		.element(page.getByRole('meter', { name: 'Position' }))
		.toHaveAttribute('value', '-8');
	await screen.rerender({ enabled: false });
	expect(disconnect).toHaveBeenCalledOnce();
	expect(unsubscribe).toHaveBeenCalledOnce();
	expect(screen.container.querySelector('meter')).toBeNull();
	await expect
		.element(page.getByRole('img', { name: `Position: ${m.meter_no_data()}` }))
		.toBeVisible();
});

test('a tap resolving after unmount is disconnected without subscribing', async () => {
	let finish: ((value: unknown) => void) | undefined;
	fakeTap.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
	await render(CandidateMeter, { chain: chain(), enabled: true, label: 'Position' });
	await expect.poll(() => fakeTap.mock.calls.length).toBe(1);
	await cleanup();
	const disconnect = vi.fn();
	const subscribe = vi.fn();
	finish?.({ disconnect, subscribe });
	await tick();
	expect(disconnect).toHaveBeenCalledOnce();
	expect(subscribe).not.toHaveBeenCalled();
});
