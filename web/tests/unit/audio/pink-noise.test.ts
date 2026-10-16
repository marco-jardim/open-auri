import { describe, expect, it } from 'vitest';
import {
	PINK_NOISE_PEAK,
	PINK_NOISE_SECONDS,
	createPinkNoiseBuffer,
	createPinkNoiseSource,
	fillPinkNoise
} from '#lib/audio/pink-noise.ts';
import { FakeAudioContext, resetAudioConfig } from './fake-audio.ts';

/** Deterministic uniform generator (mulberry32). */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Mean power of a one-pole-smoothed band, as a cheap spectral tilt probe. */
function lowHighPowerRatio(data: Float32Array): number {
	let low = 0;
	let high = 0;
	let previous = 0;
	let smooth = 0;
	for (const sample of data) {
		smooth = 0.995 * smooth + 0.005 * sample;
		const difference = sample - previous;
		previous = sample;
		low += smooth * smooth;
		high += difference * difference;
	}
	return low / high;
}

describe('pink noise', () => {
	it('is peak-normalised and finite', () => {
		const data = fillPinkNoise(new Float32Array(48000), seeded(1));
		let peak = 0;
		for (const sample of data) {
			expect(Number.isFinite(sample)).toBe(true);
			peak = Math.max(peak, Math.abs(sample));
		}
		expect(peak).toBeCloseTo(PINK_NOISE_PEAK, 6);
	});

	it('has more low-frequency energy than white noise', () => {
		const random = seeded(7);
		const pink = fillPinkNoise(new Float32Array(96000), seeded(7));
		const white = new Float32Array(96000).map(() => random() * 2 - 1);
		expect(lowHighPowerRatio(pink)).toBeGreaterThan(lowHighPowerRatio(white) * 4);
	});

	it('loops without a jump at the seam', () => {
		const data = fillPinkNoise(new Float32Array(20000), seeded(3));
		const steps: number[] = [];
		for (let i = 1; i < data.length; i++) steps.push(Math.abs((data[i] ?? 0) - (data[i - 1] ?? 0)));
		const typical = steps.reduce((sum, step) => sum + step, 0) / steps.length;
		const seam = Math.abs((data[0] ?? 0) - (data[data.length - 1] ?? 0));
		expect(seam).toBeLessThan(typical * 6);
	});

	it('handles an empty buffer', () => {
		expect(fillPinkNoise(new Float32Array(0))).toHaveLength(0);
	});

	it('builds a looping mono buffer source at the context rate', () => {
		resetAudioConfig();
		const context = new FakeAudioContext({ sampleRate: 96000 });
		const asContext = context as unknown as BaseAudioContext;
		const buffer = createPinkNoiseBuffer(asContext, PINK_NOISE_SECONDS, seeded(5));
		expect(buffer.sampleRate).toBe(96000);
		expect(buffer.numberOfChannels).toBe(1);
		expect(buffer.length).toBe(96000 * PINK_NOISE_SECONDS);
		const source = createPinkNoiseSource(asContext, buffer);
		expect(source.loop).toBe(true);
		expect(source.buffer).toBe(buffer);
		expect(context.bufferSources).toHaveLength(1);
	});
});
