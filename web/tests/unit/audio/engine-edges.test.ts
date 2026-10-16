import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
	createAudioEngine,
	disposeAudioEngine,
	getAudioEngine,
	type AudioEngine
} from '#lib/audio/engine.ts';
import { asFake, FakeGainNode, fakeEnv, onlyContext, resetAudioConfig } from './fake-audio.ts';

const engines: AudioEngine[] = [];

beforeEach(() => {
	resetAudioConfig();
});

afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.dispose();
	await disposeAudioEngine();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function setup() {
	const fake = fakeEnv(null);
	const engine = createAudioEngine(fake.env);
	engines.push(engine);
	return { engine, fake };
}

function file(name = 'Preview.wav') {
	return new File(['audio'], name, { type: 'audio/wav' });
}

test('a throwing listener cannot prevent later listeners from receiving engine state', () => {
	const { engine } = setup();
	const failure = new Error('Consumer failed');
	const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	engine.onChange(() => {
		throw failure;
	});
	const next = vi.fn();
	engine.onChange(next);
	engine.setVolume(-8);
	expect(next).toHaveBeenCalledWith(expect.objectContaining({ volumeDb: -8 }));
	expect(log).toHaveBeenCalledWith('audio engine listener failed', failure);
});

test('resume rejections and a resolved-but-still-suspended context both report suspended playback', async () => {
	const { engine } = setup();
	engine.getContext();
	const context = onlyContext();
	const denied = new Error('Resume denied');
	const resume = vi.spyOn(context, 'resume').mockRejectedValueOnce(denied);
	await expect(engine.start()).rejects.toMatchObject({ code: 'suspended', cause: denied });
	resume.mockResolvedValueOnce(undefined);
	await expect(engine.start()).rejects.toMatchObject({ code: 'suspended' });
	expect(engine.state()).toMatchObject({ playing: false, error: 'suspended' });
});

test('benign play aborts do not become decode errors, but autoplay denial is suspended', async () => {
	const { engine, fake } = setup();
	await engine.loadFile(file());
	fake.elements[0].playFailure = 'AbortError';
	await expect(engine.start('raw')).resolves.toBeUndefined();
	expect(engine.state().error).toBeNull();
	fake.elements[0].playFailure = 'NotAllowedError';
	await expect(engine.start('raw')).rejects.toMatchObject({ code: 'suspended' });
	expect(engine.state().playing).toBe(false);
});

test('switching modes and restarting during a stop fade does not pause the new playback', async () => {
	vi.useFakeTimers();
	const { engine, fake } = setup();
	await engine.loadFile(file());
	await engine.start('chains');
	await engine.toggleRaw();
	expect(engine.state().mode).toBe('raw');
	await engine.toggleRaw();
	expect(engine.state().playing).toBe(false);
	await engine.toggleRaw();
	await vi.advanceTimersByTimeAsync(100);
	expect(engine.state()).toMatchObject({ mode: 'raw', playing: true });
	expect(fake.elements[0].paused).toBe(false);
	expect(onlyContext().mediaSources).toHaveLength(1);
});

test('context suspension is announced during playback but idle visibility changes never start or stop audio', async () => {
	const { engine, fake } = setup();
	engine.getContext();
	fake.document.hide();
	expect(engine.state().error).toBeNull();
	fake.document.visibilityState = 'visible';
	fake.document.dispatchEvent(new Event('visibilitychange'));
	await engine.start('raw');
	const context = onlyContext();
	context.state = 'suspended';
	context.dispatchEvent(new Event('statechange'));
	expect(engine.state().error).toBe('suspended');
});

test('muted chain setup, repeated disposal and stale chain handles do not reconnect the graph', async () => {
	const { engine } = setup();
	const chain = engine.buildChain([{ kind: 'OFF' }], -0.5, { id: 'muted', on: false, gainDb: -3 });
	const output = asFake(chain.output, FakeGainNode);
	expect(output.gain.value).toBe(0);
	chain.setGain(-6);
	expect(output.gain.value).toBeCloseTo(10 ** (-6 / 20));
	chain.dispose();
	chain.dispose();
	const events = output.gain.events.length;
	chain.setGain(0);
	expect(output.gain.events).toHaveLength(events);
	await engine.dispose();
	expect(output.connections).toEqual([]);
	const another = engine.buildChain([], 0);
	await engine.dispose();
	const oldOutput = asFake(another.output, FakeGainNode);
	const before = oldOutput.gain.events.length;
	another.setGain(0);
	another.dispose();
	expect(oldOutput.gain.events).toHaveLength(before);
	expect(oldOutput.connections).toEqual([]);
});

test('failure building the second A/B chain retires the first chain instead of leaking it', async () => {
	vi.useFakeTimers();
	const { engine } = setup();
	expect(() =>
		engine.createAB(
			{ bands: [{ kind: 'OFF' }], preampDb: -0.5 },
			{ bands: [{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 }], preampDb: -0.5 }
		)
	).toThrow(/experimental/);
	expect(engine.getChainOutput('chain-1')).toBeNull();
	await vi.advanceTimersByTimeAsync(50);
	expect(asFake(engine.getSourceBus(), FakeGainNode).connections).toHaveLength(1);
});

test('singleton creation is lazy and explicit disposal allows a fresh instance', async () => {
	await disposeAudioEngine();
	const first = getAudioEngine();
	expect(getAudioEngine()).toBe(first);
	expect(first.state()).toMatchObject({ ready: false, playing: false });
	await disposeAudioEngine();
	expect(getAudioEngine()).not.toBe(first);
	await disposeAudioEngine();
	await disposeAudioEngine();
});
