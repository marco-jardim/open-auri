import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	LIVE_WINDOW_MS,
	getReference,
	loadMeterWorklet,
	parseFrame,
	setReference,
	tap,
	tapStages,
	type FrameScheduler,
	type MeterFrame,
	type MeterUpdate
} from '#lib/audio/meters.ts';

const MODULE_URL = '/fake/meter-processor.js';

class FakeScheduler implements FrameScheduler {
	time = 0;
	#next = 1;
	pending = new Map<number, () => void>();
	now(): number {
		return this.time;
	}
	request(callback: () => void): number {
		const handle = this.#next++;
		this.pending.set(handle, callback);
		return handle;
	}
	cancel(handle: number): void {
		this.pending.delete(handle);
	}
	flush(): void {
		const callbacks = [...this.pending.values()];
		this.pending.clear();
		for (const callback of callbacks) callback();
	}
}

class FakePort {
	onmessage: ((event: MessageEvent) => void) | null = null;
	postMessage = vi.fn();
	close = vi.fn();
	emit(data: unknown): void {
		this.onmessage?.({ data } as MessageEvent);
	}
}

const created: FakeWorkletNode[] = [];

class FakeWorkletNode {
	port = new FakePort();
	readonly context: unknown;
	readonly name: string;
	readonly options: AudioWorkletNodeOptions;
	constructor(context: unknown, name: string, options: AudioWorkletNodeOptions) {
		this.context = context;
		this.name = name;
		this.options = options;
		created.push(this);
	}
}

function fakeContext(addModule = vi.fn(async () => undefined)) {
	return { audioWorklet: { addModule } };
}

function fakeNode(context: unknown) {
	return { context, connect: vi.fn(), disconnect: vi.fn() };
}

function asNode(node: ReturnType<typeof fakeNode>): AudioNode {
	return node as unknown as AudioNode;
}

const ACTIVE: MeterFrame = {
	vuL: 0,
	vuR: -1,
	ppmL: -18,
	ppmR: -19,
	truePeakDb: -17.8,
	lufsM: -18,
	lufsS: -18.5,
	correlation: 1,
	active: true
};

beforeEach(() => {
	created.length = 0;
	vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
});

afterEach(() => {
	setReference(-18);
	vi.unstubAllGlobals();
});

describe('tap', () => {
	test('loads the worklet once per context and connects in parallel with no outputs', async () => {
		const context = fakeContext();
		const source = fakeNode(context);
		const first = await tap(asNode(source), { moduleUrl: MODULE_URL, kinds: ['vu'] });
		await tap(asNode(source), { moduleUrl: MODULE_URL });
		expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(1);
		expect(context.audioWorklet.addModule).toHaveBeenCalledWith(MODULE_URL);
		expect(created).toHaveLength(2);
		expect(created[0].name).toBe('oa-meter');
		expect(created[0].options.numberOfOutputs).toBe(0);
		expect(created[0].options.processorOptions).toEqual({
			kinds: ['vu'],
			reference: -18,
			ppmType: 'II'
		});
		expect(source.connect).toHaveBeenCalledWith(created[0]);
		expect(first.kinds).toEqual(['vu']);
	});

	test('a failed module load can be retried', async () => {
		const addModule = vi
			.fn<() => Promise<undefined>>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValue(undefined);
		const context = fakeContext(addModule) as unknown as BaseAudioContext;
		await expect(loadMeterWorklet(context, MODULE_URL)).rejects.toThrow('offline');
		await expect(loadMeterWorklet(context, MODULE_URL)).resolves.toBeUndefined();
		expect(addModule).toHaveBeenCalledTimes(2);
	});

	test('mode is live within 250 ms of an active frame, then data', async () => {
		const scheduler = new FakeScheduler();
		const context = fakeContext();
		const handle = await tap(asNode(fakeNode(context)), { moduleUrl: MODULE_URL, scheduler });
		const updates: MeterUpdate[] = [];
		handle.subscribe((update) => updates.push(update));
		expect(updates).toEqual([{ frame: null, mode: 'data' }]);

		created[0].port.emit(ACTIVE);
		expect(updates).toHaveLength(1);
		scheduler.flush();
		expect(updates.at(-1)).toEqual({ frame: ACTIVE, mode: 'live' });

		// No new frame: the next animation frame delivers nothing.
		scheduler.time = 100;
		scheduler.flush();
		expect(updates).toHaveLength(2);

		scheduler.time = LIVE_WINDOW_MS + 1;
		scheduler.flush();
		expect(updates.at(-1)).toEqual({ frame: null, mode: 'data' });
		// Idle taps stop requesting animation frames.
		expect(scheduler.pending.size).toBe(0);
	});

	test('inactive frames do not make the tap live; invalid messages are ignored', async () => {
		const scheduler = new FakeScheduler();
		const options = { moduleUrl: MODULE_URL, scheduler };
		const handle = await tap(asNode(fakeNode(fakeContext())), options);
		const updates: MeterUpdate[] = [];
		handle.subscribe((update) => updates.push(update));
		created[0].port.emit({ ...ACTIVE, active: false });
		created[0].port.emit({ nope: true });
		scheduler.flush();
		expect(updates.every((update) => update.mode === 'data')).toBe(true);
		expect(handle.current()).toEqual({ frame: null, mode: 'data' });
	});

	test('unsubscribe cancels the pending animation frame', async () => {
		const scheduler = new FakeScheduler();
		const options = { moduleUrl: MODULE_URL, scheduler };
		const handle = await tap(asNode(fakeNode(fakeContext())), options);
		const listener = vi.fn();
		const unsubscribe = handle.subscribe(listener);
		created[0].port.emit(ACTIVE);
		expect(scheduler.pending.size).toBe(1);
		unsubscribe();
		expect(scheduler.pending.size).toBe(0);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	test('setReference reaches every tap and later taps', async () => {
		const context = fakeContext();
		const a = await tap(asNode(fakeNode(context)), { moduleUrl: MODULE_URL });
		await tap(asNode(fakeNode(context)), { moduleUrl: MODULE_URL });
		setReference(-20);
		expect(getReference()).toBe(-20);
		for (const node of created) {
			expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'reference', value: -20 });
		}
		await tap(asNode(fakeNode(context)), { moduleUrl: MODULE_URL });
		expect(created[2].options.processorOptions).toMatchObject({ reference: -20 });
		a.setPpmType('I');
		expect(created[0].port.postMessage).toHaveBeenCalledWith({ type: 'ppmType', value: 'I' });
		a.reset();
		expect(created[0].port.postMessage).toHaveBeenCalledWith({ type: 'reset' });
		const invalid: number = -12;
		expect(() => setReference(invalid as -18)).toThrow(RangeError);
	});

	test('disconnect detaches the tap', async () => {
		const context = fakeContext();
		const source = fakeNode(context);
		const handle = await tap(asNode(source), { moduleUrl: MODULE_URL });
		handle.disconnect();
		expect(source.disconnect).toHaveBeenCalledWith(created[0]);
		expect(created[0].port.close).toHaveBeenCalled();
		setReference(-14);
		expect(created[0].port.postMessage).not.toHaveBeenCalled();
	});

	test('tapStages makes one stage tap per node', async () => {
		const context = fakeContext();
		const nodes = [fakeNode(context), fakeNode(context), fakeNode(context)];
		const taps = await tapStages(nodes.map(asNode), { moduleUrl: MODULE_URL });
		expect(taps).toHaveLength(3);
		nodes.forEach((node, index) => expect(node.connect).toHaveBeenCalledWith(created[index]));
		expect(created[0].options.processorOptions).toMatchObject({ kinds: ['ppm', 'truePeak'] });
	});
});

describe('parseFrame', () => {
	test('accepts a complete frame and rejects anything else', () => {
		expect(parseFrame(ACTIVE)).toEqual(ACTIVE);
		expect(parseFrame(null)).toBeNull();
		expect(parseFrame({ ...ACTIVE, active: 1 })).toBeNull();
		expect(parseFrame({ ...ACTIVE, vuL: Number.NaN })).toBeNull();
		expect(parseFrame({ ...ACTIVE, lufsS: undefined })).toBeNull();
	});
});
