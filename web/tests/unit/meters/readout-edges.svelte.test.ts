import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import LoudnessReadout from '#lib/components/meters/LoudnessReadout.svelte';
import SpectrumOverlay from '#lib/components/meters/SpectrumOverlay.svelte';
import VuMeter from '#lib/components/meters/VuMeter.svelte';
import { m } from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import { formatSigned } from '#lib/components/meters/format.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function lufs(reading: number) {
	return m.meter_value_lufs({ value: formatSigned(reading, 1, getLocale()) });
}

test('partial loudness data distinguishes absent readings from silence and includes the exact gate', async () => {
	const screen = await render(LoudnessReadout, {
		mode: 'data',
		data: { lufsM: -71 },
		label: 'Measured loudness',
		class: 'rack-loudness'
	});
	await expect
		.element(page.getByRole('group', { name: 'Measured loudness' }))
		.toHaveAttribute('data-dark', 'false');
	await expect.element(page.getByTestId('lufs-m')).toHaveTextContent(m.meter_no_signal());
	await expect.element(page.getByTestId('lufs-s')).toHaveTextContent(m.meter_no_data());
	await screen.rerender({ data: { lufsM: -70, lufsS: -18 } });
	await expect.element(page.getByTestId('lufs-m')).toHaveTextContent(lufs(-70));
	await expect.element(page.getByTestId('lufs-s')).toHaveTextContent(lufs(-18));
	await screen.rerender({ mode: 'live', live: { lufsM: NaN, lufsS: -Infinity } });
	await expect.element(page.getByRole('group')).toHaveAttribute('data-dark', 'true');
	await expect.element(page.getByTestId('lufs-m')).toHaveTextContent(m.meter_no_data());
	await expect.element(page.getByTestId('lufs-s')).toHaveTextContent(m.meter_no_data());
});

test('VU accessibility clamps out-of-range readings and removes meter values when data vanishes', async () => {
	const screen = await render(VuMeter, {
		mode: 'data',
		data: null,
		reducedMotion: true,
		label: 'Bus VU',
		class: 'rack-vu'
	});
	await expect.element(page.getByRole('img', { name: 'Bus VU' })).toHaveClass('rack-vu');
	await expect.element(page.getByTestId('vu-readout')).toHaveTextContent(m.meter_no_data());
	await screen.rerender({ data: -99 });
	await expect.element(page.getByRole('meter')).toHaveAttribute('aria-valuenow', '-20');
	await screen.rerender({ data: 10 });
	await expect.element(page.getByRole('meter')).toHaveAttribute('aria-valuenow', '3');
	await screen.rerender({ reducedMotion: false });
	expect(screen.container.querySelector('.oa-vu-needle')).not.toBeNull();
	await screen.rerender({ data: null });
	await expect
		.element(page.getByRole('img', { name: 'Bus VU' }))
		.not.toHaveAttribute('aria-valuenow');
	expect(screen.container.querySelector('.oa-vu-needle')).toBeNull();
});

test('reduced-motion spectrum samples at 10 Hz and cancels sampling when switched to data mode', async () => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	const sample = vi.fn((bins: Float32Array) => {
		bins.fill(-60);
	});
	const analyser = {
		context: { sampleRate: 48000 },
		fftSize: 16,
		frequencyBinCount: 8,
		getFloatFrequencyData: sample
	} as unknown as AnalyserNode;
	const screen = await render(SpectrumOverlay, {
		mode: 'live',
		analyser,
		reducedMotion: true,
		width: 120,
		height: 80,
		minHz: 5000,
		maxHz: 15000,
		minDb: -80,
		maxDb: -30,
		label: 'Bus spectrum',
		class: 'rack-spectrum'
	});
	await expect.element(page.getByRole('img')).toHaveAccessibleName('Bus spectrum');
	expect(sample).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(99);
	expect(sample).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(1);
	expect(sample).toHaveBeenCalledTimes(2);
	await screen.rerender({ mode: 'data' });
	await expect.element(page.getByRole('img')).toHaveAccessibleName(m.meter_spectrum_idle());
	await vi.advanceTimersByTimeAsync(1000);
	expect(sample).toHaveBeenCalledTimes(2);
});

test('spectrum tolerates a browser without a 2D context without scheduling frames', async () => {
	const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
	const sample = vi.fn();
	const analyser = { getFloatFrequencyData: sample } as unknown as AnalyserNode;
	await render(SpectrumOverlay, { mode: 'live', analyser, reducedMotion: true });
	expect(context).toHaveBeenCalledWith('2d');
	expect(sample).not.toHaveBeenCalled();
});
