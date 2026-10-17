/**
 * Hand-written Web Audio / HTMLAudioElement fakes for the unit project (node). They record the
 * graph (connections) and every parameter they receive, so tests can assert on exact values.
 */
import type {
	AudioContextConstructor,
	AudioEngineEnv,
	VisibilityDocument
} from '#lib/audio/engine.ts';

export interface ParamEvent {
	type: 'set' | 'linear' | 'cancel';
	value: number;
	time: number;
}

export class FakeAudioParam {
	value: number;
	events: ParamEvent[] = [];
	constructor(value: number) {
		this.value = value;
	}
	setValueAtTime(value: number, time: number): this {
		this.value = value;
		this.events.push({ type: 'set', value, time });
		return this;
	}
	linearRampToValueAtTime(value: number, time: number): this {
		this.value = value;
		this.events.push({ type: 'linear', value, time });
		return this;
	}
	cancelScheduledValues(time: number): this {
		this.events.push({ type: 'cancel', value: this.value, time });
		return this;
	}
}

export class FakeNode {
	readonly context: FakeAudioContext;
	readonly kind: string;
	connections: FakeNode[] = [];
	constructor(context: FakeAudioContext, kind: string) {
		this.context = context;
		this.kind = kind;
		context.nodes.push(this);
	}
	connect(destination: FakeNode): FakeNode {
		this.connections.push(destination);
		return destination;
	}
	disconnect(destination?: FakeNode): void {
		if (destination === undefined) {
			this.connections = [];
			return;
		}
		const index = this.connections.indexOf(destination);
		if (index < 0) throw new DOMException('not connected', 'InvalidAccessError');
		this.connections.splice(index, 1);
	}
}

export class FakeGainNode extends FakeNode {
	readonly gain = new FakeAudioParam(1);
	constructor(context: FakeAudioContext) {
		super(context, 'gain');
	}
}

export class FakeIIRFilterNode extends FakeNode {
	readonly feedforward: number[];
	readonly feedback: number[];
	constructor(context: FakeAudioContext, feedforward: number[], feedback: number[]) {
		super(context, 'iir');
		this.feedforward = [...feedforward];
		this.feedback = [...feedback];
	}
}

export class FakeMediaElementSourceNode extends FakeNode {
	readonly mediaElement: FakeAudioElement;
	constructor(context: FakeAudioContext, element: FakeAudioElement) {
		super(context, 'media');
		this.mediaElement = element;
	}
}

export class FakeAudioBuffer {
	readonly sampleRate: number;
	readonly length: number;
	readonly numberOfChannels: number;
	private readonly channels: Float32Array[];
	constructor(channels: number, length: number, sampleRate: number) {
		this.numberOfChannels = channels;
		this.length = length;
		this.sampleRate = sampleRate;
		this.channels = Array.from({ length: channels }, () => new Float32Array(length));
	}
	getChannelData(channel: number): Float32Array {
		const data = this.channels[channel];
		if (!data) throw new RangeError('channel');
		return data;
	}
}

export class FakeBufferSourceNode extends FakeNode {
	buffer: FakeAudioBuffer | null = null;
	loop = false;
	started = false;
	stopped = false;
	constructor(context: FakeAudioContext) {
		super(context, 'buffer-source');
	}
	start(): void {
		this.started = true;
	}
	stop(): void {
		this.stopped = true;
	}
}

export class FakeAnalyserNode extends FakeNode {
	fftSize = 2048;
	constructor(context: FakeAudioContext) {
		super(context, 'analyser');
	}
}

export interface FakeAudioConfig {
	/** Rates the "browser" accepts in the constructor; null accepts any. */
	supportedRates: number[] | null;
	deviceRate: number;
	/** When true, resume() never settles (Chrome without a user gesture). */
	resumeHangs: boolean;
	instances: FakeAudioContext[];
}

export const audioConfig: FakeAudioConfig = {
	supportedRates: null,
	deviceRate: 48000,
	resumeHangs: false,
	instances: []
};

export function resetAudioConfig(): void {
	audioConfig.supportedRates = null;
	audioConfig.deviceRate = 48000;
	audioConfig.resumeHangs = false;
	audioConfig.instances = [];
}

export class FakeAudioContext extends EventTarget {
	readonly sampleRate: number;
	readonly requestedRate: number | undefined;
	state: 'suspended' | 'running' | 'closed' = 'suspended';
	currentTime = 1;
	nodes: FakeNode[] = [];
	readonly destination: FakeNode;
	mediaSources: FakeMediaElementSourceNode[] = [];
	filters: FakeIIRFilterNode[] = [];
	bufferSources: FakeBufferSourceNode[] = [];
	closeCalls = 0;

	constructor(options?: { sampleRate?: number }) {
		super();
		const requested = options?.sampleRate;
		const supported = audioConfig.supportedRates;
		if (requested !== undefined && supported !== null && !supported.includes(requested)) {
			throw new DOMException(`sample rate ${requested} not supported`, 'NotSupportedError');
		}
		this.requestedRate = requested;
		this.sampleRate = requested ?? audioConfig.deviceRate;
		this.destination = new FakeNode(this, 'destination');
		audioConfig.instances.push(this);
	}

	createGain(): FakeGainNode {
		return new FakeGainNode(this);
	}
	createIIRFilter(feedforward: number[], feedback: number[]): FakeIIRFilterNode {
		const node = new FakeIIRFilterNode(this, feedforward, feedback);
		this.filters.push(node);
		return node;
	}
	createMediaElementSource(element: FakeAudioElement): FakeMediaElementSourceNode {
		if (element.hasSource) {
			throw new DOMException('element already has a source', 'InvalidStateError');
		}
		element.hasSource = true;
		const node = new FakeMediaElementSourceNode(this, element);
		this.mediaSources.push(node);
		return node;
	}
	createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
		return new FakeAudioBuffer(channels, length, sampleRate);
	}
	createBufferSource(): FakeBufferSourceNode {
		const node = new FakeBufferSourceNode(this);
		this.bufferSources.push(node);
		return node;
	}
	createAnalyser(): FakeAnalyserNode {
		return new FakeAnalyserNode(this);
	}
	resume(): Promise<void> {
		if (audioConfig.resumeHangs) return new Promise<void>(() => undefined);
		this.setState('running');
		return Promise.resolve();
	}
	close(): Promise<void> {
		this.closeCalls++;
		this.setState('closed');
		return Promise.resolve();
	}
	private setState(next: 'suspended' | 'running' | 'closed'): void {
		if (this.state === next) return;
		this.state = next;
		this.dispatchEvent(new Event('statechange'));
	}
	/** Every node reachable from `from` through recorded connections. */
	reachable(from: FakeNode): Set<FakeNode> {
		const seen = new Set<FakeNode>();
		const stack = [from];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node || seen.has(node)) continue;
			seen.add(node);
			stack.push(...node.connections);
		}
		return seen;
	}
}

export class FakeAudioElement extends EventTarget {
	src = '';
	preload = '';
	loop = false;
	paused = true;
	duration = NaN;
	/** Playback position; tests move it by hand (the fake never advances on its own). */
	currentTime = 0;
	hasSource = false;
	playCalls = 0;
	/** Error name play() rejects with, or null to succeed. */
	playFailure: string | null = null;
	removedAttributes: string[] = [];
	play(): Promise<void> {
		this.playCalls++;
		if (this.playFailure) return Promise.reject(new DOMException('play failed', this.playFailure));
		this.paused = false;
		return Promise.resolve();
	}
	pause(): void {
		this.paused = true;
	}
	load(): void {
		this.duration = NaN;
		this.currentTime = 0;
	}
	removeAttribute(name: string): void {
		this.removedAttributes.push(name);
		if (name === 'src') this.src = '';
	}
	/** Simulates the element reading the file header. */
	fireMetadata(seconds: number): void {
		this.duration = seconds;
		this.dispatchEvent(new Event('loadedmetadata'));
	}
	fireError(): void {
		this.dispatchEvent(new Event('error'));
	}
	/** Simulates a length correction (VBR files). */
	fireDurationChange(seconds: number): void {
		this.duration = seconds;
		this.dispatchEvent(new Event('durationchange'));
	}
}

export class FakeDocument extends EventTarget {
	visibilityState: 'visible' | 'hidden' = 'visible';
	listenerCount = 0;
	override addEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: AddEventListenerOptions | boolean
	): void {
		this.listenerCount++;
		super.addEventListener(type, callback, options);
	}
	override removeEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: EventListenerOptions | boolean
	): void {
		this.listenerCount--;
		super.removeEventListener(type, callback, options);
	}
	hide(): void {
		this.visibilityState = 'hidden';
		this.dispatchEvent(new Event('visibilitychange'));
	}
}

export interface FakeEnv {
	env: AudioEngineEnv;
	elements: FakeAudioElement[];
	urls: { created: string[]; revoked: string[] };
	document: FakeDocument;
}

/** Engine environment wired to the fakes. `indexedDB` is supplied by the caller. */
export function fakeEnv(indexedDB: IDBFactory | null): FakeEnv {
	const elements: FakeAudioElement[] = [];
	const urls = { created: [] as string[], revoked: [] as string[] };
	const document = new FakeDocument();
	let sequence = 0;
	const env: AudioEngineEnv = {
		AudioContext: FakeAudioContext as unknown as AudioContextConstructor,
		createAudioElement: () => {
			const element = new FakeAudioElement();
			elements.push(element);
			return element as unknown as HTMLAudioElement;
		},
		indexedDB,
		document: document as unknown as VisibilityDocument,
		createObjectURL: () => {
			const url = `blob:fake/${++sequence}`;
			urls.created.push(url);
			return url;
		},
		revokeObjectURL: (url) => {
			urls.revoked.push(url);
		},
		hasUserActivation: () => null
	};
	return { env, elements, urls, document };
}

/** The single context the engine created. */
export function onlyContext(): FakeAudioContext {
	const [context, ...rest] = audioConfig.instances;
	if (!context || rest.length > 0) {
		throw new Error(`expected one AudioContext, got ${audioConfig.instances.length}`);
	}
	return context;
}

/** Narrows a node returned by the engine to its fake. */
export function asFake<T extends FakeNode>(node: unknown, type: new (...args: never[]) => T): T {
	if (!(node instanceof type)) throw new TypeError(`expected ${type.name}`);
	return node;
}
