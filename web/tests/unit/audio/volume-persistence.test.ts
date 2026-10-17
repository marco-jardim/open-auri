import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createAudioEngine,
	dbToGain,
	IDLE_STATE,
	type AudioEngine,
	type AudioEngineEnv
} from '#lib/audio/engine.ts';
import {
	asFake,
	audioConfig,
	FakeGainNode,
	fakeEnv,
	onlyContext,
	resetAudioConfig
} from './fake-audio.ts';

const engines: AudioEngine[] = [];

function storage(initial: string | null = null) {
	const data = new Map<string, string>();
	if (initial !== null) data.set('oa.audio.volume', initial);
	return {
		data,
		getItem: vi.fn((key: string) => data.get(key) ?? null),
		setItem: vi.fn((key: string, value: string) => {
			data.set(key, value);
		})
	};
}

function setup(options: AudioEngineEnv = {}) {
	const fake = fakeEnv(null);
	const engine = createAudioEngine({ ...fake.env, ...options });
	engines.push(engine);
	return engine;
}

beforeEach(() => {
	resetAudioConfig();
});

afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.dispose();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('browser-only preview volume persistence', () => {
	it('defaults to −6 dB on a first visit without writing storage or starting audio', () => {
		const local = storage();
		vi.stubGlobal('window', { localStorage: local });
		const engine = setup();
		expect(IDLE_STATE.volumeDb).toBe(-6);
		expect(engine.state()).toMatchObject({ volumeDb: -6, ready: false, playing: false });
		expect(local.getItem).toHaveBeenCalledExactlyOnceWith('oa.audio.volume');
		expect(local.setItem).not.toHaveBeenCalled();
		expect(audioConfig.instances).toHaveLength(0);
	});

	it('works during SSR without window or storage', () => {
		vi.stubGlobal('window', undefined);
		const engine = setup();
		expect(engine.state().volumeDb).toBe(-6);
		engine.setVolume(-20);
		expect(engine.state()).toMatchObject({ volumeDb: -20, ready: false, playing: false });
	});

	it('supports explicitly unavailable storage', () => {
		const engine = setup({ localStorage: null });
		expect(engine.state().volumeDb).toBe(-6);
		engine.setVolume(-20);
		expect(engine.state().volumeDb).toBe(-20);
	});

	it.each([-40, -20, 0])('restores stored %s dB exactly without autoplay or rewriting it', (db) => {
		const local = storage(String(db));
		const engine = setup({ localStorage: local });
		expect(engine.state()).toMatchObject({ volumeDb: db, ready: false, playing: false });
		expect(local.getItem).toHaveBeenCalledExactlyOnceWith('oa.audio.volume');
		expect(local.setItem).not.toHaveBeenCalled();
		expect(audioConfig.instances).toHaveLength(0);
	});

	it.each(['abc', '5', '-80', '', ' ', '-20.5', 'NaN', 'Infinity', 'null', '0x0'])(
		'falls back to −6 dB for corrupt or out-of-range storage %j',
		(stored) => {
			const local = storage(stored);
			const engine = setup({ localStorage: local });
			expect(engine.state().volumeDb).toBe(-6);
			expect(local.setItem).not.toHaveBeenCalled();
		}
	);

	it.each([
		[-20, -20],
		[-20.4, -20],
		[5, 0],
		[-80, -40]
	])('setVolume(%s) persists integer %s dB and restores it on a fresh engine', (input, db) => {
		const local = storage();
		const engine = setup({ localStorage: local });
		engine.setVolume(input);
		expect(engine.state().volumeDb).toBe(db);
		expect(local.setItem).toHaveBeenCalledExactlyOnceWith('oa.audio.volume', String(db));
		expect(local.data.get('oa.audio.volume')).toBe(String(db));
		expect(setup({ localStorage: local }).state().volumeDb).toBe(db);
	});

	it('reads once and never raises the master volume on source or curve changes', async () => {
		const local = storage('-20');
		const engine = setup({ localStorage: local });
		local.data.set('oa.audio.volume', '0');
		const ab = engine.createAB(
			{ bands: [{ kind: 'OFF' }], preampDb: 0 },
			{ bands: [{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 }], preampDb: -6 }
		);
		expect(ab.a.volume).toBe(ab.b.volume);
		const master = asFake(ab.a.volume, FakeGainNode);
		expect(master.gain.value).toBe(0);
		await engine.start('raw');
		expect(master.gain.value).toBeCloseTo(dbToGain(-20), 12);
		const events = [...master.gain.events];
		await engine.loadFile(new File(['audio'], 'preview.wav', { type: 'audio/wav' }));
		await engine.start('chains');
		ab.select('B');
		ab.select('A');
		ab.dispose();
		engine.buildChain([{ kind: 'OFF' }], -3);
		await engine.removeFile();
		await engine.restore();
		expect(engine.state().volumeDb).toBe(-20);
		expect(master.gain.events).toEqual(events);
		expect(local.getItem).toHaveBeenCalledOnce();
		expect(local.setItem).not.toHaveBeenCalled();
	});

	it('warns and falls back when the browser storage getter throws', () => {
		const failure = new Error('Storage access denied');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		vi.stubGlobal('window', {
			get localStorage() {
				throw failure;
			}
		});
		const engine = setup();
		expect(engine.state().volumeDb).toBe(-6);
		engine.setVolume(-20);
		expect(engine.state().volumeDb).toBe(-20);
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			'audio engine: could not access preview volume storage',
			failure
		);
	});

	it('keeps volume controls and faded playback working when storage reads and writes throw', async () => {
		const failure = new Error('Storage unavailable');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const local = {
			getItem: vi.fn(() => {
				throw failure;
			}),
			setItem: vi.fn(() => {
				throw failure;
			})
		};
		const engine = setup({ localStorage: local });
		expect(engine.state().volumeDb).toBe(-6);
		const chain = engine.buildChain([{ kind: 'OFF' }], 0);
		await engine.start();
		engine.setVolume(-18);
		expect(engine.state()).toMatchObject({ volumeDb: -18, playing: true, error: null });
		const master = asFake(chain.volume, FakeGainNode);
		expect(master.gain.value).toBeCloseTo(dbToGain(-18), 12);
		// A volume change right after start rides the rest of the 200 ms start fade-in (QA N2),
		// never faster than the 30 ms minimum.
		expect(master.gain.events.at(-1)?.time).toBeCloseTo(onlyContext().currentTime + 0.2, 12);
		expect(warn).toHaveBeenCalledWith('audio engine: could not restore preview volume', failure);
		expect(warn).toHaveBeenCalledWith('audio engine: could not store preview volume', failure);
	});
});
