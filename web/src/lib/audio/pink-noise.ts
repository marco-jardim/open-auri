/**
 * Looping pink noise for previews when no file is loaded.
 *
 * Paul Kellet's "refined" pink filter (white noise through six one-pole sections plus a direct
 * term, accurate to about ±0.05 dB above 9.2 Hz at 44.1 kHz). The buffer is a few seconds long and
 * its head is crossfaded with the samples that follow its tail, so the loop seam is continuous.
 */

/** Length of the generated loop. */
export const PINK_NOISE_SECONDS = 4;
/** Peak level of the generated buffer (−6 dBFS), leaving headroom for boosting curves. */
export const PINK_NOISE_PEAK = 0.5;

const MAX_SEAM_SAMPLES = 2048;

/**
 * Fills `out` with peak-normalised, loopable pink noise and returns it.
 * @param random Uniform generator in [0, 1); injectable for deterministic tests.
 */
export function fillPinkNoise(out: Float32Array, random: () => number = Math.random): Float32Array {
	const length = out.length;
	if (length === 0) return out;
	const seam = Math.min(Math.floor(length / 4), MAX_SEAM_SAMPLES);
	const raw = new Float32Array(length + seam);
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	let b3 = 0;
	let b4 = 0;
	let b5 = 0;
	let b6 = 0;
	for (let i = 0; i < raw.length; i++) {
		const white = random() * 2 - 1;
		b0 = 0.99886 * b0 + white * 0.0555179;
		b1 = 0.99332 * b1 + white * 0.0750759;
		b2 = 0.969 * b2 + white * 0.153852;
		b3 = 0.8665 * b3 + white * 0.3104856;
		b4 = 0.55 * b4 + white * 0.5329522;
		b5 = -0.7616 * b5 - white * 0.016898;
		raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
		b6 = white * 0.115926;
	}
	// Crossfade the head with the continuation of the tail: sample length−1 is then followed, on
	// loop, by a sample that blends into its natural successor instead of jumping.
	let peak = 0;
	for (let i = 0; i < length; i++) {
		let value = raw[i] ?? 0;
		if (i < seam) {
			const w = i / seam;
			value = value * w + (raw[length + i] ?? 0) * (1 - w);
		}
		out[i] = value;
		peak = Math.max(peak, Math.abs(value));
	}
	if (peak > 0) {
		const k = PINK_NOISE_PEAK / peak;
		for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) * k;
	}
	return out;
}

/** Mono AudioBuffer of loopable pink noise at the context's rate. */
export function createPinkNoiseBuffer(
	context: BaseAudioContext,
	seconds: number = PINK_NOISE_SECONDS,
	random?: () => number
): AudioBuffer {
	const length = Math.max(1, Math.round(context.sampleRate * seconds));
	const buffer = context.createBuffer(1, length, context.sampleRate);
	fillPinkNoise(buffer.getChannelData(0), random);
	return buffer;
}

/** Looping, not yet started source playing `buffer` (an AudioBufferSourceNode is single use). */
export function createPinkNoiseSource(
	context: BaseAudioContext,
	buffer: AudioBuffer
): AudioBufferSourceNode {
	const source = context.createBufferSource();
	source.buffer = buffer;
	source.loop = true;
	return source;
}
