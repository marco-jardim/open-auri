import { expect, test } from 'vitest';
import { fillPinkNoise, PINK_NOISE_PEAK } from '#lib/audio/pink-noise.ts';

test('empty and zero-energy noise remain finite without attempting to normalize silence', () => {
	const empty = new Float32Array();
	expect(fillPinkNoise(empty)).toBe(empty);
	const silent = new Float32Array(16);
	expect(fillPinkNoise(silent, () => 0.5)).toBe(silent);
	expect([...silent]).toEqual(new Array<number>(16).fill(0));
});

test('buffers shorter than the seam still normalize safely', () => {
	for (const size of [1, 2, 3]) {
		const samples = fillPinkNoise(new Float32Array(size), () => 0.75);
		expect([...samples].every(Number.isFinite)).toBe(true);
		expect(Math.max(...samples.map(Math.abs))).toBeCloseTo(PINK_NOISE_PEAK);
	}
});
