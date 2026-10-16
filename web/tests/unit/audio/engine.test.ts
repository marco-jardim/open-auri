import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { designSection, encodeSection, levelDb, preampWord } from 'open-auri/dsp';
import { OFFICIAL_PRESETS, PADRAO_AURI } from 'open-auri/catalog';
import {
	AUDIO_KEY,
	AUDIO_STORE,
	AudioEngineError,
	DB_NAME,
	DEFAULT_VOLUME_DB,
	FADE_IN_S,
	MAX_FILE_BYTES,
	createAudioEngine,
	dbToGain,
	matchGains,
	validateAudioFile,
	type AudioEngine,
	type Band
} from '#lib/audio/engine.ts';
import {
	FakeAudioContext,
	FakeBufferSourceNode,
	FakeGainNode,
	FakeIIRFilterNode,
	asFake,
	audioConfig,
	fakeEnv,
	onlyContext,
	resetAudioConfig,
	type FakeEnv
} from './fake-audio.ts';
import { FakeIDBFactory } from './fake-idb.ts';

const Q27 = 2 ** 27;
const Q23 = 2 ** 23;

/** Dequantized wire words, computed independently of the engine. */
function expectedExact(band: Band, index: number) {
	const [b0 = NaN, b2 = NaN, minusA1 = NaN, b1 = NaN, minusA2 = NaN] = encodeSection(
		designSection(band, 96000),
		index
	);
	return {
		feedforward: [b0 / Q27, b1 / Q27, b2 / Q27],
		feedback: [1, -minusA1 / Q27, -minusA2 / Q27]
	};
}

function audioFile(name = 'song.mp3', type = 'audio/mpeg', bytes = 2048): File {
	return new File([new Uint8Array(bytes)], name, { type });
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let engines: AudioEngine[] = [];

function makeEngine(idb: FakeIDBFactory | null = null): { engine: AudioEngine; fake: FakeEnv } {
	const fake = fakeEnv(idb ? idb.asFactory() : null);
	const engine = createAudioEngine(fake.env);
	engines.push(engine);
	return { engine, fake };
}

beforeEach(() => {
	resetAudioConfig();
	engines = [];
});

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(engines.map((engine) => engine.dispose()));
});

describe('context', () => {
	it('opens at 96 kHz and reports exact previews', () => {
		const { engine } = makeEngine();
		expect(engine.state()).toMatchObject({ ready: false, rate: 96000, exact: true, note: null });
		engine.getContext();
		const context = onlyContext();
		expect(context.requestedRate).toBe(96000);
		expect(engine.state()).toMatchObject({ ready: true, rate: 96000, exact: true, note: null });
	});

	it('falls back to the device rate when 96 kHz is refused, with a note', () => {
		audioConfig.supportedRates = [44100];
		audioConfig.deviceRate = 44100;
		const { engine } = makeEngine();
		engine.getContext();
		expect(onlyContext().sampleRate).toBe(44100);
		expect(engine.state()).toMatchObject({
			rate: 44100,
			exact: false,
			note: 'rate-fallback'
		});
	});

	it('is created once (lazy singleton per engine)', () => {
		const { engine } = makeEngine();
		const first = engine.getContext();
		expect(engine.getContext()).toBe(first);
		expect(audioConfig.instances).toHaveLength(1);
	});

	it('reports unsupported Web Audio without throwing at creation (SSR-safe)', () => {
		const engine = createAudioEngine({ AudioContext: null, indexedDB: null, document: null });
		expect(engine.state().ready).toBe(false);
		expect(() => engine.getContext()).toThrow(AudioEngineError);
		expect(engine.state().error).toBe('unsupported');
	});
});

describe('chains', () => {
	it('passes the dequantized Q27 words of all 11 official presets to IIRFilterNode', () => {
		expect(OFFICIAL_PRESETS).toHaveLength(11);
		const { engine } = makeEngine();
		for (const preset of OFFICIAL_PRESETS) {
			const chain = engine.buildChain(preset.bands, preset.preampDb, {
				id: preset.id,
				experimental: true
			});
			const expected = preset.bands.flatMap((band, index) =>
				band.kind === 'OFF' ? [] : [expectedExact(band, index)]
			);
			expect(chain.exact).toBe(true);
			expect(chain.stages).toHaveLength(expected.length);
			chain.stages.forEach((stage, i) => {
				const fake = asFake(stage, FakeIIRFilterNode);
				expect({ feedforward: fake.feedforward, feedback: fake.feedback }).toEqual(expected[i]);
			});
			expect(chain.preamp.gain.value).toBe(preampWord(preset.preampDb) / Q23);
		}
		const total = OFFICIAL_PRESETS.reduce(
			(sum, preset) => sum + preset.bands.filter((band) => band.kind !== 'OFF').length,
			0
		);
		expect(onlyContext().filters).toHaveLength(total);
	});

	it('wires input → preamp → sections → output → preview volume', () => {
		const { engine } = makeEngine();
		const chain = engine.buildChain(PADRAO_AURI.bands, PADRAO_AURI.preampDb);
		const input = asFake(chain.input, FakeGainNode);
		const preamp = asFake(chain.preamp, FakeGainNode);
		const output = asFake(chain.output, FakeGainNode);
		const stages = chain.stages.map((stage) => asFake(stage, FakeIIRFilterNode));
		expect(input.connections).toEqual([preamp]);
		const sequence = [preamp, ...stages, output];
		for (let i = 0; i < sequence.length - 1; i++) {
			expect(sequence[i]?.connections).toEqual([sequence[i + 1]]);
		}
		const volume = asFake(chain.volume, FakeGainNode);
		expect(onlyContext().reachable(output).has(volume)).toBe(true);
		expect(volume.connections).toContain(onlyContext().destination);
		expect(asFake(engine.getSourceBus(), FakeGainNode).connections).toContain(input);
	});

	it('omits OFF sections', () => {
		const { engine } = makeEngine();
		const pk: Band = { kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1.2 };
		const ls: Band = { kind: 'LS', freqHz: 120, gainDb: 2, qFactor: 0.7 };
		const off: Band = { kind: 'OFF' };
		const bands = [off, pk, off, off, ls, off, off, off, off, off];
		const chain = engine.buildChain(bands, -2);
		expect(chain.stages).toHaveLength(2);
		const [first, second] = chain.stages.map((stage) => asFake(stage, FakeIIRFilterNode));
		expect({ feedforward: first?.feedforward, feedback: first?.feedback }).toEqual(
			expectedExact(pk, 1)
		);
		expect({ feedforward: second?.feedforward, feedback: second?.feedback }).toEqual(
			expectedExact(ls, 4)
		);
	});

	it('sets the preamp to the Q23 word over 2^23', () => {
		const { engine } = makeEngine();
		for (const preampDb of [0, -0.5, -3.7, -12]) {
			const chain = engine.buildChain([{ kind: 'OFF' }], preampDb);
			expect(chain.preamp.gain.value).toBe(preampWord(preampDb) / Q23);
			expect(chain.stages).toHaveLength(0);
		}
		expect(() => engine.buildChain([{ kind: 'OFF' }], 1)).toThrow(RangeError);
	});

	it('recomputes coefficients at the fallback rate and marks the chain approximate', () => {
		audioConfig.supportedRates = [48000];
		const { engine } = makeEngine();
		const chain = engine.buildChain(PADRAO_AURI.bands, PADRAO_AURI.preampDb);
		expect(chain.exact).toBe(false);
		expect(chain.rate).toBe(48000);
		const active = PADRAO_AURI.bands.filter((band) => band.kind !== 'OFF');
		expect(chain.stages).toHaveLength(active.length);
		chain.stages.forEach((stage, i) => {
			const band = active[i];
			if (!band) throw new Error('missing band');
			const s = designSection(band, 48000);
			const fake = asFake(stage, FakeIIRFilterNode);
			expect(fake.feedforward).toEqual([s.b0, s.b1, s.b2]);
			expect(fake.feedback).toEqual([1, s.a1, s.a2]);
		});
		expect(chain.preamp.gain.value).toBe(preampWord(PADRAO_AURI.preampDb) / Q23);
	});

	it('refuses experimental kinds unless asked, without leaving nodes behind', () => {
		const { engine } = makeEngine();
		const hs: Band = { kind: 'HS', freqHz: 8000, gainDb: 2, qFactor: 0.7 };
		engine.getContext();
		const before = onlyContext().nodes.length;
		expect(() => engine.buildChain([hs], -3)).toThrow(RangeError);
		expect(onlyContext().nodes).toHaveLength(before);
		expect(engine.buildChain([hs], -3, { experimental: true }).stages).toHaveLength(1);
	});

	it('exposes chain outputs for meters and forgets disposed chains', async () => {
		const { engine } = makeEngine();
		const chain = engine.buildChain(PADRAO_AURI.bands, PADRAO_AURI.preampDb, { id: 'curve' });
		expect(engine.getChainOutput('curve')).toBe(chain.output);
		expect(() => engine.buildChain([], 0, { id: 'curve' })).toThrow(/already in use/);
		chain.dispose();
		expect(engine.getChainOutput('curve')).toBeNull();
		await wait(80);
		const input = asFake(chain.input, FakeGainNode);
		expect(asFake(engine.getSourceBus(), FakeGainNode).connections).not.toContain(input);
		expect(asFake(chain.output, FakeGainNode).connections).toEqual([]);
	});

	it('gives meters an analyser fed by the preview volume', () => {
		const { engine } = makeEngine();
		const tap = engine.getAnalyserTap();
		expect(engine.getAnalyserTap()).toBe(tap);
		const chain = engine.buildChain([{ kind: 'OFF' }], 0);
		expect(asFake(chain.volume, FakeGainNode).connections).toContain(tap);
	});
});

describe('level matching and A/B', () => {
	it('matches levels without ever boosting', () => {
		expect(matchGains([-3, -1, -6])).toEqual([-3, -5, 0]);
		expect(matchGains([2, 2])).toEqual([0, 0]);
		expect(matchGains([])).toEqual([]);
		for (const trim of matchGains([-0.5, 4, -9.25, 1])) expect(trim).toBeLessThanOrEqual(0);
		expect(() => matchGains([0, Number.NaN])).toThrow(RangeError);
	});

	it('switches A/B by gain at equal level without recreating the source', async () => {
		const { engine, fake } = makeEngine();
		await engine.loadFile(audioFile());
		engine.getContext();
		const context = onlyContext();
		const [presetA, presetB] = OFFICIAL_PRESETS;
		if (!presetA || !presetB) throw new Error('missing presets');
		const curveA = { bands: presetA.bands, preampDb: presetA.preampDb };
		const curveB = { bands: presetB.bands, preampDb: presetB.preampDb };
		const ab = engine.createAB(curveA, curveB, { experimental: true });
		const extra = engine.buildChain(PADRAO_AURI.bands, PADRAO_AURI.preampDb);

		const levelA = levelDb(curveA.bands, curveA.preampDb);
		const levelB = levelDb(curveB.bands, curveB.preampDb);
		expect(ab.trims).toEqual(matchGains([levelA, levelB]));
		expect(Math.max(...ab.trims)).toBe(0);
		expect(levelA + ab.trims[0]).toBeCloseTo(levelB + ab.trims[1], 12);

		const outA = asFake(ab.a.output, FakeGainNode);
		const outB = asFake(ab.b.output, FakeGainNode);
		expect(ab.selected()).toBe('A');
		expect(outA.gain.value).toBeCloseTo(dbToGain(ab.trims[0]), 12);
		expect(outB.gain.value).toBe(0);

		for (const side of ['B', 'A', 'B'] as const) ab.select(side);
		expect(ab.selected()).toBe('B');
		expect(outA.gain.value).toBe(0);
		expect(outB.gain.value).toBeCloseTo(dbToGain(ab.trims[1]), 12);
		const lastRamp = outB.gain.events.at(-1);
		expect(lastRamp?.type).toBe('linear');
		expect(lastRamp?.time).toBeCloseTo(context.currentTime + 0.03, 12);

		// One element, one media source, fanned out through the shared bus.
		expect(fake.elements).toHaveLength(1);
		expect(context.mediaSources).toHaveLength(1);
		const bus = asFake(engine.getSourceBus(), FakeGainNode);
		expect(context.mediaSources[0]?.connections).toEqual([bus]);
		for (const chain of [ab.a, ab.b, extra]) {
			expect(bus.connections).toContain(asFake(chain.input, FakeGainNode));
		}
		expect(context.bufferSources).toHaveLength(0);

		ab.dispose();
		expect(context.mediaSources).toHaveLength(1);
		await engine.dispose();
		expect(outA.connections).toEqual([]);
		expect(outB.connections).toEqual([]);
		expect(bus.connections).toEqual([]);
	});

	it('A/B runs from pink noise too, with a single noise source while playing', async () => {
		const { engine } = makeEngine();
		const ab = engine.createAB(
			{ bands: PADRAO_AURI.bands, preampDb: PADRAO_AURI.preampDb },
			{ bands: [{ kind: 'OFF' }], preampDb: 0 },
			{ initial: 'B' }
		);
		await engine.start();
		ab.select('A');
		ab.select('B');
		const context = onlyContext();
		expect(context.bufferSources).toHaveLength(1);
		expect(context.bufferSources[0]?.started).toBe(true);
		expect(context.mediaSources).toHaveLength(0);
	});
});

describe('transport', () => {
	it('starts with a 200 ms fade-in to the default −12 dB preview volume', async () => {
		const { engine } = makeEngine();
		const chain = engine.buildChain([{ kind: 'OFF' }], 0);
		await engine.start();
		const context = onlyContext();
		expect(context.state).toBe('running');
		expect(engine.state()).toMatchObject({ mode: 'chains', playing: true, error: null });
		const volume = asFake(chain.volume, FakeGainNode);
		const events = volume.gain.events;
		expect(events).toContainEqual({ type: 'set', value: 0, time: context.currentTime });
		const fade = events.find((event) => event.type === 'linear');
		expect(fade?.value).toBeCloseTo(dbToGain(DEFAULT_VOLUME_DB), 12);
		expect(fade?.time).toBeCloseTo(context.currentTime + FADE_IN_S, 12);
		expect(engine.state().volumeDb).toBe(-12);
	});

	it('refuses to start outside a user gesture', async () => {
		const fake = fakeEnv(null);
		const engine = createAudioEngine({ ...fake.env, hasUserActivation: () => false });
		engines.push(engine);
		await expect(engine.start()).rejects.toMatchObject({ code: 'gesture' });
		expect(audioConfig.instances).toHaveLength(0);
		expect(engine.state()).toMatchObject({ playing: false, error: 'gesture' });
	});

	it('reports a suspended context that cannot resume', async () => {
		vi.useFakeTimers();
		audioConfig.resumeHangs = true;
		const { engine } = makeEngine();
		const started = engine.start();
		const assertion = expect(started).rejects.toMatchObject({ code: 'suspended' });
		await vi.advanceTimersByTimeAsync(2500);
		await assertion;
		expect(engine.state()).toMatchObject({ playing: false, error: 'suspended' });
	});

	it('plays the file through the element and stops with a fade-out', async () => {
		const { engine, fake } = makeEngine();
		await engine.loadFile(audioFile());
		await engine.start();
		const element = fake.elements[0];
		expect(element?.paused).toBe(false);
		expect(element?.loop).toBe(true);
		engine.stop();
		expect(engine.state().playing).toBe(false);
		await wait(100);
		expect(element?.paused).toBe(true);
	});

	it('reports a file the browser refuses to play', async () => {
		const { engine, fake } = makeEngine();
		await engine.loadFile(audioFile());
		const element = fake.elements[0];
		if (!element) throw new Error('no element');
		element.playFailure = 'NotSupportedError';
		await expect(engine.start()).rejects.toMatchObject({ code: 'decode' });
		expect(engine.state()).toMatchObject({ playing: false, error: 'decode' });
		element.fireError();
		expect(engine.state().error).toBe('decode');
	});

	it('pauses when the tab is hidden', async () => {
		const { engine, fake } = makeEngine();
		await engine.loadFile(audioFile());
		await engine.start('raw');
		fake.document.hide();
		expect(engine.state()).toMatchObject({ playing: false, mode: 'off', error: 'tab-hidden' });
		await wait(100);
		expect(fake.elements[0]?.paused).toBe(true);
	});

	it('clamps the preview volume and ramps it while playing', async () => {
		const { engine } = makeEngine();
		engine.setVolume(-55);
		expect(engine.state().volumeDb).toBe(-40);
		engine.setVolume(6);
		expect(engine.state().volumeDb).toBe(0);
		await engine.start('raw');
		engine.setVolume(-20);
		const volume = asFake(engine.buildChain([], 0).volume, FakeGainNode);
		expect(volume.gain.value).toBeCloseTo(dbToGain(-20), 12);
	});

	it('notifies listeners and stops notifying after unsubscribe', () => {
		const { engine } = makeEngine();
		const seen: number[] = [];
		const off = engine.onChange((state) => seen.push(state.volumeDb));
		engine.setVolume(-6);
		off();
		engine.setVolume(-7);
		expect(seen).toEqual([-6]);
	});
});

describe('files and persistence', () => {
	it('validates type and size', async () => {
		expect(validateAudioFile({ name: 'a.mp3', type: 'audio/mpeg', size: 10 })).toBeNull();
		expect(validateAudioFile({ name: 'a.mp3', type: '', size: 10 })).toBeNull();
		expect(validateAudioFile({ name: 'a.txt', type: 'text/plain', size: 10 })).toBe('invalid-file');
		expect(validateAudioFile({ name: 'a.mp3', type: 'audio/mpeg', size: 0 })).toBe('invalid-file');
		expect(validateAudioFile({ name: 'a.mp3', type: 'audio/mpeg', size: MAX_FILE_BYTES + 1 })).toBe(
			'too-large'
		);

		const { engine, fake } = makeEngine();
		await expect(engine.loadFile(audioFile('notes.txt', 'text/plain'))).rejects.toMatchObject({
			code: 'invalid-file'
		});
		expect(engine.state()).toMatchObject({ error: 'invalid-file', file: null });
		const big = audioFile();
		Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });
		await expect(engine.loadFile(big)).rejects.toMatchObject({ code: 'too-large' });
		expect(fake.elements).toHaveLength(0);
	});

	it('streams from an object URL, never decoding the file', async () => {
		const { engine, fake } = makeEngine();
		await engine.loadFile(audioFile('mix.mp3'));
		const element = fake.elements[0];
		expect(element?.src).toBe(fake.urls.created[0]);
		expect(element?.preload).toBe('metadata');
		element?.fireMetadata(185.4);
		expect(engine.state().file).toMatchObject({ name: 'mix.mp3', duration: 185.4 });
		engine.getContext();
		expect(onlyContext().mediaSources).toHaveLength(1);
		expect(onlyContext().mediaSources[0]?.mediaElement).toBe(element);
	});

	it('round-trips the file through IndexedDB', async () => {
		const idb = new FakeIDBFactory();
		const first = makeEngine(idb).engine;
		await first.loadFile(audioFile('kept.mp3', 'audio/mpeg', 4096));
		expect(first.state()).toMatchObject({ persisted: true, source: 'file' });

		const db = idb.databases.get(DB_NAME);
		expect(db?.version).toBe(1);
		expect([...(db?.stores.keys() ?? [])].sort()).toEqual(['audio', 'library', 'outbox']);
		expect(idb.peek(DB_NAME, AUDIO_STORE, AUDIO_KEY)).toMatchObject({
			name: 'kept.mp3',
			type: 'audio/mpeg',
			size: 4096
		});

		const second = makeEngine(idb).engine;
		expect(second.state().file).toBeNull();
		await second.restore();
		expect(second.state()).toMatchObject({
			source: 'file',
			persisted: true,
			file: { name: 'kept.mp3', type: 'audio/mpeg', size: 4096 }
		});
		expect(idb.openConnections.size).toBe(0);
	});

	it('keeps the file for the page when the browser refuses to store it', async () => {
		const idb = new FakeIDBFactory();
		idb.failWrites = true;
		const { engine } = makeEngine(idb);
		await engine.loadFile(audioFile());
		expect(engine.state()).toMatchObject({ persisted: false, source: 'file' });
		expect(idb.openConnections.size).toBe(0);
	});

	it('opens a database another layer already upgraded', async () => {
		const idb = new FakeIDBFactory();
		idb.databases.set(DB_NAME, {
			version: 3,
			stores: new Map<string, Map<string, unknown>>([
				['audio', new Map()],
				['library', new Map()],
				['outbox', new Map()]
			])
		});
		const { engine } = makeEngine(idb);
		await engine.loadFile(audioFile('later.mp3'));
		expect(engine.state().persisted).toBe(true);
		expect(idb.peek(DB_NAME, AUDIO_STORE, AUDIO_KEY)).toMatchObject({ name: 'later.mp3' });
	});

	it('removing the file falls back to pink noise and forgets the stored copy', async () => {
		const idb = new FakeIDBFactory();
		const { engine, fake } = makeEngine(idb);
		await engine.loadFile(audioFile());
		engine.buildChain(PADRAO_AURI.bands, PADRAO_AURI.preampDb);
		await engine.start();
		const context = onlyContext();
		const element = fake.elements[0];
		expect(element?.paused).toBe(false);
		expect(context.bufferSources).toHaveLength(0);

		await engine.removeFile();
		expect(engine.state()).toMatchObject({ source: 'noise', file: null, playing: true });
		expect(element?.paused).toBe(true);
		expect(element?.removedAttributes).toContain('src');
		expect(fake.urls.revoked).toEqual(fake.urls.created);
		const noise = asFake(context.bufferSources[0], FakeBufferSourceNode);
		expect(noise.started).toBe(true);
		expect(noise.loop).toBe(true);
		expect(noise.connections).toEqual([asFake(engine.getSourceBus(), FakeGainNode)]);
		expect(noise.buffer?.sampleRate).toBe(96000);
		expect(context.mediaSources[0]?.connections).toEqual([]);

		expect(idb.peek(DB_NAME, AUDIO_STORE, AUDIO_KEY)).toBeUndefined();
		const fresh = makeEngine(idb).engine;
		await fresh.restore();
		expect(fresh.state().file).toBeNull();
	});
});

describe('dispose', () => {
	it('closes the context and releases every resource', async () => {
		const { engine, fake } = makeEngine(new FakeIDBFactory());
		await engine.loadFile(audioFile());
		const chain = engine.buildChain(PADRAO_AURI.bands, PADRAO_AURI.preampDb, { id: 'c' });
		engine.getAnalyserTap();
		await engine.start();
		const context: FakeAudioContext = onlyContext();
		expect(fake.document.listenerCount).toBe(1);

		await engine.dispose();
		expect(context.state).toBe('closed');
		expect(context.closeCalls).toBe(1);
		expect(fake.urls.revoked).toEqual(fake.urls.created);
		expect(fake.elements[0]?.paused).toBe(true);
		expect(fake.document.listenerCount).toBe(0);
		expect(engine.getChainOutput('c')).toBeNull();
		for (const node of [chain.input, chain.preamp, chain.output]) {
			expect(asFake(node, FakeGainNode).connections).toEqual([]);
		}
		for (const stage of chain.stages) {
			expect(asFake(stage, FakeIIRFilterNode).connections).toEqual([]);
		}
		expect(engine.state()).toMatchObject({ ready: false, playing: false, file: null });
		await engine.dispose();
		expect(context.closeCalls).toBe(1);
	});
});
