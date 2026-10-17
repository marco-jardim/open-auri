// SEEK.1: transport of the shared preview engine (position, seek, restart, pause/resume, random
// start, loop, navbar toggle) and the pure helpers behind it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PADRAO_AURI } from 'open-auri/catalog';
import {
	DEFAULT_VOLUME_DB,
	FADE_IN_S,
	IDLE_STATE,
	PENDING_START_TIMEOUT_MS,
	POSITION_TICK_MS,
	SEEK_FADE_S,
	createAudioEngine,
	dbToGain,
	type AudioEngine,
	type AudioEngineEnv
} from '#lib/audio/engine.ts';
import {
	RANDOM_START_MAX,
	RANDOM_START_MIN,
	SEEK_END_GUARD_S,
	clampSeek,
	formatClock,
	knownDuration,
	randomStart,
	resolveStart,
	seekKeyTarget
} from '#lib/audio/transport.ts';
import {
	FakeAudioContext,
	FakeBufferSourceNode,
	FakeGainNode,
	asFake,
	audioConfig,
	fakeEnv,
	onlyContext,
	resetAudioConfig,
	type FakeAudioElement,
	type FakeEnv
} from './fake-audio.ts';

/** Deterministic uniform generator in [0, 1) (mulberry32). */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function audioFile(name = 'song.mp3'): File {
	return new File([new Uint8Array(2048)], name, { type: 'audio/mpeg' });
}

const curveA = { bands: PADRAO_AURI.bands, preampDb: PADRAO_AURI.preampDb };
const curveB = {
	bands: [{ kind: 'PK' as const, freqHz: 1000, gainDb: -3, qFactor: 1 }],
	preampDb: -6
};

let engines: AudioEngine[] = [];

function setup(options: AudioEngineEnv = {}): { engine: AudioEngine; fake: FakeEnv } {
	const fake = fakeEnv(null);
	const engine = createAudioEngine({ ...fake.env, ...options });
	engines.push(engine);
	return { engine, fake };
}

/** Loads a file and reports its length, as the element does after reading the header. */
async function withFile(
	engine: AudioEngine,
	fake: FakeEnv,
	seconds = 200
): Promise<FakeAudioElement> {
	await engine.loadFile(audioFile(`take-${fake.elements.length + 1}.mp3`));
	const element = fake.elements.at(-1);
	if (!element) throw new Error('no element');
	element.fireMetadata(seconds);
	return element;
}

function masterOf(context: FakeAudioContext): FakeGainNode {
	const master = context.nodes.find(
		(node): node is FakeGainNode =>
			node instanceof FakeGainNode && node.connections.includes(context.destination)
	);
	if (!master) throw new Error('no master');
	return master;
}

beforeEach(() => {
	resetAudioConfig();
	engines = [];
});

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(engines.map((engine) => engine.dispose()));
});

describe('transport helpers', () => {
	it('clamps seeks into [0, duration) with an end guard', () => {
		expect(clampSeek(-5, 200)).toBe(0);
		expect(clampSeek(50, 200)).toBe(50);
		expect(clampSeek(500, 200)).toBeCloseTo(200 - SEEK_END_GUARD_S, 12);
		expect(clampSeek(Number.POSITIVE_INFINITY, 200)).toBeCloseTo(200 - SEEK_END_GUARD_S, 12);
		expect(clampSeek(Number.NEGATIVE_INFINITY, 200)).toBe(0);
		expect(clampSeek(Number.NaN, 200)).toBe(0);
		expect(clampSeek(10, 0.04)).toBeCloseTo(0.02, 12);
		expect(clampSeek(10, 0)).toBe(0);
		expect(Object.is(clampSeek(-0, 10), -0)).toBe(false);
	});

	it('knows a usable length only when finite and positive', () => {
		expect(knownDuration(185.4)).toBe(185.4);
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, null, undefined]) {
			expect(knownDuration(value)).toBeNull();
		}
	});

	it('draws random starts uniformly inside [25 %, 75 %] with a seeded generator', () => {
		const random = seeded(0x5eed);
		const draws = Array.from({ length: 1000 }, () => randomStart(240, random));
		for (const at of draws) {
			expect(at).toBeGreaterThanOrEqual(240 * RANDOM_START_MIN);
			expect(at).toBeLessThan(240 * RANDOM_START_MAX);
		}
		// Spread over the whole window, not stuck at one point.
		expect(Math.min(...draws)).toBeLessThan(240 * 0.27);
		expect(Math.max(...draws)).toBeGreaterThan(240 * 0.73);
		const mean = draws.reduce((sum, at) => sum + at, 0) / draws.length;
		expect(mean).toBeGreaterThan(240 * 0.47);
		expect(mean).toBeLessThan(240 * 0.53);
		expect(randomStart(100, () => 0)).toBe(25);
		expect(randomStart(100, () => 1)).toBe(75);
		expect(randomStart(100, () => Number.NaN)).toBe(50);
	});

	it('resolves start requests against a known length', () => {
		expect(resolveStart('beginning', 200)).toBe(0);
		expect(resolveStart('random', 200, () => 0.5)).toBe(100);
		expect(resolveStart(42, 200)).toBe(42);
		expect(resolveStart(-3, 200)).toBe(0);
		expect(resolveStart(900, 200)).toBeCloseTo(200 - SEEK_END_GUARD_S, 12);
		expect(resolveStart(Number.NaN, 200)).toBe(0);
	});

	it('maps the seek bar keys: arrows ±5 s, pages ±10 %, Home and End', () => {
		expect(seekKeyTarget('ArrowRight', 83, 225)).toBe(88);
		expect(seekKeyTarget('ArrowUp', 83, 225)).toBe(88);
		expect(seekKeyTarget('ArrowLeft', 83, 225)).toBe(78);
		expect(seekKeyTarget('ArrowDown', 83, 225)).toBe(78);
		expect(seekKeyTarget('PageUp', 80, 200)).toBe(100);
		expect(seekKeyTarget('PageDown', 80, 200)).toBe(60);
		expect(seekKeyTarget('Home', 80, 200)).toBe(0);
		expect(seekKeyTarget('End', 80, 200)).toBeCloseTo(200 - SEEK_END_GUARD_S, 12);
		expect(seekKeyTarget('ArrowLeft', 2, 200)).toBe(0);
		expect(seekKeyTarget('ArrowRight', 198, 200)).toBeCloseTo(200 - SEEK_END_GUARD_S, 12);
		for (const key of ['Tab', 'Enter', ' ', 'a', 'Escape']) {
			expect(seekKeyTarget(key, 80, 200)).toBeNull();
		}
	});

	it('formats the clock as m:ss, or h:mm:ss from one hour', () => {
		expect(formatClock(0)).toBe('0:00');
		expect(formatClock(83.9)).toBe('1:23');
		expect(formatClock(225)).toBe('3:45');
		expect(formatClock(3725)).toBe('1:02:05');
		expect(formatClock(Number.NaN)).toBe('0:00');
		expect(formatClock(-3)).toBe('0:00');
	});
});

describe('state', () => {
	it('exposes position, duration, paused, loop and the toggle reason', async () => {
		expect(IDLE_STATE).toMatchObject({
			position: 0,
			duration: null,
			paused: false,
			loop: true,
			session: null,
			canToggle: false,
			toggleReason: 'no-session'
		});
		const { engine, fake } = setup();
		expect(engine.state()).toMatchObject({
			source: 'noise',
			position: 0,
			duration: null,
			loop: true
		});
		await engine.loadFile(audioFile());
		const element = fake.elements[0];
		if (!element) throw new Error('no element');
		// Before the metadata the length is unknown: nothing to seek yet.
		expect(engine.state()).toMatchObject({ source: 'file', duration: null });
		element.fireMetadata(185.4);
		element.currentTime = 42.5;
		expect(engine.state()).toMatchObject({ duration: 185.4, position: 42.5, loop: true });
		element.fireDurationChange(186);
		expect(engine.state().duration).toBe(186);
		await engine.removeFile();
		expect(engine.state()).toMatchObject({ source: 'noise', duration: null, position: 0 });
	});

	it('reports that Web Audio is missing as the toggle reason', async () => {
		const engine = createAudioEngine({ AudioContext: null, indexedDB: null, document: null });
		engines.push(engine);
		expect(engine.state()).toMatchObject({ canToggle: false, toggleReason: 'unsupported' });
		expect(await engine.togglePlayback()).toBe('unsupported');
	});
});

describe('seek and restart', () => {
	it('clamps to [0, duration) and jumps at once while stopped, without touching the master', async () => {
		const { engine, fake } = setup();
		const element = await withFile(engine, fake, 200);
		engine.getContext();
		const master = masterOf(onlyContext());
		const before = master.gain.events.length;
		expect(engine.seek(-5)).toBe(true);
		expect(element.currentTime).toBe(0);
		expect(engine.seek(500)).toBe(true);
		expect(element.currentTime).toBeCloseTo(200 - SEEK_END_GUARD_S, 12);
		expect(engine.seek(42)).toBe(true);
		expect(element.currentTime).toBe(42);
		expect(engine.state().position).toBe(42);
		expect(engine.seek(Number.NaN)).toBe(false);
		expect(element.currentTime).toBe(42);
		expect(engine.restart()).toBe(true);
		expect(element.currentTime).toBe(0);
		expect(master.gain.events).toHaveLength(before);
		expect(master.gain.value).toBe(0);
	});

	it('refuses pink noise and a file whose length is still unknown', async () => {
		const { engine, fake } = setup();
		expect(engine.seek(10)).toBe(false);
		expect(engine.restart()).toBe(false);
		await engine.loadFile(audioFile());
		expect(engine.seek(10)).toBe(false);
		expect(fake.elements[0]?.currentTime).toBe(0);
	});

	it('fades the master out for 30 ms, jumps, then fades back to the preview volume', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup();
		const element = await withFile(engine, fake, 200);
		await engine.start('raw');
		const context = onlyContext();
		const master = masterOf(context);
		// Well after the start's fade-in (the fake clock only moves by hand).
		context.currentTime += FADE_IN_S + 1;
		element.currentTime = 10;
		const listener = vi.fn();
		engine.onChange(listener);

		expect(engine.seek(120)).toBe(true);
		// The element has not moved yet; the reported position is already the target.
		expect(element.currentTime).toBe(10);
		expect(engine.state().position).toBe(120);
		const out = master.gain.events.at(-1);
		expect(out).toMatchObject({ type: 'linear', value: 0 });
		expect(out?.time).toBeCloseTo(context.currentTime + SEEK_FADE_S, 12);

		await vi.advanceTimersByTimeAsync(SEEK_FADE_S * 1000);
		expect(element.currentTime).toBe(120);
		const back = master.gain.events.at(-1);
		expect(back?.type).toBe('linear');
		expect(back?.value).toBeCloseTo(dbToGain(DEFAULT_VOLUME_DB), 12);
		expect(back?.time).toBeCloseTo(context.currentTime + SEEK_FADE_S, 12);
		expect(listener).toHaveBeenCalledWith(expect.objectContaining({ position: 120 }));
		expect(engine.state()).toMatchObject({ playing: true, position: 120 });
	});

	it('a seek during the start fade-in comes back over what remains of it, never faster', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup();
		await withFile(engine, fake, 200);
		await engine.start('raw');
		const context = onlyContext();
		const master = masterOf(context);
		const started = context.currentTime;
		const preview = dbToGain(DEFAULT_VOLUME_DB);
		// 50 ms into the 200 ms fade-in.
		context.currentTime = started + 0.05;
		expect(engine.seek(60)).toBe(true);
		expect(master.gain.events.at(-1)).toMatchObject({ type: 'linear', value: 0 });
		context.currentTime = started + 0.05 + SEEK_FADE_S;
		await vi.advanceTimersByTimeAsync(SEEK_FADE_S * 1000);
		const back = master.gain.events.at(-1);
		expect(back?.type).toBe('linear');
		expect(back?.value).toBeCloseTo(preview, 12);
		// Full volume when the start fade-in would have reached it, not 30 ms after the jump.
		expect(back?.time).toBeCloseTo(started + FADE_IN_S, 12);
		expect((back?.time ?? 0) - context.currentTime).toBeGreaterThan(SEEK_FADE_S);
		// A volume change late in the fade-in follows the same pace.
		context.currentTime = started + 0.15;
		engine.setVolume(-10);
		const volume = master.gain.events.at(-1);
		expect(volume?.value).toBeCloseTo(dbToGain(-10), 12);
		expect(volume?.time).toBeCloseTo(started + FADE_IN_S, 12);
		// Once the fade-in is over, a seek is the plain 30 ms fade again.
		context.currentTime = started + 5;
		engine.seek(10);
		await vi.advanceTimersByTimeAsync(SEEK_FADE_S * 1000);
		expect(master.gain.events.at(-1)?.time).toBeCloseTo(context.currentTime + SEEK_FADE_S, 12);
		for (const event of master.gain.events) {
			expect(event.value).toBeLessThanOrEqual(preview + 1e-12);
		}
	});

	it('rapid seeks apply only the last target and fade back in once', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup();
		const element = await withFile(engine, fake, 200);
		await engine.start('raw');
		const master = masterOf(onlyContext());
		const from = master.gain.events.length;
		engine.seek(10);
		engine.seek(20);
		await vi.advanceTimersByTimeAsync(SEEK_FADE_S * 1000 + 5);
		expect(element.currentTime).toBe(20);
		const ramps = master.gain.events.slice(from).filter((event) => event.type === 'linear');
		expect(ramps.map((event) => event.value > 0)).toEqual([false, false, true]);
	});

	it('a stop during the seek fade keeps the new position but never raises the master', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup();
		const element = await withFile(engine, fake, 200);
		await engine.start('raw');
		const master = masterOf(onlyContext());
		engine.seek(50);
		engine.stop();
		await vi.advanceTimersByTimeAsync(100);
		expect(element.currentTime).toBe(50);
		expect(element.paused).toBe(true);
		expect(master.gain.events.at(-1)).toMatchObject({ type: 'linear', value: 0 });
		expect(master.gain.value).toBe(0);
	});

	it('a volume change during the seek fade waits for the fade-in, which uses the new volume', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup();
		await withFile(engine, fake, 200);
		await engine.start('raw');
		const master = masterOf(onlyContext());
		engine.seek(30);
		engine.setVolume(-20);
		expect(master.gain.value).toBe(0);
		await vi.advanceTimersByTimeAsync(SEEK_FADE_S * 1000);
		expect(master.gain.value).toBeCloseTo(dbToGain(-20), 12);
	});

	it('a file replaced during the seek fade still gets the master back', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup();
		const first = await withFile(engine, fake, 200);
		await engine.start('raw');
		const master = masterOf(onlyContext());
		engine.seek(150);
		const second = await withFile(engine, fake, 90);
		await vi.advanceTimersByTimeAsync(SEEK_FADE_S * 1000);
		expect(second.currentTime).toBe(0);
		expect(first.currentTime).toBe(0);
		expect(master.gain.value).toBeCloseTo(dbToGain(DEFAULT_VOLUME_DB), 12);
		expect(engine.state()).toMatchObject({ playing: true, position: 0, duration: 90 });
	});

	it('restart goes back to the beginning with the same fade while playing', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup();
		const element = await withFile(engine, fake, 200);
		await engine.start('raw');
		element.currentTime = 77;
		expect(engine.restart()).toBe(true);
		expect(engine.state().position).toBe(0);
		await vi.advanceTimersByTimeAsync(SEEK_FADE_S * 1000);
		expect(element.currentTime).toBe(0);
	});
});

describe('pause and resume', () => {
	it('keep the position, the chains, the A/B selection and the trims', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup();
		const element = await withFile(engine, fake, 180);
		const ab = engine.createAB(curveA, curveB, { experimental: true, initial: 'B' });
		await engine.start('chains', { session: 'curva' });
		const context = onlyContext();
		const master = masterOf(context);
		element.currentTime = 64;
		const outA = asFake(ab.a.output, FakeGainNode);
		const outB = asFake(ab.b.output, FakeGainNode);
		const eventsA = outA.gain.events.length;
		const eventsB = outB.gain.events.length;
		const filters = context.filters.length;
		const trims = [...ab.trims];

		engine.pause();
		expect(engine.state()).toMatchObject({
			mode: 'off',
			playing: false,
			paused: true,
			session: 'curva',
			canToggle: true,
			toggleReason: null,
			position: 64
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(element.paused).toBe(true);
		expect(master.gain.value).toBe(0);
		expect(engine.getChainOutput(ab.a.id)).toBe(ab.a.output);
		expect(engine.getChainOutput(ab.b.id)).toBe(ab.b.output);

		expect(await engine.resume()).toBe(true);
		expect(engine.state()).toMatchObject({
			mode: 'chains',
			playing: true,
			paused: false,
			session: 'curva',
			position: 64
		});
		expect(element.paused).toBe(false);
		expect(element.currentTime).toBe(64);
		expect(ab.selected()).toBe('B');
		expect([...ab.trims]).toEqual(trims);
		expect(outA.gain.events).toHaveLength(eventsA);
		expect(outB.gain.events).toHaveLength(eventsB);
		expect(outA.gain.value).toBe(0);
		expect(outB.gain.value).toBeCloseTo(dbToGain(trims[1] ?? Number.NaN), 12);
		expect(context.filters).toHaveLength(filters);
		expect(context.mediaSources).toHaveLength(1);
		// The same 200 ms fade-in as a start, from silence to the preview volume.
		const fade = master.gain.events.at(-1);
		expect(fade?.type).toBe('linear');
		expect(fade?.value).toBeCloseTo(dbToGain(DEFAULT_VOLUME_DB), 12);
		expect(fade?.time).toBeCloseTo(context.currentTime + FADE_IN_S, 12);
	});

	it('resume needs no new gesture while the context runs, but start always does', async () => {
		let active: boolean | null = true;
		const { engine, fake } = setup({ hasUserActivation: () => active });
		await withFile(engine, fake, 120);
		await engine.start('raw');
		engine.pause();
		active = false;
		await expect(engine.start('raw')).rejects.toMatchObject({ code: 'gesture' });
		expect(engine.state().paused).toBe(true);
		expect(await engine.resume()).toBe(true);
		expect(engine.state()).toMatchObject({ playing: true, mode: 'raw', error: null });
		expect(await engine.resume()).toBe(true);
	});

	it('a suspended context reports the gesture error and keeps the session paused', async () => {
		let active: boolean | null = null;
		const { engine, fake } = setup({ hasUserActivation: () => active });
		await withFile(engine, fake, 120);
		await engine.start('raw');
		engine.pause();
		const context = onlyContext();
		context.state = 'suspended';
		context.dispatchEvent(new Event('statechange'));
		active = false;
		await expect(engine.resume()).rejects.toMatchObject({ code: 'gesture' });
		expect(engine.state()).toMatchObject({ playing: false, paused: true, error: 'gesture' });
		expect(await engine.togglePlayback()).toBe('failed');
		active = true;
		expect(await engine.togglePlayback()).toBe('resumed');
		expect(context.state).toBe('running');
		expect(engine.state()).toMatchObject({ playing: true, error: null });
	});

	it('stop ends the session, whether playing or paused', async () => {
		const { engine } = setup();
		await engine.start('raw', { session: 'comparar' });
		engine.stop();
		expect(engine.state()).toMatchObject({
			paused: false,
			session: null,
			canToggle: false,
			toggleReason: 'no-session'
		});
		expect(await engine.resume()).toBe(false);

		await engine.start('raw', { session: 'comparar' });
		engine.pause();
		expect(engine.state().paused).toBe(true);
		const seen = vi.fn();
		engine.onChange(seen);
		engine.stop();
		expect(seen).toHaveBeenCalledWith(expect.objectContaining({ paused: false, session: null }));
		engine.stop();
		expect(seen).toHaveBeenCalledOnce();
	});

	it('a paused chain session ends when the page disposes its last chain', async () => {
		const { engine } = setup();
		const first = engine.buildChain([{ kind: 'OFF' }], 0);
		const second = engine.buildChain([{ kind: 'OFF' }], -1);
		await engine.start('chains');
		engine.pause();
		first.dispose();
		expect(engine.state().paused).toBe(true);
		const seen = vi.fn();
		engine.onChange(seen);
		second.dispose();
		expect(engine.state()).toMatchObject({ paused: false, session: null, canToggle: false });
		expect(seen).toHaveBeenCalledOnce();
		// Chains another page builds later do not revive it.
		engine.buildChain([{ kind: 'OFF' }], 0);
		expect(engine.state().paused).toBe(false);
		expect(await engine.togglePlayback()).toBe('no-session');
		expect(engine.state().playing).toBe(false);
	});

	it('pausing a chain session without chains leaves nothing to resume', async () => {
		const { engine } = setup();
		await engine.start('chains');
		engine.pause();
		expect(engine.state()).toMatchObject({ paused: false, session: null });
	});

	it('a hidden tab pauses (resumable), and the toggle continues it', async () => {
		const { engine, fake } = setup();
		await withFile(engine, fake, 90);
		await engine.start('raw', { session: 'teste-cego' });
		fake.document.hide();
		expect(engine.state()).toMatchObject({
			playing: false,
			paused: true,
			error: 'tab-hidden',
			session: 'teste-cego'
		});
		expect(await engine.togglePlayback()).toBe('resumed');
		expect(engine.state()).toMatchObject({ playing: true, error: null, mode: 'raw' });
	});
});

describe('random start', () => {
	it('lands uniformly in [25 %, 75 %] of the loaded file (seeded generator)', async () => {
		const random = seeded(0xa0d10);
		const draws: number[] = [];
		const { engine, fake } = setup({
			random: () => {
				const draw = random();
				draws.push(draw);
				return draw;
			}
		});
		const element = await withFile(engine, fake, 240);
		const starts: number[] = [];
		for (let i = 0; i < 60; i++) {
			await engine.start('chains', { startAt: 'random' });
			starts.push(element.currentTime);
			engine.stop();
		}
		expect(draws).toHaveLength(60);
		starts.forEach((at, i) => {
			expect(at).toBeGreaterThanOrEqual(240 * RANDOM_START_MIN);
			expect(at).toBeLessThan(240 * RANDOM_START_MAX);
			expect(at).toBeCloseTo(240 * (0.25 + 0.5 * (draws[i] ?? Number.NaN)), 9);
		});
		expect(new Set(starts).size).toBeGreaterThan(50);
	});

	it('jumps before the fade-in when starting from silence', async () => {
		const { engine, fake } = setup({ random: () => 0.5 });
		const element = await withFile(engine, fake, 100);
		await engine.start('raw', { startAt: 'random', session: 'teste-cego' });
		expect(element.currentTime).toBe(50);
		expect(engine.state()).toMatchObject({ position: 50, playing: true, session: 'teste-cego' });
		const master = masterOf(onlyContext());
		// No seek fade: the master was silent and only fades in.
		expect(master.gain.events.filter((event) => event.type === 'linear')).toHaveLength(1);
	});

	it('waits for the metadata when the length is not known yet', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup({ random: () => 0.5 });
		await engine.loadFile(audioFile());
		const element = fake.elements[0];
		if (!element) throw new Error('no element');
		await engine.start('raw', { startAt: 'random' });
		expect(element.currentTime).toBe(0);
		element.fireMetadata(80);
		await vi.advanceTimersByTimeAsync(SEEK_FADE_S * 1000);
		expect(element.currentTime).toBe(40);
	});

	it('keeps the master silent until a deferred random start lands, then fades in', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup({ random: () => 0.5 });
		await engine.loadFile(audioFile());
		const element = fake.elements[0];
		if (!element) throw new Error('no element');
		await engine.start('raw', { startAt: 'random', session: 'teste-cego' });
		const context = onlyContext();
		const master = masterOf(context);
		const preview = dbToGain(DEFAULT_VOLUME_DB);
		// The element plays from the gesture (never later on its own), but nothing is heard.
		expect(element.playCalls).toBe(1);
		expect(master.gain.value).toBe(0);
		expect(master.gain.events.some((event) => event.value > 0)).toBe(false);
		// A length that is not finite yet keeps waiting, still silent.
		element.fireDurationChange(Number.POSITIVE_INFINITY);
		expect(element.currentTime).toBe(0);
		expect(master.gain.value).toBe(0);
		// A volume change while it waits does not unmute either.
		engine.setVolume(-12);
		expect(master.gain.value).toBe(0);
		await vi.advanceTimersByTimeAsync(SEEK_FADE_S * 1000);
		expect(master.gain.value).toBe(0);
		// The length arrives: jump first, then the full 200 ms fade-in from silence.
		element.fireDurationChange(80);
		expect(element.currentTime).toBe(40);
		const [silence, fadeIn] = master.gain.events.slice(-2);
		expect(silence).toMatchObject({ type: 'set', value: 0, time: context.currentTime });
		expect(fadeIn?.type).toBe('linear');
		expect(fadeIn?.value).toBeCloseTo(dbToGain(-12), 12);
		expect(fadeIn?.time).toBeCloseTo(context.currentTime + FADE_IN_S, 12);
		expect(engine.state()).toMatchObject({ playing: true, position: 40, duration: 80 });
		for (const event of master.gain.events) {
			expect(event.value).toBeLessThanOrEqual(preview + 1e-12);
		}
	});

	it.each(['stop', 'pause'] as const)(
		'%s cancels a deferred start before late metadata arrives',
		async (halt) => {
			vi.useFakeTimers();
			const random = vi.fn(() => 0.5);
			const { engine, fake } = setup({ random });
			await engine.loadFile(audioFile());
			const element = fake.elements[0];
			if (!element) throw new Error('no element');
			await engine.start('raw', { startAt: 'random', session: 'teste-cego' });
			const master = masterOf(onlyContext());
			expect(master.gain.value).toBe(0);

			engine[halt]();
			await vi.advanceTimersByTimeAsync(100);
			const events = master.gain.events.length;
			element.fireMetadata(80);
			element.fireDurationChange(90);
			await vi.advanceTimersByTimeAsync(PENDING_START_TIMEOUT_MS);

			expect(random).not.toHaveBeenCalled();
			expect(element.currentTime).toBe(0);
			expect(element.paused).toBe(true);
			expect(element.playCalls).toBe(1);
			expect(master.gain.value).toBe(0);
			expect(master.gain.events).toHaveLength(events);
			expect(engine.state()).toMatchObject({
				mode: 'off',
				playing: false,
				paused: halt === 'pause',
				session: halt === 'pause' ? 'teste-cego' : null,
				position: 0
			});
		}
	);

	it('a stopped deferred start cannot time out or leak into a new session without startAt', async () => {
		vi.useFakeTimers();
		const random = vi.fn(() => 0.5);
		const { engine, fake } = setup({ random });
		await engine.loadFile(audioFile());
		const element = fake.elements[0];
		if (!element) throw new Error('no element');
		await engine.start('raw', { startAt: 'random', session: 'teste-cego' });
		engine.stop();
		await vi.advanceTimersByTimeAsync(100);

		await engine.start('raw', { session: 'audio-panel' });
		const master = masterOf(onlyContext());
		expect(master.gain.value).toBeCloseTo(dbToGain(DEFAULT_VOLUME_DB), 12);
		const events = master.gain.events.length;
		element.currentTime = 7;
		await vi.advanceTimersByTimeAsync(PENDING_START_TIMEOUT_MS);
		expect(element.currentTime).toBe(7);
		expect(master.gain.events).toHaveLength(events);
		element.fireMetadata(80);
		expect(random).not.toHaveBeenCalled();
		expect(element.currentTime).toBe(7);
		expect(element.playCalls).toBe(2);
		expect(engine.state()).toMatchObject({ playing: true, position: 7, session: 'audio-panel' });
	});

	it('starts at 0 and says so when the length stays unknown for 1.5 s', async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { engine, fake } = setup({ random: () => 0.5 });
		await engine.loadFile(audioFile());
		const element = fake.elements[0];
		if (!element) throw new Error('no element');
		await engine.start('raw', { startAt: 'random' });
		const context = onlyContext();
		const master = masterOf(context);
		element.fireDurationChange(Number.POSITIVE_INFINITY);
		// Played silently while it waited.
		element.currentTime = 1.4;
		await vi.advanceTimersByTimeAsync(PENDING_START_TIMEOUT_MS - 10);
		expect(master.gain.value).toBe(0);
		expect(warn).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(10);
		expect(warn).toHaveBeenCalledOnce();
		expect(element.currentTime).toBe(0);
		const fadeIn = master.gain.events.at(-1);
		expect(fadeIn?.type).toBe('linear');
		expect(fadeIn?.value).toBeCloseTo(dbToGain(DEFAULT_VOLUME_DB), 12);
		expect(fadeIn?.time).toBeCloseTo(context.currentTime + FADE_IN_S, 12);
		// A length found later no longer moves the playing file.
		element.currentTime = 3;
		element.fireDurationChange(80);
		await vi.advanceTimersByTimeAsync(SEEK_FADE_S * 1000);
		expect(element.currentTime).toBe(3);
		warn.mockRestore();
	});

	it('the beginning needs no length: it plays at once with the normal fade-in', async () => {
		const { engine, fake } = setup();
		await engine.loadFile(audioFile());
		const element = fake.elements[0];
		if (!element) throw new Error('no element');
		await engine.start('raw', { startAt: 'beginning' });
		const context = onlyContext();
		const fadeIn = masterOf(context).gain.events.at(-1);
		expect(fadeIn?.type).toBe('linear');
		expect(fadeIn?.time).toBeCloseTo(context.currentTime + FADE_IN_S, 12);
		expect(element.currentTime).toBe(0);
	});

	it('uses the seek fade when the preview is already audible', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup({ random: () => 0 });
		const element = await withFile(engine, fake, 200);
		await engine.start('raw');
		element.currentTime = 5;
		const master = masterOf(onlyContext());
		await engine.start('chains', { startAt: 'random' });
		expect(master.gain.events.at(-1)).toMatchObject({ type: 'linear', value: 0 });
		expect(element.currentTime).toBe(5);
		await vi.advanceTimersByTimeAsync(SEEK_FADE_S * 1000);
		expect(element.currentTime).toBe(50);
		expect(master.gain.events.at(-1)?.value).toBeCloseTo(dbToGain(DEFAULT_VOLUME_DB), 12);
	});

	it('a file loaded during a random-start session starts at a random point too', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup({ random: () => 0.5 });
		await withFile(engine, fake, 200);
		await engine.start('chains', { startAt: 'random' });
		const next = await withFile(engine, fake, 80);
		await vi.advanceTimersByTimeAsync(SEEK_FADE_S * 1000);
		expect(next.currentTime).toBe(40);
		expect(engine.state()).toMatchObject({ position: 40, playing: true });
	});

	it('a file loaded during a random-start session is silent until its random point', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup({ random: () => 0.5 });
		await withFile(engine, fake, 200);
		await engine.start('raw', { startAt: 'random', session: 'comparar' });
		const context = onlyContext();
		const master = masterOf(context);
		expect(master.gain.value).toBeGreaterThan(0);
		await engine.loadFile(audioFile('next.mp3'));
		const next = fake.elements.at(-1);
		if (!next) throw new Error('no element');
		// The new element plays from its start: the master is already at 0.
		expect(master.gain.value).toBe(0);
		await vi.advanceTimersByTimeAsync(SEEK_FADE_S * 1000);
		expect(master.gain.value).toBe(0);
		next.fireMetadata(80);
		expect(next.currentTime).toBe(40);
		expect(master.gain.events.at(-1)?.time).toBeCloseTo(context.currentTime + FADE_IN_S, 12);
		expect(master.gain.value).toBeCloseTo(dbToGain(DEFAULT_VOLUME_DB), 12);
		// Removing a file whose start still waits brings the master back on the noise.
		await engine.loadFile(audioFile('third.mp3'));
		expect(master.gain.value).toBe(0);
		await engine.removeFile();
		expect(engine.state()).toMatchObject({ source: 'noise', playing: true });
		expect(master.gain.value).toBeCloseTo(dbToGain(DEFAULT_VOLUME_DB), 12);
	});

	it('honours the beginning and an explicit second, and pink noise ignores it', async () => {
		const random = vi.fn(() => 0.5);
		const { engine, fake } = setup({ random });
		await engine.start('chains', { startAt: 'random' });
		expect(random).not.toHaveBeenCalled();
		expect(onlyContext().bufferSources[0]?.started).toBe(true);
		expect(engine.state()).toMatchObject({ source: 'noise', position: 0, duration: null });
		engine.stop();

		const element = await withFile(engine, fake, 200);
		element.currentTime = 33;
		await engine.start('raw', { startAt: 'beginning' });
		expect(element.currentTime).toBe(0);
		engine.stop();
		await engine.start('raw', { startAt: 1000 });
		expect(element.currentTime).toBeCloseTo(200 - SEEK_END_GUARD_S, 12);
		engine.stop();
		element.currentTime = 12;
		await engine.start('raw');
		expect(element.currentTime).toBe(12);
	});
});

describe('loop', () => {
	it('always loops the file and the noise', async () => {
		const { engine, fake } = setup();
		await engine.start('raw');
		const noise = asFake(onlyContext().bufferSources[0], FakeBufferSourceNode);
		expect(noise.loop).toBe(true);
		expect(engine.state().loop).toBe(true);
		const element = await withFile(engine, fake, 60);
		expect(element.loop).toBe(true);
		element.loop = false;
		await engine.start('chains');
		expect(element.loop).toBe(true);
		expect(engine.state().loop).toBe(true);
	});
});

describe('togglePlayback (navbar)', () => {
	it('never makes sound without a session a page started', async () => {
		const { engine, fake } = setup();
		await withFile(engine, fake, 60);
		expect(engine.state()).toMatchObject({ canToggle: false, toggleReason: 'no-session' });
		expect(await engine.togglePlayback()).toBe('no-session');
		expect(audioConfig.instances).toHaveLength(0);
		expect(fake.elements[0]?.playCalls).toBe(0);
		expect(engine.state().playing).toBe(false);
	});

	it('pauses a playing preview and resumes the paused one, then nothing after a stop', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup();
		const element = await withFile(engine, fake, 60);
		await engine.start('raw', { session: 'biblioteca' });
		element.currentTime = 21;
		expect(engine.state()).toMatchObject({ canToggle: true, toggleReason: null });
		expect(await engine.togglePlayback()).toBe('paused');
		expect(engine.state()).toMatchObject({ playing: false, paused: true, canToggle: true });
		expect(await engine.togglePlayback()).toBe('resumed');
		expect(engine.state()).toMatchObject({ playing: true, position: 21, session: 'biblioteca' });

		engine.stop();
		await vi.advanceTimersByTimeAsync(100);
		const plays = element.playCalls;
		expect(await engine.togglePlayback()).toBe('no-session');
		await vi.advanceTimersByTimeAsync(100);
		expect(element.playCalls).toBe(plays);
		expect(element.paused).toBe(true);
		expect(masterOf(onlyContext()).gain.value).toBe(0);
	});
});

describe('position updates', () => {
	it('reach listeners at 5 Hz while playing, only when the position moved, and stop on pause', async () => {
		vi.useFakeTimers();
		const { engine, fake } = setup();
		const element = await withFile(engine, fake, 200);
		await engine.start('raw');
		const seen: number[] = [];
		engine.onChange((state) => seen.push(state.position));
		await vi.advanceTimersByTimeAsync(POSITION_TICK_MS);
		expect(seen).toEqual([]);
		element.currentTime = 1.5;
		await vi.advanceTimersByTimeAsync(POSITION_TICK_MS);
		expect(seen).toEqual([1.5]);
		element.currentTime = 1.75;
		await vi.advanceTimersByTimeAsync(POSITION_TICK_MS);
		expect(seen).toEqual([1.5, 1.75]);
		engine.pause();
		await vi.advanceTimersByTimeAsync(100);
		const count = seen.length;
		element.currentTime = 9;
		await vi.advanceTimersByTimeAsync(POSITION_TICK_MS * 3);
		expect(seen).toHaveLength(count);
		expect(engine.state().position).toBe(9);
	});
});
