/**
 * Main-thread side of live metering.
 *
 * - `tap(node, { kinds })` loads the `oa-meter` worklet once per context, creates an
 *   `AudioWorkletNode` with no outputs (it is an analysis sink: nothing is passed through and
 *   nothing reaches the destination) and connects `node` to it in parallel.
 * - `tapStages(nodes)` makes one tap per stage node (stage LEDs).
 * - Each tap's `subscribe(cb)` delivers the latest frame on `requestAnimationFrame`, with the mode:
 *   `live` while a frame with `active` arrived in the last 250 ms, `data` otherwise (then the frame
 *   is null and components show curve data or stay dark).
 * - `setReference(ref)` changes the 0 VU alignment of every tap (and of later ones).
 *
 * The worklet URL comes from `./meter-processor.js?worker&url`, which makes Vite bundle the
 * processor with the core meters (see the header of `meter-processor.js`). It is imported lazily so
 * the module also loads where that query is not available (pass `moduleUrl` there).
 * @module
 */

import type { MeterFrame, MeterKind, PpmType } from '../components/meters/meter-core.js';

export type { MeterFrame, MeterKind, PpmType };

export const METER_PROCESSOR_NAME = 'oa-meter';
export const METER_KINDS: readonly MeterKind[] = [
	'vu',
	'ppm',
	'truePeak',
	'loudness',
	'correlation'
];
export const VU_REFERENCES = [-18, -20, -14] as const;
export type VuReference = (typeof VU_REFERENCES)[number];
/** A frame with `active` must have arrived within this window for the mode to be `live`. */
export const LIVE_WINDOW_MS = 250;
/** Kinds used by `tapStages` unless told otherwise (stage LEDs and over lamps). */
export const STAGE_KINDS: readonly MeterKind[] = ['ppm', 'truePeak'];

export type MeterMode = 'live' | 'data';

export interface MeterUpdate {
	/** Latest frame while live; null in data mode. */
	frame: MeterFrame | null;
	mode: MeterMode;
}

export type MeterListener = (update: MeterUpdate) => void;

/** Anything a component can subscribe to (a tap, or a fake in tests). */
export interface MeterSource {
	subscribe(listener: MeterListener): () => void;
}

export interface FrameScheduler {
	now(): number;
	request(callback: () => void): number;
	cancel(handle: number): void;
}

export const browserScheduler: FrameScheduler = {
	now: () => performance.now(),
	request: (callback) => requestAnimationFrame(() => callback()),
	cancel: (handle) => cancelAnimationFrame(handle)
};

export interface TapOptions {
	kinds?: readonly MeterKind[];
	reference?: VuReference;
	ppmType?: PpmType;
	/** Worklet module URL; defaults to the Vite-bundled processor. */
	moduleUrl?: string | URL;
	scheduler?: FrameScheduler;
}

export interface MeterTap extends MeterSource {
	readonly node: AudioWorkletNode;
	readonly source: AudioNode;
	readonly kinds: readonly MeterKind[];
	/** Latest frame and mode right now (no waiting for the next animation frame). */
	current(): MeterUpdate;
	setReference(reference: VuReference): void;
	setPpmType(type: PpmType): void;
	reset(): void;
	disconnect(): void;
}

export function isVuReference(value: unknown): value is VuReference {
	return VU_REFERENCES.some((reference) => reference === value);
}

const FRAME_NUMBERS = [
	'vuL',
	'vuR',
	'ppmL',
	'ppmR',
	'truePeakDb',
	'lufsM',
	'lufsS',
	'correlation'
] as const;

/** Validates a message from the processor. */
export function parseFrame(data: unknown): MeterFrame | null {
	if (data === null || typeof data !== 'object') return null;
	const record = data as Record<string, unknown>;
	if (typeof record.active !== 'boolean') return null;
	const frame: MeterFrame = {
		vuL: 0,
		vuR: 0,
		ppmL: 0,
		ppmR: 0,
		truePeakDb: 0,
		lufsM: 0,
		lufsS: 0,
		correlation: 0,
		active: record.active
	};
	for (const key of FRAME_NUMBERS) {
		const value = record[key];
		if (typeof value !== 'number' || !Number.isFinite(value)) return null;
		frame[key] = value;
	}
	return frame;
}

const workletLoads = new WeakMap<BaseAudioContext, Promise<void>>();

async function defaultModuleUrl(): Promise<string> {
	const module = await import('./meter-processor.js?worker&url');
	return module.default;
}

/** Adds the `oa-meter` module to the context once (concurrent callers share the promise). */
export function loadMeterWorklet(
	context: BaseAudioContext,
	moduleUrl?: string | URL
): Promise<void> {
	const existing = workletLoads.get(context);
	if (existing !== undefined) return existing;
	const loading = (async () => {
		const url = moduleUrl ?? (await defaultModuleUrl());
		await context.audioWorklet.addModule(url);
	})();
	workletLoads.set(context, loading);
	loading.catch(() => {
		// A failed load must not poison later attempts; the caller still sees the rejection.
		workletLoads.delete(context);
	});
	return loading;
}

let defaultReference: VuReference = -18;
const activeTaps = new Set<Tap>();

class Tap implements MeterTap {
	readonly node: AudioWorkletNode;
	readonly source: AudioNode;
	readonly kinds: readonly MeterKind[];
	#scheduler: FrameScheduler;
	#latest: MeterFrame | null = null;
	#lastActiveAt = Number.NEGATIVE_INFINITY;
	#listeners = new Set<MeterListener>();
	#frameHandle: number | null = null;
	#dirty = false;
	#deliveredMode: MeterMode | null = null;
	#connected = true;

	constructor(
		node: AudioWorkletNode,
		source: AudioNode,
		kinds: readonly MeterKind[],
		scheduler: FrameScheduler
	) {
		this.node = node;
		this.source = source;
		this.kinds = kinds;
		this.#scheduler = scheduler;
		node.port.onmessage = (event: MessageEvent) => this.#receive(event.data);
	}

	#receive(data: unknown): void {
		const frame = parseFrame(data);
		if (frame === null) return;
		this.#latest = frame;
		if (frame.active) this.#lastActiveAt = this.#scheduler.now();
		this.#dirty = true;
		this.#schedule();
	}

	#mode(): MeterMode {
		return this.#scheduler.now() - this.#lastActiveAt < LIVE_WINDOW_MS ? 'live' : 'data';
	}

	current(): MeterUpdate {
		const mode = this.#mode();
		return { frame: mode === 'live' ? this.#latest : null, mode };
	}

	#schedule(): void {
		if (this.#frameHandle !== null || this.#listeners.size === 0) return;
		this.#frameHandle = this.#scheduler.request(this.#tick);
	}

	#tick = (): void => {
		this.#frameHandle = null;
		if (this.#listeners.size === 0) return;
		const update = this.current();
		if (this.#dirty || update.mode !== this.#deliveredMode) {
			this.#dirty = false;
			this.#deliveredMode = update.mode;
			for (const listener of this.#listeners) listener(update);
		}
		// Keep polling only while live, to notice the switch to data mode; idle taps cost nothing.
		if (update.mode === 'live') this.#schedule();
	};

	subscribe(listener: MeterListener): () => void {
		this.#listeners.add(listener);
		const update = this.current();
		listener(update);
		// While live, keep watching for the switch to data mode; otherwise wait for a frame.
		if (update.mode === 'live' || this.#dirty) this.#schedule();
		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size === 0 && this.#frameHandle !== null) {
				this.#scheduler.cancel(this.#frameHandle);
				this.#frameHandle = null;
			}
		};
	}

	setReference(reference: VuReference): void {
		checkReference(reference);
		this.node.port.postMessage({ type: 'reference', value: reference });
	}

	setPpmType(type: PpmType): void {
		if (type !== 'I' && type !== 'II') throw new RangeError(`invalid PPM type ${String(type)}`);
		this.node.port.postMessage({ type: 'ppmType', value: type });
	}

	reset(): void {
		this.#latest = null;
		this.#lastActiveAt = Number.NEGATIVE_INFINITY;
		this.#dirty = true;
		this.node.port.postMessage({ type: 'reset' });
		this.#schedule();
	}

	disconnect(): void {
		if (!this.#connected) return;
		this.#connected = false;
		activeTaps.delete(this);
		if (this.#frameHandle !== null) this.#scheduler.cancel(this.#frameHandle);
		this.#frameHandle = null;
		this.#listeners.clear();
		this.node.port.onmessage = null;
		try {
			this.source.disconnect(this.node);
		} catch (error) {
			// The owner may already have disconnected the source node; anything else is a real error.
			if (!(error instanceof DOMException && error.name === 'InvalidAccessError')) throw error;
		}
		this.node.port.close();
	}
}

function checkReference(reference: unknown): asserts reference is VuReference {
	if (!isVuReference(reference)) throw new RangeError(`invalid VU reference ${String(reference)}`);
}

/** Connects a meter tap in parallel to `node` (the signal path is untouched). */
export async function tap(node: AudioNode, options: TapOptions = {}): Promise<MeterTap> {
	const context = node.context;
	await loadMeterWorklet(context, options.moduleUrl);
	const kinds =
		options.kinds !== undefined && options.kinds.length > 0 ? options.kinds : METER_KINDS;
	const reference = options.reference ?? defaultReference;
	checkReference(reference);
	const worklet = new AudioWorkletNode(context, METER_PROCESSOR_NAME, {
		numberOfInputs: 1,
		numberOfOutputs: 0,
		channelCount: 2,
		channelCountMode: 'explicit',
		channelInterpretation: 'speakers',
		processorOptions: { kinds: [...kinds], reference, ppmType: options.ppmType ?? 'II' }
	});
	node.connect(worklet);
	const handle = new Tap(worklet, node, kinds, options.scheduler ?? browserScheduler);
	activeTaps.add(handle);
	return handle;
}

/** One tap after each stage node, for the per-stage peak LEDs. */
export function tapStages(
	nodes: readonly AudioNode[],
	options: TapOptions = {}
): Promise<MeterTap[]> {
	const kinds = options.kinds ?? STAGE_KINDS;
	return Promise.all(nodes.map((node) => tap(node, { ...options, kinds })));
}

/** Sets the 0 VU alignment for every connected tap and for taps created later. */
export function setReference(reference: VuReference): void {
	checkReference(reference);
	defaultReference = reference;
	for (const handle of activeTaps) handle.setReference(reference);
}

export function getReference(): VuReference {
	return defaultReference;
}

/**
 * AnalyserNode fed in parallel by `node`, used only to draw the spectrum (never for level
 * readings, which come from the worklet).
 */
export function createSpectrumAnalyser(
	node: AudioNode,
	options: { fftSize?: number; smoothingTimeConstant?: number } = {}
): AnalyserNode {
	const analyser = node.context.createAnalyser();
	analyser.fftSize = options.fftSize ?? 2048;
	analyser.smoothingTimeConstant = options.smoothingTimeConstant ?? 0.8;
	node.connect(analyser);
	return analyser;
}
