/**
 * Preview audio engine: one streaming source (an HTMLAudioElement playing the user's file from an
 * object URL, or looping pink noise) fanned out to parallel chains of IIRFilterNodes that run the
 * exact Q27 coefficients the cable would receive.
 *
 * Port of the mock block "OA SHARED: audio-loader v1" (design/mocks/v2/curva.html).
 *
 * - The AudioContext is created lazily at 96 kHz (the chip's rate). If the browser refuses that
 *   rate it falls back to the device rate, recomputes the coefficients for it and reports
 *   `state().exact === false` with the note `'rate-fallback'`.
 * - Files are never decoded whole: playback streams through `createMediaElementSource`.
 * - The chosen file is kept in IndexedDB (db `open-auri`, store `audio`, key `current`) and never
 *   leaves the browser.
 * - Nothing here touches `window` at import time, so the module is safe to import during SSR.
 *
 * Graph:
 *
 *   source ─▶ bus ─┬─▶ raw ───────────────────────────────────────────────┐
 *                  ├─▶ chain.input ▶ preamp ▶ stage… ▶ chain.output ─▶ chains ┼─▶ volume ─▶ destination
 *                  └─▶ chain.input ▶ …                                      │
 *                                                                           └─▶ meter bus ─▶ tap (analyser)
 *
 * The meter bus is fed by `raw` and `chains` (pre-volume) and never reaches the destination:
 * meters and analysers read the signal, not the browser-only monitor volume.
 */
import {
	SAMPLE_RATE,
	designSection,
	encodeSection,
	fromWords,
	isStable,
	levelDb,
	preampWord,
	snapshotBands
} from 'open-auri/dsp';
import { isExperimentalKind } from 'open-auri/safety';
import { createPinkNoiseBuffer, createPinkNoiseSource } from './pink-noise.ts';

// --- types -------------------------------------------------------------------------------------

export type Band = Parameters<typeof designSection>[0];
export type Section = ReturnType<typeof designSection>;

/** `'chains'` plays through the preview chains; `'raw'` plays the source without any chain. */
export type PlayMode = 'chains' | 'raw';
export type EngineMode = 'off' | PlayMode;

export type AudioErrorCode =
	'unsupported' | 'invalid-file' | 'too-large' | 'decode' | 'suspended' | 'gesture' | 'tab-hidden';

/** `'rate-fallback'`: the browser refused 96 kHz; coefficients are recomputed, preview approximate. */
export type AudioNote = 'rate-fallback';

export interface AudioFileInfo {
	name: string;
	type: string;
	size: number;
	addedAt: number;
	/** Seconds; NaN until the element has read the metadata. */
	duration: number;
}

export interface AudioEngineState {
	mode: EngineMode;
	playing: boolean;
	/** An AudioContext exists. */
	ready: boolean;
	/** Context sample rate (the nominal 96 000 before the context exists). */
	rate: number;
	/** True when the context runs at 96 kHz and the chains use the exact Q27 words. */
	exact: boolean;
	note: AudioNote | null;
	volumeDb: number;
	error: AudioErrorCode | null;
	/** False when the current file could not be stored in IndexedDB (it lasts for this page only). */
	persisted: boolean;
	source: 'file' | 'noise';
	file: AudioFileInfo | null;
}

export interface IIRCoefficients {
	feedforward: [number, number, number];
	feedback: [number, number, number];
}

export interface ChainOptions {
	/** Allow the experimental kinds (HS, LP, HP). Without it they are refused. */
	experimental?: boolean;
	/** Stable id for `getChainOutput(id)`; generated when omitted. */
	id?: string;
	/** Level trim in dB (see `matchGains`); default 0. */
	gainDb?: number;
	/** Whether the chain is audible; default true. */
	on?: boolean;
}

export interface PreviewChain {
	readonly id: string;
	/** Fed by the shared source bus. */
	readonly input: GainNode;
	/** Q23 preamp: `preampWord(preampDb) / 2^23`. It runs before the sections, as on the chip. */
	readonly preamp: GainNode;
	/** One IIRFilterNode per non-OFF section, in written order. */
	readonly stages: readonly IIRFilterNode[];
	/** Per-chain switch and level trim (crossfaded); feeds the shared preview volume. */
	readonly output: GainNode;
	/** The shared preview volume (browser only; never written to the cable). */
	readonly volume: GainNode;
	readonly coefficients: readonly IIRCoefficients[];
	readonly rate: number;
	/** False when the coefficients were recomputed for a rate other than 96 kHz. */
	readonly exact: boolean;
	/** Crossfades (30 ms) the chain to `db` when `on`, or to silence. */
	setGain(db: number, on?: boolean): void;
	/** Fades out and disconnects every node of the chain. */
	dispose(): void;
}

export interface PreviewCurve {
	bands: readonly Band[];
	preampDb: number;
}

export type ABSide = 'A' | 'B';

export interface ABPreview {
	readonly a: PreviewChain;
	readonly b: PreviewChain;
	/** dB trims applied to A and B so both play at the same `levelDb` (never above 0). */
	readonly trims: readonly [number, number];
	selected(): ABSide;
	select(side: ABSide): void;
	dispose(): void;
}

export interface AudioEngine {
	/** The AudioContext (created on first call, at 96 kHz when the browser allows it). */
	getContext(): AudioContext;
	state(): AudioEngineState;
	/** Subscribes to state changes; returns the unsubscribe function. */
	onChange(listener: (state: AudioEngineState) => void): () => void;
	/** Validates, attaches and stores a file. Throws AudioEngineError('invalid-file' | 'too-large'). */
	loadFile(file: File): Promise<void>;
	/** Forgets the file (element, object URL and stored copy); the source falls back to pink noise. */
	removeFile(): Promise<void>;
	/** Re-attaches the stored file, if any. Never rejects. */
	restore(): Promise<void>;
	/**
	 * Starts playback with a 200 ms fade-in. Call only from a user gesture: throws
	 * AudioEngineError('gesture') outside one (when the browser reports it) and
	 * AudioEngineError('suspended') if the context cannot resume.
	 */
	start(mode?: PlayMode): Promise<void>;
	stop(): void;
	/** Plays the source without chains, or stops if it already does so. */
	toggleRaw(): Promise<void>;
	setVolume(db: number): void;
	buildChain(bands: readonly Band[], preampDb: number, options?: ChainOptions): PreviewChain;
	matchGains(levels: readonly number[]): number[];
	createAB(
		curveA: PreviewCurve,
		curveB: PreviewCurve,
		options?: { experimental?: boolean; initial?: ABSide }
	): ABPreview;
	/**
	 * Analyser fed by the meter bus (post-chain, pre-volume), for spectrum displays. The preview
	 * volume never changes what it shows.
	 */
	getAnalyserTap(): AnalyserNode;
	/**
	 * Pre-volume sum of what is playing (raw source or chains), for level meters. It does not feed
	 * the preview volume nor the destination, so tapping it never changes what is heard.
	 */
	getMeterBus(): GainNode;
	/** The output node of a chain (post-sections, post-trim), for meters; null if unknown. */
	getChainOutput(id: string): GainNode | null;
	/** The shared bus every chain hangs off (pre-chain source signal). */
	getSourceBus(): GainNode;
	/** Stops, releases the element and object URL, disconnects everything and closes the context. */
	dispose(): Promise<void>;
}

export type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;
export type VisibilityDocument = Pick<
	Document,
	'visibilityState' | 'addEventListener' | 'removeEventListener'
>;

/** Platform hooks; every field defaults to the browser global. Tests inject fakes. */
export interface AudioEngineEnv {
	AudioContext?: AudioContextConstructor | null;
	createAudioElement?: () => HTMLAudioElement;
	indexedDB?: IDBFactory | null;
	document?: VisibilityDocument | null;
	createObjectURL?: (blob: Blob) => string;
	revokeObjectURL?: (url: string) => void;
	/** True/false inside/outside a user gesture; null when the browser cannot tell. */
	hasUserActivation?: () => boolean | null;
}

export class AudioEngineError extends Error {
	readonly code: AudioErrorCode;
	constructor(code: AudioErrorCode, options?: { cause?: unknown }) {
		super(`audio engine: ${code}`, options);
		this.name = 'AudioEngineError';
		this.code = code;
	}
}

// --- constants ---------------------------------------------------------------------------------

/** The chip's rate: chains are exact only at this context rate. */
export const PREVIEW_RATE: number = SAMPLE_RATE;
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const DEFAULT_VOLUME_DB = -12;
export const MIN_VOLUME_DB = -40;
export const MAX_VOLUME_DB = 0;
export const FADE_IN_S = 0.2;
export const CROSSFADE_S = 0.03;
export const FADE_OUT_S = 0.03;
const RESUME_TIMEOUT_MS = 2000;

/** Shared IndexedDB schema (also used by the state layer for `library` and `outbox`). */
export const DB_NAME = 'open-auri';
export const DB_VERSION = 1;
export const DB_STORES: readonly string[] = Object.freeze(['audio', 'library', 'outbox']);
export const AUDIO_STORE = 'audio';
export const AUDIO_KEY = 'current';

const Q23 = 2 ** 23;
const AUDIO_EXTENSION = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba)$/i;

export const IDLE_STATE: Readonly<AudioEngineState> = Object.freeze({
	mode: 'off',
	playing: false,
	ready: false,
	rate: PREVIEW_RATE,
	exact: true,
	note: null,
	volumeDb: DEFAULT_VOLUME_DB,
	error: null,
	persisted: true,
	source: 'noise',
	file: null
});

// --- pure helpers ------------------------------------------------------------------------------

export function dbToGain(db: number): number {
	return Math.pow(10, db / 20);
}

export function clampVolumeDb(db: number): number {
	const value = Number.isFinite(db) ? Math.round(db) : DEFAULT_VOLUME_DB;
	return Math.min(MAX_VOLUME_DB, Math.max(MIN_VOLUME_DB, value)) + 0;
}

/**
 * IIR coefficients of one band at `rate`. At 96 kHz they are the dequantized Q27 wire words
 * (exactly what the chip runs); at any other rate the band is redesigned for that rate
 * (approximate preview).
 */
export function sectionCoefficients(band: Band, index: number, rate: number): IIRCoefficients {
	let s: Section;
	if (rate === PREVIEW_RATE) {
		s = fromWords(encodeSection(designSection(band, PREVIEW_RATE), index));
	} else {
		s = designSection(band, rate);
		const finite = [s.b0, s.b1, s.b2, s.a1, s.a2].every(Number.isFinite);
		if (!finite || !isStable(s.a1, s.a2)) {
			throw new RangeError(`band ${index}: unstable section at ${rate} Hz`);
		}
	}
	return { feedforward: [s.b0, s.b1, s.b2], feedback: [1, s.a1, s.a2] };
}

/** Coefficients of every non-OFF band, in written order. */
export function chainCoefficients(bands: readonly Band[], rate: number): IIRCoefficients[] {
	const out: IIRCoefficients[] = [];
	snapshotBands(bands).forEach((band, index) => {
		if (band.kind !== 'OFF') out.push(sectionCoefficients(band, index, rate));
	});
	return out;
}

/** Linear preamp gain the chip applies: the Q23 word over 2^23. */
export function preampGain(preampDb: number): number {
	return preampWord(preampDb) / Q23;
}

/**
 * Trims (dB) that bring every level to the quietest one. Each trim is ≤ 0: level matching never
 * boosts.
 */
export function matchGains(levels: readonly number[]): number[] {
	if (levels.length === 0) return [];
	if (!levels.every(Number.isFinite)) throw new RangeError('levels must be finite dB values');
	const lowest = Math.min(...levels);
	return levels.map((level) => lowest - level + 0);
}

/** Why a file cannot be used, or null when it is acceptable. */
export function validateAudioFile(
	file: Pick<File, 'name' | 'type' | 'size'>
): 'invalid-file' | 'too-large' | null {
	const typed = typeof file.type === 'string' && file.type !== '';
	const isAudio = typed ? file.type.startsWith('audio/') : AUDIO_EXTENSION.test(file.name);
	if (!isAudio || !(file.size > 0)) return 'invalid-file';
	if (file.size > MAX_FILE_BYTES) return 'too-large';
	return null;
}

function isNamed(error: unknown, name: string): boolean {
	return typeof error === 'object' && error !== null && 'name' in error && error.name === name;
}

function isRunning(context: BaseAudioContext): boolean {
	return context.state === 'running';
}

/**
 * Resumes the context; false if it is still pending after `ms` (Chrome keeps the promise pending,
 * instead of rejecting, until a user gesture).
 */
function resumeWithin(context: AudioContext, ms: number): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		const timer = setTimeout(() => resolve(false), ms);
		context.resume().then(
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			(resumeError: unknown) => {
				clearTimeout(timer);
				reject(resumeError);
			}
		);
	});
}

/** Ramps `param` to `value` from `time` over `seconds` (0 = jump). */
function ramp(param: AudioParam, value: number, time: number, seconds: number): void {
	param.cancelScheduledValues(time);
	if (seconds <= 0) {
		param.setValueAtTime(value, time);
		return;
	}
	param.setValueAtTime(param.value, time);
	param.linearRampToValueAtTime(value, time + seconds);
}

// --- IndexedDB ---------------------------------------------------------------------------------

interface StoredAudio {
	name: string;
	type: string;
	size: number;
	addedAt: number;
	blob: Blob;
}

function isStoredAudio(value: unknown): value is StoredAudio {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Partial<Record<keyof StoredAudio, unknown>>;
	return (
		typeof v.name === 'string' &&
		typeof v.type === 'string' &&
		typeof v.size === 'number' &&
		typeof v.addedAt === 'number' &&
		typeof Blob !== 'undefined' &&
		v.blob instanceof Blob
	);
}

function openDbVersion(factory: IDBFactory, version: number | undefined): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = version === undefined ? factory.open(DB_NAME) : factory.open(DB_NAME, version);
		request.onupgradeneeded = () => {
			const db = request.result;
			for (const name of DB_STORES) {
				if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
			}
		};
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => db.close();
			resolve(db);
		};
		request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
	});
}

/** Opens the shared database; if another layer already upgraded it, opens the current version. */
async function openDb(factory: IDBFactory): Promise<IDBDatabase> {
	try {
		return await openDbVersion(factory, DB_VERSION);
	} catch (error) {
		if (isNamed(error, 'VersionError')) return openDbVersion(factory, undefined);
		throw error;
	}
}

async function withAudioStore<T>(
	factory: IDBFactory,
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	const db = await openDb(factory);
	return new Promise<T>((resolve, reject) => {
		const results: { value: T }[] = [];
		let tx: IDBTransaction;
		try {
			tx = db.transaction(AUDIO_STORE, mode);
		} catch (error) {
			db.close();
			reject(error);
			return;
		}
		const request = operation(tx.objectStore(AUDIO_STORE));
		request.onsuccess = () => {
			results.push({ value: request.result });
		};
		tx.oncomplete = () => {
			db.close();
			const first = results[0];
			if (first) resolve(first.value);
			else reject(new Error('IndexedDB request finished without a result'));
		};
		tx.onabort = () => {
			db.close();
			reject(tx.error ?? request.error ?? new Error('IndexedDB transaction aborted'));
		};
	});
}

// --- environment -------------------------------------------------------------------------------

interface AudioGlobals {
	AudioContext?: AudioContextConstructor;
	webkitAudioContext?: AudioContextConstructor;
	indexedDB?: IDBFactory;
	document?: VisibilityDocument;
	navigator?: { userActivation?: { readonly isActive: boolean } };
}

interface ResolvedEnv {
	AudioContext: AudioContextConstructor | null;
	createAudioElement: () => HTMLAudioElement;
	indexedDB: IDBFactory | null;
	document: VisibilityDocument | null;
	createObjectURL: (blob: Blob) => string;
	revokeObjectURL: (url: string) => void;
	hasUserActivation: () => boolean | null;
}

function resolveEnv(env: AudioEngineEnv): ResolvedEnv {
	const g: AudioGlobals = globalThis;
	return {
		AudioContext:
			env.AudioContext !== undefined
				? env.AudioContext
				: (g.AudioContext ?? g.webkitAudioContext ?? null),
		createAudioElement: env.createAudioElement ?? (() => new Audio()),
		indexedDB: env.indexedDB !== undefined ? env.indexedDB : (g.indexedDB ?? null),
		document: env.document !== undefined ? env.document : (g.document ?? null),
		createObjectURL: env.createObjectURL ?? ((blob) => URL.createObjectURL(blob)),
		revokeObjectURL: env.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url)),
		hasUserActivation:
			env.hasUserActivation ??
			(() => {
				const activation = g.navigator?.userActivation;
				return activation ? activation.isActive : null;
			})
	};
}

// --- engine ------------------------------------------------------------------------------------

interface Graph {
	/** Preview volume. */
	master: GainNode;
	chainsGain: GainNode;
	rawGain: GainNode;
	bus: GainNode;
	/** Pre-volume sum of `chainsGain` and `rawGain`; feeds meters only (never `master`). */
	meter: GainNode;
	tap: AnalyserNode | null;
}

interface ChainRecord {
	chain: PreviewChain;
	disconnect: () => void;
}

type Timer = ReturnType<typeof setTimeout>;

export function createAudioEngine(options: AudioEngineEnv = {}): AudioEngine {
	const env = resolveEnv(options);
	const listeners = new Set<(state: AudioEngineState) => void>();
	const chains = new Map<string, ChainRecord>();
	const timers = new Set<Timer>();
	/** Disconnects of chains fading out after dispose(); flushed by the engine's dispose(). */
	const retiring = new Set<() => void>();

	let ctx: AudioContext | null = null;
	let graph: Graph | null = null;
	let rate = PREVIEW_RATE;
	let exact = true;
	let mode: EngineMode = 'off';
	let volumeDb = DEFAULT_VOLUME_DB;
	let error: AudioErrorCode | null = null;
	let persisted = true;
	let file: Omit<AudioFileInfo, 'duration'> | null = null;
	let duration = NaN;
	let element: HTMLAudioElement | null = null;
	let elementSource: MediaElementAudioSourceNode | null = null;
	let elementCleanup: (() => void) | null = null;
	let objectUrl: string | null = null;
	let noise: AudioBufferSourceNode | null = null;
	let noiseBuffer: AudioBuffer | null = null;
	let fileGeneration = 0;
	let stopGeneration = 0;
	let chainSequence = 0;
	let visibilityDoc: VisibilityDocument | null = null;

	const state = (): AudioEngineState => ({
		mode,
		playing: mode !== 'off',
		ready: ctx !== null,
		rate,
		exact,
		note: exact ? null : 'rate-fallback',
		volumeDb,
		error,
		persisted,
		source: element ? 'file' : 'noise',
		file: file ? { ...file, duration } : null
	});

	function emit(): void {
		const snapshot = state();
		for (const listener of [...listeners]) {
			try {
				listener(snapshot);
			} catch (listenerError) {
				console.error('audio engine listener failed', listenerError);
			}
		}
	}

	function fail(code: AudioErrorCode, cause?: unknown): AudioEngineError {
		error = code;
		emit();
		return new AudioEngineError(code, { cause });
	}

	function later(callback: () => void, ms: number): void {
		const id = setTimeout(() => {
			timers.delete(id);
			callback();
		}, ms);
		timers.add(id);
	}

	// --- context and graph ---

	function onContextState(): void {
		if (ctx && !isRunning(ctx) && mode !== 'off') error = 'suspended';
		emit();
	}

	function onVisibility(): void {
		if (visibilityDoc?.visibilityState === 'hidden' && mode !== 'off') {
			stop();
			error = 'tab-hidden';
			emit();
		}
	}

	function getContext(): AudioContext {
		if (ctx) return ctx;
		const Context = env.AudioContext;
		if (!Context) throw fail('unsupported');
		let created: AudioContext;
		try {
			created = new Context({ sampleRate: PREVIEW_RATE, latencyHint: 'interactive' });
		} catch (rateError) {
			if (!isNamed(rateError, 'NotSupportedError')) throw rateError;
			created = new Context({ latencyHint: 'interactive' });
		}
		ctx = created;
		rate = created.sampleRate;
		exact = rate === PREVIEW_RATE;
		const master = created.createGain();
		master.gain.value = 0;
		master.connect(created.destination);
		const chainsGain = created.createGain();
		chainsGain.gain.value = 0;
		chainsGain.connect(master);
		const rawGain = created.createGain();
		rawGain.gain.value = 0;
		rawGain.connect(master);
		const meter = created.createGain();
		chainsGain.connect(meter);
		rawGain.connect(meter);
		const bus = created.createGain();
		bus.connect(rawGain);
		graph = { master, chainsGain, rawGain, bus, meter, tap: null };
		created.addEventListener('statechange', onContextState);
		if (env.document && !visibilityDoc) {
			visibilityDoc = env.document;
			visibilityDoc.addEventListener('visibilitychange', onVisibility);
		}
		routeSource();
		emit();
		return created;
	}

	function ensure(): { context: AudioContext; nodes: Graph } {
		const context = getContext();
		if (!graph) throw new Error('audio graph missing');
		return { context, nodes: graph };
	}

	// --- sources ---

	function stopNoise(): void {
		if (!noise) return;
		const node = noise;
		noise = null;
		node.stop();
		node.disconnect();
	}

	function startNoise(): void {
		if (!ctx || !graph || noise) return;
		noiseBuffer ??= createPinkNoiseBuffer(ctx);
		const node = createPinkNoiseSource(ctx, noiseBuffer);
		node.connect(graph.bus);
		node.start();
		noise = node;
	}

	/** Plays the element; resolves to an error code, or null on success or a benign abort. */
	async function playElement(target: HTMLAudioElement): Promise<AudioErrorCode | null> {
		try {
			await target.play();
			return null;
		} catch (playError) {
			if (element !== target || isNamed(playError, 'AbortError')) return null;
			return isNamed(playError, 'NotAllowedError') ? 'suspended' : 'decode';
		}
	}

	/** Connects the current source (file element or pink noise) to the bus; plays it if running. */
	function routeSource(): void {
		if (!ctx || !graph) return;
		stopNoise();
		if (element) {
			if (!elementSource) {
				elementSource = ctx.createMediaElementSource(element);
				elementSource.connect(graph.bus);
			}
			if (mode !== 'off') {
				const target = element;
				void playElement(target).then((code) => {
					if (code && element === target) {
						error = code;
						emit();
					}
				});
			}
		} else if (mode !== 'off') {
			startNoise();
		}
	}

	function detachFile(): void {
		if (element) {
			const old = element;
			element = null;
			elementCleanup?.();
			old.pause();
			old.removeAttribute('src');
			old.load();
		}
		elementCleanup = null;
		if (elementSource) {
			elementSource.disconnect();
			elementSource = null;
		}
		if (objectUrl) {
			env.revokeObjectURL(objectUrl);
			objectUrl = null;
		}
		file = null;
		duration = NaN;
	}

	function attach(record: StoredAudio | null): void {
		detachFile();
		if (record) {
			file = { name: record.name, type: record.type, size: record.size, addedAt: record.addedAt };
			objectUrl = env.createObjectURL(record.blob);
			const el = env.createAudioElement();
			const onMetadata = () => {
				if (element !== el) return;
				duration = el.duration;
				emit();
			};
			const onError = () => {
				if (element !== el) return;
				error = 'decode';
				emit();
			};
			el.addEventListener('loadedmetadata', onMetadata);
			el.addEventListener('error', onError);
			elementCleanup = () => {
				el.removeEventListener('loadedmetadata', onMetadata);
				el.removeEventListener('error', onError);
			};
			el.preload = 'metadata';
			el.loop = true;
			el.src = objectUrl;
			element = el;
		}
		routeSource();
		emit();
	}

	// --- transport ---

	async function start(playMode: PlayMode = 'chains'): Promise<void> {
		if (env.hasUserActivation() === false) throw fail('gesture');
		const { context, nodes } = ensure();
		if (!isRunning(context)) {
			let resumed: boolean;
			try {
				resumed = await resumeWithin(context, RESUME_TIMEOUT_MS);
			} catch (resumeError) {
				throw fail('suspended', resumeError);
			}
			if (!resumed || !isRunning(context)) throw fail('suspended');
		}
		const wasPlaying = mode !== 'off';
		mode = playMode;
		stopGeneration++;
		error = null;
		const t = context.currentTime;
		const switchS = wasPlaying ? CROSSFADE_S : 0;
		ramp(nodes.rawGain.gain, playMode === 'raw' ? 1 : 0, t, switchS);
		ramp(nodes.chainsGain.gain, playMode === 'chains' ? 1 : 0, t, switchS);
		if (!wasPlaying) {
			const volume = nodes.master.gain;
			volume.cancelScheduledValues(t);
			volume.setValueAtTime(0, t);
			volume.linearRampToValueAtTime(dbToGain(volumeDb), t + FADE_IN_S);
		}
		emit();
		if (element) {
			const problem = await playElement(element);
			if (problem) {
				mode = 'off';
				nodes.master.gain.cancelScheduledValues(context.currentTime);
				nodes.master.gain.setValueAtTime(0, context.currentTime);
				throw fail(problem);
			}
		} else {
			startNoise();
		}
	}

	function stop(): void {
		if (mode === 'off') return;
		mode = 'off';
		const generation = ++stopGeneration;
		if (ctx && graph) {
			const volume = graph.master.gain;
			const t = ctx.currentTime;
			volume.cancelScheduledValues(t);
			volume.setValueAtTime(volume.value, t);
			volume.linearRampToValueAtTime(0, t + FADE_OUT_S);
		}
		later(
			() => {
				if (generation !== stopGeneration || mode !== 'off') return;
				element?.pause();
				stopNoise();
			},
			FADE_OUT_S * 1000 + 30
		);
		emit();
	}

	async function toggleRaw(): Promise<void> {
		if (mode === 'raw') stop();
		else await start('raw');
	}

	function setVolume(db: number): void {
		volumeDb = clampVolumeDb(db);
		if (ctx && graph && mode !== 'off') {
			ramp(graph.master.gain, dbToGain(volumeDb), ctx.currentTime, CROSSFADE_S);
		}
		emit();
	}

	// --- files ---

	async function persist(record: StoredAudio, generation: number): Promise<void> {
		const factory = env.indexedDB;
		let stored = false;
		if (factory) {
			try {
				await withAudioStore(factory, 'readwrite', (store) => store.put(record, AUDIO_KEY));
				stored = true;
			} catch (storeError) {
				console.warn('audio engine: could not store the file', storeError);
			}
		}
		if (generation !== fileGeneration) return;
		persisted = stored;
		emit();
	}

	async function loadFile(input: File): Promise<void> {
		const problem = validateAudioFile(input);
		if (problem) throw fail(problem);
		const generation = ++fileGeneration;
		const record: StoredAudio = {
			name: input.name || 'audio',
			type: input.type || 'audio/mpeg',
			size: input.size,
			addedAt: Date.now(),
			blob: input
		};
		error = null;
		persisted = true;
		attach(record);
		await persist(record, generation);
	}

	async function removeFile(): Promise<void> {
		fileGeneration++;
		error = null;
		persisted = true;
		attach(null);
		const factory = env.indexedDB;
		if (!factory) return;
		try {
			await withAudioStore(factory, 'readwrite', (store) => store.delete(AUDIO_KEY));
		} catch (storeError) {
			console.warn('audio engine: could not delete the stored file', storeError);
		}
	}

	async function restore(): Promise<void> {
		const factory = env.indexedDB;
		if (!factory) return;
		const generation = fileGeneration;
		try {
			const record = await withAudioStore<unknown>(factory, 'readonly', (store) =>
				store.get(AUDIO_KEY)
			);
			if (generation !== fileGeneration || !isStoredAudio(record)) return;
			persisted = true;
			attach(record);
		} catch (storeError) {
			console.warn('audio engine: could not restore the stored file', storeError);
		}
	}

	// --- chains ---

	function buildChain(
		bands: readonly Band[],
		preampDb: number,
		chainOptions: ChainOptions = {}
	): PreviewChain {
		const snapshot = snapshotBands(bands);
		if (chainOptions.experimental !== true) {
			snapshot.forEach((band, index) => {
				if (isExperimentalKind(band.kind)) {
					throw new RangeError(
						`band ${index}: ${band.kind} is experimental; pass { experimental: true }`
					);
				}
			});
		}
		const preampLinear = preampGain(preampDb);
		const id = chainOptions.id ?? `chain-${++chainSequence}`;
		if (chains.has(id)) throw new Error(`chain id already in use: ${id}`);
		const { context, nodes } = ensure();
		// Computed before any node exists, so an invalid band leaves nothing behind.
		const coefficients = chainCoefficients(snapshot, context.sampleRate);

		const input = context.createGain();
		const preamp = context.createGain();
		preamp.gain.value = preampLinear;
		const output = context.createGain();
		output.gain.value = 0;
		input.connect(preamp);
		const stages: IIRFilterNode[] = [];
		let tail: AudioNode = preamp;
		for (const c of coefficients) {
			const stage = context.createIIRFilter([...c.feedforward], [...c.feedback]);
			tail.connect(stage);
			tail = stage;
			stages.push(stage);
		}
		tail.connect(output);
		output.connect(nodes.chainsGain);
		nodes.bus.connect(input);

		let wired = true;
		let disposed = false;
		const disconnect = () => {
			if (!wired) return;
			wired = false;
			nodes.bus.disconnect(input);
			for (const node of [input, preamp, ...stages, output]) node.disconnect();
		};
		const chain: PreviewChain = {
			id,
			input,
			preamp,
			stages,
			output,
			volume: nodes.master,
			coefficients,
			rate: context.sampleRate,
			exact: context.sampleRate === PREVIEW_RATE,
			setGain(db: number, on = true) {
				if (disposed || ctx !== context) return;
				ramp(output.gain, on ? dbToGain(db) : 0, context.currentTime, CROSSFADE_S);
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				chains.delete(id);
				if (ctx !== context) {
					disconnect();
					return;
				}
				ramp(output.gain, 0, context.currentTime, CROSSFADE_S);
				retiring.add(disconnect);
				later(
					() => {
						retiring.delete(disconnect);
						disconnect();
					},
					CROSSFADE_S * 1000 + 20
				);
			}
		};
		chains.set(id, { chain, disconnect });
		chain.setGain(chainOptions.gainDb ?? 0, chainOptions.on ?? true);
		return chain;
	}

	function createAB(
		curveA: PreviewCurve,
		curveB: PreviewCurve,
		abOptions: { experimental?: boolean; initial?: ABSide } = {}
	): ABPreview {
		const [trimA = 0, trimB = 0] = matchGains([
			levelDb(curveA.bands, curveA.preampDb),
			levelDb(curveB.bands, curveB.preampDb)
		]);
		let current: ABSide = abOptions.initial ?? 'A';
		const experimental = abOptions.experimental === true;
		const a = buildChain(curveA.bands, curveA.preampDb, {
			experimental,
			gainDb: trimA,
			on: current === 'A'
		});
		let b: PreviewChain;
		try {
			b = buildChain(curveB.bands, curveB.preampDb, {
				experimental,
				gainDb: trimB,
				on: current === 'B'
			});
		} catch (buildError) {
			a.dispose();
			throw buildError;
		}
		return {
			a,
			b,
			trims: [trimA, trimB],
			selected: () => current,
			select(side: ABSide) {
				current = side;
				a.setGain(trimA, side === 'A');
				b.setGain(trimB, side === 'B');
			},
			dispose() {
				a.dispose();
				b.dispose();
			}
		};
	}

	// --- taps ---

	function getAnalyserTap(): AnalyserNode {
		const { context, nodes } = ensure();
		if (!nodes.tap) {
			const tap = context.createAnalyser();
			tap.fftSize = 2048;
			nodes.meter.connect(tap);
			nodes.tap = tap;
		}
		return nodes.tap;
	}

	function getMeterBus(): GainNode {
		return ensure().nodes.meter;
	}

	// --- teardown ---

	async function dispose(): Promise<void> {
		for (const id of timers) clearTimeout(id);
		timers.clear();
		mode = 'off';
		stopGeneration++;
		for (const record of chains.values()) record.disconnect();
		chains.clear();
		for (const disconnect of retiring) disconnect();
		retiring.clear();
		stopNoise();
		detachFile();
		if (visibilityDoc) {
			visibilityDoc.removeEventListener('visibilitychange', onVisibility);
			visibilityDoc = null;
		}
		if (graph) {
			const { master, chainsGain, rawGain, bus, meter, tap } = graph;
			for (const node of [bus, rawGain, chainsGain, meter, master]) node.disconnect();
			tap?.disconnect();
		}
		const context = ctx;
		ctx = null;
		graph = null;
		noiseBuffer = null;
		rate = PREVIEW_RATE;
		exact = true;
		error = null;
		if (context) {
			context.removeEventListener('statechange', onContextState);
			if (context.state !== 'closed') await context.close();
		}
		emit();
		listeners.clear();
	}

	return {
		getContext,
		state,
		onChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		loadFile,
		removeFile,
		restore,
		start,
		stop,
		toggleRaw,
		setVolume,
		buildChain,
		matchGains,
		createAB,
		getAnalyserTap,
		getMeterBus,
		getChainOutput: (id) => chains.get(id)?.chain.output ?? null,
		getSourceBus: () => ensure().nodes.bus,
		dispose
	};
}

// --- singleton ---------------------------------------------------------------------------------

let shared: AudioEngine | null = null;

/**
 * The page-wide engine, created on first use. In the browser it starts restoring the stored file
 * immediately; it never creates an AudioContext or plays anything by itself.
 */
export function getAudioEngine(): AudioEngine {
	if (!shared) {
		shared = createAudioEngine();
		if (typeof window !== 'undefined') void shared.restore();
	}
	return shared;
}

/** Disposes the page-wide engine (closing its context); the next `getAudioEngine()` makes a new one. */
export async function disposeAudioEngine(): Promise<void> {
	const engine = shared;
	shared = null;
	if (engine) await engine.dispose();
}
