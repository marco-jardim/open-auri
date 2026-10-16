import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Deterministic PCM fixtures: 3 s, 48 kHz, stereo, signed 16-bit little-endian.
 * dBFS denotes sine peak amplitude (not RMS); both channels contain the same samples.
 * @param {{ frequency?: number, dbfs?: number, silence?: boolean }} [options]
 */
export function createWav({ frequency = 440, dbfs = -18, silence = false } = {}) {
	const sampleRate = 48000;
	const channels = 2;
	const frames = sampleRate * 3;
	const dataBytes = frames * channels * 2;
	const wav = Buffer.alloc(44 + dataBytes);
	wav.write('RIFF', 0, 'ascii');
	wav.writeUInt32LE(36 + dataBytes, 4);
	wav.write('WAVEfmt ', 8, 'ascii');
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(channels, 22);
	wav.writeUInt32LE(sampleRate, 24);
	wav.writeUInt32LE(sampleRate * channels * 2, 28);
	wav.writeUInt16LE(channels * 2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write('data', 36, 'ascii');
	wav.writeUInt32LE(dataBytes, 40);
	const amplitude = silence ? 0 : 10 ** (dbfs / 20);
	for (let frame = 0; frame < frames; frame++) {
		const sample = Math.round(
			32767 * amplitude * Math.sin((2 * Math.PI * frequency * frame) / sampleRate)
		);
		for (let channel = 0; channel < channels; channel++) {
			wav.writeInt16LE(sample, 44 + (frame * channels + channel) * 2);
		}
	}
	return wav;
}

/** Run with `node web/scripts/gen-fixtures.mjs`; paths do not depend on the working directory. */
export async function generateFixtures() {
	const directory = new URL('../tests/fixtures/', import.meta.url);
	await mkdir(directory, { recursive: true });
	/** @type {[string, Buffer][]} */
	const fixtures = [
		['sine-440hz-minus18dbfs.wav', createWav()],
		['sine-1000hz-minus18dbfs.wav', createWav({ frequency: 1000 })],
		['silence.wav', createWav({ silence: true })]
	];
	for (const [name, wav] of fixtures) {
		await writeFile(new URL(name, directory), wav);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await generateFixtures();
}
