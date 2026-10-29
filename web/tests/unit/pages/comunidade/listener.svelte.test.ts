import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { snapshotBands } from 'open-auri/dsp';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import {
	createListener,
	type ListenRequest
} from '#lib/components/pages/comunidade/listener.svelte.ts';
import { fakeEnv, resetAudioConfig } from '../../audio/fake-audio.ts';
import { NEUTRAL } from './fixtures.ts';

const engines: AudioEngine[] = [];
const listeners: ReturnType<typeof createListener>[] = [];
const request: ListenRequest = {
	a: { lineageId: 'a', curve: NEUTRAL },
	b: { lineageId: 'b', curve: NEUTRAL },
	initial: 'A',
	owner: 'unit'
};
/** A curve that differs from Neutro (a cut at 1 kHz, preamp -3 dB). */
const BOOST = {
	preampDb: -3,
	bands: snapshotBands([
		{ kind: 'PK' as const, freqHz: 1000, gainDb: -3, qFactor: 1.41 },
		...NEUTRAL.bands.slice(1)
	])
};
const boosted: ListenRequest = {
	a: { lineageId: 'a', curve: BOOST },
	b: { lineageId: 'b', curve: NEUTRAL },
	initial: 'A',
	owner: 'unit'
};
const FLAT = { bands: snapshotBands(NEUTRO.bands), preampDb: NEUTRO.preampDb };

function setup(options: { flat?: () => boolean } = {}) {
	const audio = createAudioEngine(fakeEnv(null).env);
	engines.push(audio);
	let time = 0;
	const timers = new Map<number, () => void>();
	let sequence = 0;
	const previewed = vi.fn();
	const listener = createListener({
		engine: () => audio,
		now: () => time,
		onPreviewed: previewed,
		...(options.flat ? { flat: options.flat } : {}),
		setTimer: (callback) => {
			timers.set(++sequence, callback);
			return sequence;
		},
		clearTimer: (handle) => {
			if (typeof handle === 'number') timers.delete(handle);
		}
	});
	listeners.push(listener);
	return {
		audio,
		listener,
		previewed,
		timers,
		advance: (ms: number) => {
			time += ms;
		}
	};
}
beforeEach(resetAudioConfig);
afterEach(async () => {
	listeners.splice(0).forEach((listener) => listener.stop());
	await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
	vi.restoreAllMocks();
});

test('idle controls are inert, missing audio rejects, and public readouts remain empty', async () => {
	const listener = createListener({ engine: () => null });
	listener.select('B');
	listener.pause();
	expect(await listener.resume()).toBe(false);
	expect(listener.engine).toBeNull();
	expect(listener.active).toBeNull();
	expect(listener.side).toBeNull();
	expect(listener.owner).toBeNull();
	expect(listener.trims).toBeNull();
	expect(listener.chainOf('a')).toBeNull();
	expect(listener.isPlaying('a')).toBe(false);
	expect(listener.audibleMs('missing')).toBe(0);
	await expect(listener.play(request)).rejects.toThrow('audio-unavailable');
	expect(listener.busy).toBe(false);
});

test('side changes expose only the audible chain and preserve separate elapsed totals', async () => {
	const { audio, listener, advance } = setup();
	const create = vi.spyOn(audio, 'createAB');
	await listener.play(request);
	const pair = create.mock.results[0]?.value;
	expect(listener.chainOf('a')).toBe(pair.a);
	expect(listener.chainOf('b')).toBeNull();
	expect(listener.isPlaying('b')).toBe(false);
	advance(4000);
	listener.select('B');
	expect(listener.audibleMs('a')).toBe(4000);
	expect(listener.chainOf('b')).toBe(pair.b);
	expect(listener.isPlaying('b')).toBe(true);
	advance(2000);
	listener.stop();
	expect(listener.audibleMs('b')).toBe(2000);
	expect(listener.chainOf('b')).toBeNull();
});

test('blind and editor sides reveal no chain or channel identity', async () => {
	const { listener, timers } = setup();
	await listener.play({ ...request, blind: true, initial: 'B' });
	expect(listener.isPlaying('b')).toBe(false);
	expect(listener.chainOf('b')).toBeNull();
	await listener.play({ ...request, a: { lineageId: null, curve: NEUTRAL } });
	expect(timers.size).toBe(0);
	expect(listener.chainOf('a')).toBeNull();
	expect(listener.isPlaying('a')).toBe(false);
});

test('an early timer does not report; reaching ten seconds reports only once per lineage', async () => {
	const { listener, advance, timers, previewed } = setup();
	const fire = () => {
		const entry = [...timers.entries()][0];
		if (!entry) throw new Error('Expected preview timer');
		timers.delete(entry[0]);
		entry[1]();
	};
	await listener.play(request);
	advance(9999);
	fire();
	expect(previewed).not.toHaveBeenCalled();
	advance(1);
	fire();
	expect(previewed).toHaveBeenCalledExactlyOnceWith('a', 10000);
	expect(timers.size).toBe(0);
	listener.select('B');
	advance(10000);
	fire();
	expect(previewed).toHaveBeenLastCalledWith('b', 10000);
	listener.select('A');
	advance(20000);
	listener.stop();
	expect(previewed).toHaveBeenCalledTimes(2);
	expect(listener.audibleMs('a')).toBe(30000);
});

test('pause hides LEDs, repeated pause is inert, resume keeps the pair', async () => {
	const { audio, listener, advance } = setup();
	const pause = vi.spyOn(audio, 'pause');
	await listener.play(request);
	expect(await listener.resume()).toBe(false);
	advance(2000);
	listener.pause();
	listener.pause();
	expect(pause).toHaveBeenCalledOnce();
	expect(listener.chainOf('a')).toBeNull();
	expect(listener.isPlaying('a')).toBe(false);
	listener.select('B');
	expect(listener.side).toBe('B');
	expect(await listener.resume()).toBe(true);
	expect(listener.isPlaying('b')).toBe(true);
	advance(-100);
	listener.stop();
	expect(listener.audibleMs('b')).toBe(0);
});

test('raw playback from another owner releases the pair without stopping that playback', async () => {
	const { audio, listener } = setup();
	await listener.play(request);
	const stop = vi.spyOn(audio, 'stop');
	await audio.start('raw', { session: 'other-page' });
	expect(listener.active).toBeNull();
	expect(stop).not.toHaveBeenCalled();
	expect(audio.state()).toMatchObject({ playing: true, session: 'other-page' });
});

test('a stopped pending start cannot resurrect a preview and disposes its pair', async () => {
	const { audio, listener } = setup();
	const original = audio.start.bind(audio);
	let finish: () => void = () => undefined;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	vi.spyOn(audio, 'start').mockImplementation(async (...args) => {
		await original(...args);
		await pending;
	});
	const create = vi.spyOn(audio, 'createAB');
	const playing = listener.play(request);
	expect(listener.busy).toBe(true);
	const dispose = vi.spyOn(create.mock.results[0].value, 'dispose');
	listener.stop();
	finish();
	await playing;
	expect(dispose).toHaveBeenCalledOnce();
	expect(listener.active).toBeNull();
	expect(listener.busy).toBe(false);
	expect(audio.state().playing).toBe(false);
});

test('the flat option gives createAB the Neutro curve on both sides; blind requests ignore it', async () => {
	const { audio, listener } = setup({ flat: () => true });
	const create = vi.spyOn(audio, 'createAB');
	await listener.play(boosted);
	expect(create.mock.calls[0]?.[0]).toMatchObject(FLAT);
	expect(create.mock.calls[0]?.[1]).toMatchObject(FLAT);
	await listener.play({ ...boosted, blind: true, owner: 's6' });
	expect(create.mock.calls[1]?.[0]).toEqual(BOOST);
	expect(create.mock.calls[1]?.[1]).toEqual(NEUTRAL);
	// A blind round is never rebuilt flat either.
	listener.refresh();
	expect(create).toHaveBeenCalledTimes(2);
});

test('refresh rebuilds the pair in place on the same side, without stopping the engine', async () => {
	let flat = false;
	const { audio, listener } = setup({ flat: () => flat });
	const create = vi.spyOn(audio, 'createAB');
	listener.refresh();
	expect(create).not.toHaveBeenCalled();
	await listener.play(boosted);
	listener.select('B');
	const first = create.mock.results[0]?.value;
	const dispose = vi.spyOn(first, 'dispose');
	const stop = vi.spyOn(audio, 'stop');
	const start = vi.spyOn(audio, 'start');
	flat = true;
	listener.refresh();
	expect(create).toHaveBeenCalledTimes(2);
	expect(create.mock.calls[1]?.[0]).toMatchObject(FLAT);
	expect(create.mock.calls[1]?.[1]).toMatchObject(FLAT);
	expect(create.mock.calls[1]?.[2]).toEqual({ experimental: true, initial: 'B' });
	expect(dispose).toHaveBeenCalledOnce();
	expect(stop).not.toHaveBeenCalled();
	expect(start).not.toHaveBeenCalled();
	expect(audio.state().playing).toBe(true);
	const second = create.mock.results[1]?.value;
	expect(listener.side).toBe('B');
	// Flat: the cable's curve plays, so no channel claims it (no LED chain, no "playing").
	expect(listener.chainOf('b')).toBeNull();
	expect(listener.isPlaying('b')).toBe(false);
	expect(listener.trims).toBe(second.trims);
	// Already flat: a second refresh rebuilds nothing.
	listener.refresh();
	expect(create).toHaveBeenCalledTimes(2);
	// Back to the curves: the real bands again, still the same session.
	flat = false;
	listener.refresh();
	expect(create.mock.calls[2]).toEqual([BOOST, NEUTRAL, { experimental: true, initial: 'B' }]);
	expect(listener.chainOf('b')).toBe(create.mock.results[2]?.value.b);
	expect(listener.isPlaying('b')).toBe(true);
	expect(stop).not.toHaveBeenCalled();
});

test('a flat change while the start is pending rebuilds the pair flat once it starts', async () => {
	let flat = false;
	const { audio, listener } = setup({ flat: () => flat });
	const original = audio.start.bind(audio);
	let finish: () => void = () => undefined;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	vi.spyOn(audio, 'start').mockImplementation(async (...args) => {
		await original(...args);
		await pending;
	});
	const create = vi.spyOn(audio, 'createAB');
	const playing = listener.play(boosted);
	expect(create.mock.calls[0]).toEqual([BOOST, NEUTRAL, { experimental: true, initial: 'A' }]);
	const first = create.mock.results[0]?.value;
	const dispose = vi.spyOn(first, 'dispose');
	flat = true;
	// No pair yet: this refresh cannot apply the change.
	listener.refresh();
	expect(create).toHaveBeenCalledOnce();
	finish();
	await playing;
	expect(create).toHaveBeenCalledTimes(2);
	expect(create.mock.calls[1]?.[0]).toMatchObject(FLAT);
	expect(create.mock.calls[1]?.[1]).toMatchObject(FLAT);
	expect(dispose).toHaveBeenCalledOnce();
	expect(listener.active).not.toBeNull();
	expect(audio.state().playing).toBe(true);
	expect(listener.chainOf('a')).toBeNull();
	expect(listener.isPlaying('a')).toBe(false);
});

test('a flat non-blind preview claims no channel; a blind one or a non-flat one is unchanged', async () => {
	let flat = true;
	const { listener } = setup({ flat: () => flat });
	await listener.play(request);
	expect(listener.isPlaying('a')).toBe(false);
	expect(listener.chainOf('a')).toBeNull();
	flat = false;
	listener.refresh();
	expect(listener.isPlaying('a')).toBe(true);
	expect(listener.chainOf('a')).not.toBeNull();
	// The cable goes flat: no claim even before the pair is rebuilt.
	flat = true;
	expect(listener.isPlaying('a')).toBe(false);
	expect(listener.chainOf('a')).toBeNull();
	// Blind rounds never reveal a channel anyway.
	await listener.play({ ...request, blind: true, owner: 's6' });
	expect(listener.isPlaying('a')).toBe(false);
	expect(listener.chainOf('a')).toBeNull();
});

test('a pair that cannot be rebuilt ends the session instead of doubling the EQ', async () => {
	let flat = false;
	const { audio, listener } = setup({ flat: () => flat });
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	await listener.play(boosted);
	vi.spyOn(audio, 'createAB').mockImplementationOnce(() => {
		throw new Error('bad curve');
	});
	flat = true;
	listener.refresh();
	expect(listener.active).toBeNull();
	expect(audio.state().playing).toBe(false);
	expect(warn).toHaveBeenCalledWith(expect.stringContaining('comunidade.refresh_failed'));
});

test('time played flat never counts toward the previewed activity', async () => {
	let flat = false;
	const { listener, advance, timers, previewed } = setup({ flat: () => flat });
	const fire = () => {
		const entry = [...timers.entries()][0];
		if (!entry) throw new Error('Expected preview timer');
		timers.delete(entry[0]);
		entry[1]();
	};
	await listener.play(request);
	advance(4000);
	flat = true;
	listener.refresh();
	expect(listener.audibleMs('a')).toBe(4000);
	expect(timers.size).toBe(0);
	advance(30000);
	listener.select('B');
	listener.select('A');
	expect(timers.size).toBe(0);
	expect(listener.audibleMs('a')).toBe(4000);
	expect(listener.audibleMs('b')).toBe(0);
	flat = false;
	listener.refresh();
	expect(timers.size).toBe(1);
	advance(6000);
	fire();
	expect(previewed).toHaveBeenCalledExactlyOnceWith('a', 10000);
	// A preview that starts flat counts nothing either.
	flat = true;
	await listener.play(request);
	advance(20000);
	listener.stop();
	expect(listener.audibleMs('a')).toBe(10000);
	expect(previewed).toHaveBeenCalledOnce();
});

test('failed start and failed pair creation release resources and allow a later retry', async () => {
	const { audio, listener } = setup();
	const create = vi.spyOn(audio, 'createAB');
	const start = vi.spyOn(audio, 'start').mockRejectedValueOnce(new Error('blocked'));
	await expect(listener.play(request)).rejects.toThrow('blocked');
	expect(listener.busy).toBe(false);
	expect(listener.active).toBeNull();
	expect(create).toHaveBeenCalledOnce();
	create.mockImplementationOnce(() => {
		throw new Error('bad curve');
	});
	await expect(listener.play(request)).rejects.toThrow('bad curve');
	expect(start).toHaveBeenCalledOnce();
	await listener.play(request);
	expect(listener.isPlaying('a')).toBe(true);
});
