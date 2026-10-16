import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
	ACTIVE_AMPLITUDE,
	FRAME_KEYS,
	METER_KINDS,
	METER_PROCESSOR_NAME,
	PUBLISH_HZ,
	createMeterCore,
	normalizeKinds,
	readCoreOptions,
	type MeterFrame
} from '#lib/components/meters/meter-core.js';

const SAMPLE_RATE = 48000;
const BLOCK = 128;

/** Continuous-phase sine source, filling 128-sample blocks. */
function sine(frequency: number, dbfs: number, sampleRate = SAMPLE_RATE) {
	const amplitude = 10 ** (dbfs / 20);
	const step = (2 * Math.PI * frequency) / sampleRate;
	let phase = 0;
	return {
		fill(block: Float32Array): Float32Array {
			for (let i = 0; i < block.length; i++) {
				block[i] = amplitude * Math.sin(phase);
				phase += step;
				if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
			}
			return block;
		}
	};
}

function blocksFor(seconds: number, sampleRate = SAMPLE_RATE): number {
	return Math.round((seconds * sampleRate) / BLOCK);
}

class FakePort {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	posted: unknown[] = [];
	postMessage(message: unknown): void {
		this.posted.push(message);
	}
	send(data: unknown): void {
		this.onmessage?.({ data });
	}
}

class FakeAudioWorkletProcessor {
	port = new FakePort();
}

interface ProcessorLike {
	port: FakePort;
	process(inputs: Float32Array[][]): boolean;
}

type ProcessorClass = new (options?: { processorOptions?: unknown }) => ProcessorLike;

const registry = new Map<string, ProcessorClass>();

function createProcessor(processorOptions?: unknown): ProcessorLike {
	const Processor = registry.get(METER_PROCESSOR_NAME);
	if (Processor === undefined) throw new Error('oa-meter was not registered');
	return new Processor({ processorOptions });
}

/** Runs `blocks` render quanta of a stereo (or mono) source and returns the frames posted. */
function run(
	processor: ProcessorLike,
	blocks: number,
	source: { fill(block: Float32Array): Float32Array } | null,
	channels = 2
): MeterFrame[] {
	const start = processor.port.posted.length;
	const left = new Float32Array(BLOCK);
	const right = new Float32Array(BLOCK);
	for (let b = 0; b < blocks; b++) {
		let input: Float32Array[] = [];
		if (source !== null) {
			source.fill(left);
			right.set(left);
			input = channels === 2 ? [left, right] : [left];
		}
		expect(processor.process([input])).toBe(true);
	}
	return processor.port.posted.slice(start) as MeterFrame[];
}

beforeAll(async () => {
	vi.stubGlobal('AudioWorkletProcessor', FakeAudioWorkletProcessor);
	vi.stubGlobal('registerProcessor', (name: string, processor: ProcessorClass) => {
		registry.set(name, processor);
	});
	vi.stubGlobal('sampleRate', SAMPLE_RATE);
	await import('#lib/audio/meter-processor.js');
});

afterAll(() => {
	vi.unstubAllGlobals();
});

describe('oa-meter processor (fake AudioWorklet scope)', () => {
	test('registers under the oa-meter name', () => {
		expect(registry.has('oa-meter')).toBe(true);
	});

	test('1 kHz sine at −18 dBFS reads 0 VU ± 0.1 at reference −18', () => {
		const processor = createProcessor({ reference: -18 });
		const frames = run(processor, blocksFor(2), sine(1000, -18));
		const last = frames.at(-1);
		expect(last).toBeDefined();
		if (last === undefined) return;
		expect(Math.abs(last.vuL)).toBeLessThanOrEqual(0.1);
		expect(Math.abs(last.vuR)).toBeLessThanOrEqual(0.1);
		expect(last.ppmL).toBeCloseTo(-18, 0);
		expect(last.ppmR).toBeCloseTo(-18, 0);
		expect(Math.abs(last.truePeakDb + 18)).toBeLessThan(0.3);
		expect(last.correlation).toBeCloseTo(1, 3);
		expect(last.lufsM).toBeGreaterThan(-25);
		expect(last.lufsM).toBeLessThan(-12);
		expect(last.active).toBe(true);
		expect(Object.keys(last).sort()).toEqual([...FRAME_KEYS].sort());
	});

	test('publishes at ≈ 60 Hz while there is signal', () => {
		const processor = createProcessor();
		const frames = run(processor, blocksFor(1), sine(1000, -18));
		expect(frames.length).toBeGreaterThanOrEqual(PUBLISH_HZ - 1);
		expect(frames.length).toBeLessThanOrEqual(PUBLISH_HZ + 1);
		expect(frames.every((frame) => frame.active)).toBe(true);
	});

	test('silence posts nothing beyond one inactive frame', () => {
		const fresh = createProcessor();
		expect(run(fresh, blocksFor(1), null)).toHaveLength(0);

		const processor = createProcessor();
		run(processor, blocksFor(0.5), sine(1000, -18));
		const quiet = new Float32Array(BLOCK);
		const silent = run(processor, blocksFor(1), { fill: () => quiet });
		// At most the interval still holding the tail of the tone, then exactly one inactive frame.
		expect(silent.length).toBeLessThanOrEqual(2);
		expect(silent.filter((frame) => !frame.active)).toHaveLength(1);
		expect(silent.at(-1)?.active).toBe(false);
		// Disconnected input (no channels) is silence as well.
		expect(run(processor, blocksFor(1), null)).toHaveLength(0);
		// Signal brings publishing back.
		expect(run(processor, blocksFor(0.5), sine(1000, -18)).length).toBeGreaterThan(25);
	});

	test('reference message moves the alignment without resetting the needle', () => {
		const processor = createProcessor({ reference: -18 });
		const source = sine(1000, -18);
		run(processor, blocksFor(2), source);
		processor.port.send({ type: 'reference', value: -20 });
		const after = run(processor, blocksFor(0.1), source);
		expect(Math.abs(after[0].vuL - 2)).toBeLessThan(0.15);
		const settled = run(processor, blocksFor(0.5), source).at(-1);
		expect(settled).toBeDefined();
		if (settled !== undefined) expect(Math.abs(settled.vuL - 2)).toBeLessThanOrEqual(0.1);
		processor.port.send({ type: 'reference', value: -14 });
		const fourteen = run(processor, blocksFor(0.2), source).at(-1);
		expect(fourteen).toBeDefined();
		if (fourteen !== undefined) expect(Math.abs(fourteen.vuL + 4)).toBeLessThanOrEqual(0.1);
	});

	test('mono input feeds both channels', () => {
		const processor = createProcessor();
		const last = run(processor, blocksFor(1), sine(1000, -18), 1).at(-1);
		expect(last).toBeDefined();
		if (last === undefined) return;
		expect(last.vuL).toBeCloseTo(last.vuR, 9);
		expect(last.ppmL).toBeCloseTo(last.ppmR, 9);
	});

	test('reset clears the meters and stops publishing', () => {
		const processor = createProcessor();
		run(processor, blocksFor(0.5), sine(1000, -18));
		processor.port.send({ type: 'reset' });
		expect(run(processor, blocksFor(0.5), null)).toHaveLength(0);
	});

	test('kinds restrict the meters that run', () => {
		const processor = createProcessor({ kinds: ['ppm'] });
		const last = run(processor, blocksFor(0.5), sine(1000, -18)).at(-1);
		expect(last).toBeDefined();
		if (last === undefined) return;
		expect(last.vuL).toBe(-120);
		expect(last.truePeakDb).toBe(-120);
		expect(last.lufsM).toBe(-120);
		expect(last.correlation).toBe(0);
		expect(last.ppmL).toBeCloseTo(-18, 0);
	});
});

describe('meter core (pure)', () => {
	test('publish interval is exact over time at 44.1 kHz', () => {
		const core = createMeterCore({ sampleRate: 44100 });
		expect(core.interval).toBe(735);
		const source = sine(1000, -18, 44100);
		const block = new Float32Array(BLOCK);
		let frames = 0;
		const blocks = Math.ceil(44100 / BLOCK);
		for (let b = 0; b < blocks; b++) if (core.process(source.fill(block)) !== null) frames++;
		expect(frames).toBe(60);
	});

	test('the true peak of each frame covers only its own interval', () => {
		const core = createMeterCore({ sampleRate: SAMPLE_RATE, kinds: ['truePeak'] });
		const block = new Float32Array(BLOCK);
		const loud = sine(997, -6);
		const soft = sine(997, -30);
		let last: MeterFrame | null = null;
		for (let b = 0; b < blocksFor(0.5); b++) last = core.process(loud.fill(block)) ?? last;
		expect(last?.truePeakDb ?? -120).toBeGreaterThan(-6.5);
		for (let b = 0; b < blocksFor(0.5); b++) last = core.process(soft.fill(block)) ?? last;
		expect(Math.abs((last?.truePeakDb ?? -120) + 30)).toBeLessThan(0.5);
	});

	test('reuses its preallocated reading buffer', () => {
		const core = createMeterCore({ sampleRate: SAMPLE_RATE });
		const values = core.values;
		const source = sine(1000, -18);
		const block = new Float32Array(BLOCK);
		for (let b = 0; b < blocksFor(0.2); b++) core.process(source.fill(block));
		expect(core.values).toBe(values);
		expect(values[0]).toBeGreaterThan(-120);
	});

	test('a block just below the activity threshold counts as silence', () => {
		const core = createMeterCore({ sampleRate: SAMPLE_RATE });
		const block = new Float32Array(BLOCK).fill(ACTIVE_AMPLITUDE * 0.5);
		let frames = 0;
		for (let b = 0; b < blocksFor(0.5); b++) if (core.process(block) !== null) frames++;
		expect(frames).toBe(0);
	});

	test('commands are validated', () => {
		const core = createMeterCore({ sampleRate: SAMPLE_RATE });
		expect(core.handle({ type: 'reference', value: -20 })).toBe(true);
		expect(core.reference()).toBe(-20);
		expect(core.handle({ type: 'reference', value: -12 })).toBe(false);
		expect(core.handle({ type: 'ppmType', value: 'I' })).toBe(true);
		expect(core.ppmType()).toBe('I');
		expect(core.handle({ type: 'ppmType', value: 'III' })).toBe(false);
		expect(core.handle({ type: 'unknown' })).toBe(false);
		expect(core.handle(null)).toBe(false);
		expect(core.handle({ type: 'reset' })).toBe(true);
	});

	test('options fall back to defaults', () => {
		expect(readCoreOptions(undefined)).toEqual({
			kinds: METER_KINDS,
			reference: -18,
			ppmType: 'II'
		});
		expect(readCoreOptions({ kinds: ['vu', 'nope'], reference: -14, ppmType: 'I' })).toEqual({
			kinds: ['vu'],
			reference: -14,
			ppmType: 'I'
		});
		expect(normalizeKinds([])).toBe(METER_KINDS);
		expect(() => createMeterCore({ sampleRate: SAMPLE_RATE, reference: -12 })).toThrow(RangeError);
	});
});
