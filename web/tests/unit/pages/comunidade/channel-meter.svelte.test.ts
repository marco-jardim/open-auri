import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import ChannelMeter from '#lib/components/pages/comunidade/ChannelMeter.svelte';
import type { MeterTap, MeterUpdate } from '#lib/audio/meters.ts';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { m } from '#lib/paraglide/messages.js';
import { fakeEnv } from '../../audio/fake-audio.ts';

const engines: AudioEngine[] = [];
function fixture() {
	const audio = createAudioEngine(fakeEnv(null).env);
	engines.push(audio);
	const chain = audio.buildChain([], 0);
	let deliver: (update: MeterUpdate) => void = () => undefined;
	const unsubscribe = vi.fn();
	const meter: MeterTap = {
		node: chain.output as unknown as AudioWorkletNode,
		source: chain.output,
		kinds: ['ppm'],
		current: () => ({ mode: 'data', frame: null }),
		subscribe: vi.fn((callback) => {
			deliver = callback;
			return unsubscribe;
		}),
		setReference: vi.fn(),
		setPpmType: vi.fn(),
		reset: vi.fn(),
		disconnect: vi.fn()
	};
	return { chain, meter, unsubscribe, emit: (update: MeterUpdate) => deliver(update) };
}
afterEach(async () => {
	await cleanup();
	await Promise.all(engines.splice(0).map((audio) => audio.dispose()));
	vi.restoreAllMocks();
});

test('no chain means no tap, LEDs or error', async () => {
	const tap = vi.fn();
	await render(ChannelMeter, { label: 'Canal', tap });
	expect(tap).not.toHaveBeenCalled();
	expect(document.querySelector('[data-testid="channel-leds"]')).toBeNull();
	expect(document.querySelector('.meter-error')).toBeNull();
});

test('real frames use the louder stereo channel, data and missing frames stay dark, cleanup detaches', async () => {
	const { chain, meter, emit, unsubscribe } = fixture();
	const tap = vi.fn(async () => meter);
	const screen = await render(ChannelMeter, { chain, label: 'Canal', tap });
	await expect.poll(() => meter.subscribe).toHaveBeenCalledOnce();
	expect(tap).toHaveBeenCalledExactlyOnceWith(chain.output, { kinds: ['ppm'] });
	expect(document.querySelector('.oa-leds')?.getAttribute('data-dark')).toBe('true');
	emit({
		mode: 'live',
		frame: {
			ppmL: -20,
			ppmR: 0,
			vuL: 0,
			vuR: 0,
			truePeakDb: 0,
			lufsM: -20,
			lufsS: -20,
			correlation: 1,
			active: true
		}
	});
	await expect
		.element(page.getByRole('meter', { name: 'Canal' }))
		.toHaveAttribute('aria-valuenow', '0');
	emit({ mode: 'live', frame: null });
	await expect
		.poll(() => document.querySelector('.oa-leds')?.getAttribute('data-dark'))
		.toBe('true');
	emit({ mode: 'data', frame: null });
	await expect
		.poll(() => document.querySelector('.oa-leds')?.getAttribute('data-mode'))
		.toBe('data');
	await screen.rerender({ chain: null });
	expect(unsubscribe).toHaveBeenCalledOnce();
	expect(meter.disconnect).toHaveBeenCalledOnce();
	expect(document.querySelector('[data-testid="channel-leds"]')).toBeNull();
});

test.each([new Error('worklet'), 'unavailable'])(
	'tap rejection displays a notice, not pretend LEDs (%s)',
	async (error) => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { chain } = fixture();
		await render(ChannelMeter, { chain, label: 'Canal', tap: vi.fn().mockRejectedValue(error) });
		await expect.element(page.getByText(m.comunidade_meter_error())).toBeVisible();
		expect(document.querySelector('[data-testid="channel-leds"]')).toBeNull();
	}
);

test('a tap resolving after removal disconnects without subscribing', async () => {
	const { chain, meter } = fixture();
	let resolve: (meter: MeterTap) => void = () => undefined;
	const pending = new Promise<MeterTap>((done) => {
		resolve = done;
	});
	const screen = await render(ChannelMeter, { chain, label: 'Canal', tap: () => pending });
	await screen.rerender({ chain: null });
	resolve(meter);
	await expect.poll(() => meter.disconnect).toHaveBeenCalledOnce();
	expect(meter.subscribe).not.toHaveBeenCalled();
	expect(document.querySelector('.meter-error')).toBeNull();
});

test('a tap rejecting after removal cannot leave a stale error', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const { chain } = fixture();
	let reject: (error: Error) => void = () => undefined;
	const pending = new Promise<MeterTap>((_resolve, fail) => {
		reject = fail;
	});
	const screen = await render(ChannelMeter, { chain, label: 'Canal', tap: () => pending });
	await screen.rerender({ chain: null });
	reject(new Error('late'));
	await expect.poll(() => console.warn).toHaveBeenCalled();
	expect(document.querySelector('.meter-error')).toBeNull();
});
