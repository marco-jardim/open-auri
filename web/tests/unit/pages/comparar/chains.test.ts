import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { levelDb, snapshotBands } from 'open-auri/dsp';
import { NEUTRO } from 'open-auri/catalog';
import {
	chainPeakDb,
	createAudioEngine,
	dbToGain,
	matchGains,
	standardGateAccepts,
	YOLO_PREVIEW_PEAK_DBFS,
	type AudioEngine,
	type Band,
	type PreviewChain
} from '#lib/audio/engine.ts';
import type { MeterSource, MeterTap } from '#lib/audio/meters.ts';
import { createTrackChains } from '#lib/components/pages/comparar/chains.ts';
import { initialTracks, type Track } from '#lib/components/pages/comparar/comparison.ts';
import {
	asFake,
	fakeEnv,
	onlyContext,
	resetAudioConfig,
	FakeDynamicsCompressorNode,
	FakeGainNode,
	FakeIIRFilterNode
} from '../../audio/fake-audio.ts';

type FakeTap = Pick<MeterTap, 'subscribe' | 'disconnect'>;
const engines: AudioEngine[] = [];
beforeEach(resetAudioConfig);
afterEach(async () => {
	await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
});
function setup() {
	const engine = createAudioEngine(fakeEnv(null).env);
	engines.push(engine);
	const handles: FakeTap[] = [];
	const makeTap = vi.fn<(node: AudioNode) => Promise<FakeTap>>(async () => {
		const handle: FakeTap = { subscribe: vi.fn(() => () => undefined), disconnect: vi.fn() };
		handles.push(handle);
		return handle;
	});
	const meters = new Map<number, MeterSource | null>();
	const manager = createTrackChains(engine, (id, meter) => meters.set(id, meter), makeTap);
	return { engine, manager, handles, makeTap, meters };
}

/** Refused by the standard gate, accepted by the YOLO one (quiet): HP 30 Hz. */
const YOLO_ONLY_BANDS: Band[] = [
	{ kind: 'HP', freqHz: 30, qFactor: 0.71 },
	...NEUTRO.bands.slice(1)
];
/** Lane 2 (armed) plays a YOLO-only curve; the other armed lanes are official presets. */
function withYoloOnly(tracks: Track[]): Track[] {
	const curve: Track['curve'] = {
		name: 'Subsônica',
		source: 'custom',
		preampDb: -0.5,
		bands: snapshotBands(YOLO_ONLY_BANDS)
	};
	return tracks.map((track) => (track.id === 2 ? { ...track, curve } : track));
}
function is<T>(node: unknown, type: abstract new (...args: never[]) => T): T {
	if (!(node instanceof type)) throw new Error(`Expected ${type.name}`);
	return node;
}
/** The protection's normalize gain after the lane's sections, or null when it has none. */
function normalizeGain(chain: PreviewChain): number | null {
	const tail = chain.stages.length > 0 ? is(chain.stages.at(-1), FakeIIRFilterNode) : null;
	const [next] = (tail ?? is(chain.preamp, FakeGainNode)).connections;
	// The fake node and the typed chain output: compared as plain objects.
	if (Object.is(next, chain.output)) return null;
	const normalize = is(next, FakeGainNode);
	const [limiter] = normalize.connections;
	expect(is(limiter, FakeDynamicsCompressorNode).connections).toEqual([chain.output]);
	return normalize.gain.value;
}

describe('parallel comparison chains', () => {
	test('one streaming source fans out to N chains, with an independent pre-switch VU tap each', async () => {
		const { engine, manager, makeTap, meters } = setup();
		await engine.loadFile(new File(['audio'], 'track.mp3', { type: 'audio/mpeg' }));
		const build = vi.spyOn(engine, 'buildChain');
		const tracks = initialTracks().map((track) => ({ ...track, armed: true }));
		await manager.sync(tracks);
		await engine.start('chains');
		expect(onlyContext().mediaSources).toHaveLength(1);
		expect(onlyContext().bufferSources).toHaveLength(0);
		expect(build).toHaveBeenCalledTimes(8);
		expect(makeTap).toHaveBeenCalledTimes(8);
		expect([...meters.values()].filter(Boolean)).toHaveLength(8);
		const bus = asFake(engine.getSourceBus(), FakeGainNode);
		for (const [index, result] of build.mock.results.entries()) {
			const chain = result.value;
			expect(bus.connections).toContain(chain.input);
			expect(makeTap.mock.calls[index][0]).toBe(chain.stages.at(-1) ?? chain.preamp);
			expect(makeTap.mock.calls[index][0]).not.toBe(chain.output);
		}
		manager.dispose();
	});

	test('A/B and level matching only change gains, not sources, chains or taps', async () => {
		const { engine, manager, makeTap } = setup();
		const build = vi.spyOn(engine, 'buildChain');
		const tracks = initialTracks();
		await manager.sync(tracks);
		const first = build.mock.results[0].value;
		const second = build.mock.results[1].value;
		const nodeCount = onlyContext().nodes.length;
		manager.configure([1, 2], true);
		manager.setAudible(true);
		manager.select(2);
		expect(second.output.gain.value).toBeGreaterThan(0);
		expect(first.output.gain.value).toBe(0);
		manager.select(1);
		expect(second.output.gain.value).toBe(0);
		expect(first.output.gain.value).toBeLessThanOrEqual(1);
		manager.configure([1, 2], false);
		await manager.sync(tracks);
		expect(build).toHaveBeenCalledTimes(4);
		expect(makeTap).toHaveBeenCalledTimes(4);
		expect(onlyContext().nodes.length).toBe(nodeCount);
		manager.dispose();
	});

	test('built chains stay silent, even with the engine playing, until the page own Play', async () => {
		const { engine, manager } = setup();
		const build = vi.spyOn(engine, 'buildChain');
		// Another page left the shared engine in chain mode.
		await engine.start('chains');
		manager.configure([1, 2], true);
		manager.select(1);
		await manager.sync(initialTracks());
		const outputs = build.mock.results.map((result) => asFake(result.value.output, FakeGainNode));
		expect(outputs.length).toBeGreaterThan(0);
		expect(outputs.every((output) => output.gain.value === 0)).toBe(true);
		expect(manager.audible()).toBe(false);
		manager.setAudible(true);
		expect(outputs.filter((output) => output.gain.value > 0)).toHaveLength(1);
		manager.setAudible(false);
		expect(outputs.every((output) => output.gain.value === 0)).toBe(true);
		manager.dispose();
		manager.setAudible(true);
		expect(manager.audible()).toBe(false);
	});

	test('an edit while paused builds the replacement first, so the paused session survives', async () => {
		const { engine, manager, handles } = setup();
		const one = initialTracks().map((track) => ({ ...track, armed: track.id === 1 }));
		await manager.sync(one);
		await engine.start('chains', { startAt: 'random', session: 'comparar' });
		engine.pause();
		expect(engine.state()).toMatchObject({ paused: true, session: 'comparar' });
		const edited = one.map((track) =>
			track.id === 1
				? { ...track, curve: { ...track.curve, preampDb: track.curve.preampDb - 1 } }
				: track
		);
		await manager.sync(edited);
		// The only chain was replaced, never removed first: the session is still resumable.
		expect(handles[0].disconnect).toHaveBeenCalledOnce();
		expect(engine.state()).toMatchObject({ paused: true, session: 'comparar' });
		manager.dispose();
		expect(engine.state()).toMatchObject({ paused: false, session: null });
	});

	test('disarming or replacing a curve disposes only the affected chain and tap', async () => {
		const { engine, manager, handles } = setup();
		const build = vi.spyOn(engine, 'buildChain');
		const tracks = initialTracks();
		await manager.sync(tracks);
		await manager.sync(
			tracks.map((track) => (track.id === 1 ? { ...track, armed: false } : track))
		);
		expect(handles[0].disconnect).toHaveBeenCalledOnce();
		expect(handles[1].disconnect).not.toHaveBeenCalled();
		await manager.sync(
			tracks.map((track) =>
				track.id === 2
					? { ...track, curve: tracks[2].curve }
					: { ...track, armed: track.id !== 1 && track.armed }
			)
		);
		expect(build).toHaveBeenCalledTimes(5);
		expect(handles[1].disconnect).toHaveBeenCalledOnce();
		manager.dispose();
		expect(handles.every((handle) => vi.mocked(handle.disconnect).mock.calls.length === 1)).toBe(
			true
		);
		expect(onlyContext().closeCalls).toBe(0);
	});

	test('a late tap cannot leak after disposal', async () => {
		const engine = createAudioEngine(fakeEnv(null).env);
		engines.push(engine);
		let complete: (tap: FakeTap) => void = () => {
			throw new Error('Tap did not begin');
		};
		const pendingTap = new Promise<FakeTap>((resolve) => {
			complete = resolve;
		});
		const onMeter = vi.fn();
		const manager = createTrackChains(engine, onMeter, () => pendingTap);
		const pending = manager.sync(
			initialTracks().map((track) => ({ ...track, armed: track.id === 1 }))
		);
		manager.dispose();
		const handle: FakeTap = { subscribe: () => () => undefined, disconnect: vi.fn() };
		complete(handle);
		await pending;
		expect(handle.disconnect).toHaveBeenCalledOnce();
		expect(onMeter).not.toHaveBeenCalledWith(1, handle);
	});

	test('armed standard presets play exactly as before: no lane is protected', async () => {
		const { engine, manager } = setup();
		const build = vi.spyOn(engine, 'buildChain');
		await manager.sync(initialTracks());
		const chains = build.mock.results.map((result): PreviewChain => result.value);
		expect(chains).toHaveLength(4);
		expect(chains.map(normalizeGain)).toEqual([null, null, null, null]);
		expect(onlyContext().compressors).toHaveLength(0);
		manager.dispose();
	});

	test('one YOLO-only lane protects every armed lane with one gain: the level match holds', async () => {
		const { engine, manager } = setup();
		const build = vi.spyOn(engine, 'buildChain');
		const tracks = withYoloOnly(initialTracks());
		const armed = tracks.filter((track) => track.armed);
		expect(armed.map((track) => standardGateAccepts(track.curve.bands, track.curve.preampDb))).toEqual(
			[true, false, true, true]
		);
		await manager.sync(tracks);
		const chains = build.mock.results.map((result): PreviewChain => result.value);
		expect(chains).toHaveLength(4);
		// The loudest untrimmed peak of the armed lanes lands at -1 dBFS; every lane gets that gain.
		const rate = chains[0]?.rate ?? 0;
		const loudest = Math.max(
			...armed.map((track) => chainPeakDb(track.curve.bands, track.curve.preampDb, rate))
		);
		const expected = dbToGain(Math.min(0, YOLO_PREVIEW_PEAK_DBFS - loudest));
		for (const gain of chains.map(normalizeGain)) {
			expect(gain).not.toBeNull();
			expect(gain ?? Number.NaN).toBeCloseTo(expected, 12);
		}
		expect(onlyContext().compressors).toHaveLength(4);
		// A/B of the standard lane 1 against the YOLO-only lane 2: the match trims alone set the
		// levels, as for unprotected lanes (the shared gain is the same on both sides).
		manager.configure([1, 2], true);
		manager.setAudible(true);
		const [one, two] = armed;
		if (!one || !two) throw new Error('missing lanes');
		const trims = matchGains([
			levelDb(one.curve.bands, one.curve.preampDb),
			levelDb(two.curve.bands, two.curve.preampDb)
		]);
		manager.select(1);
		expect(asFake(chains[0]?.output, FakeGainNode).gain.value).toBeCloseTo(
			dbToGain(trims[0] ?? 0),
			12
		);
		manager.select(2);
		expect(asFake(chains[1]?.output, FakeGainNode).gain.value).toBeCloseTo(
			dbToGain(trims[1] ?? 0),
			12
		);
		manager.dispose();
	});

	test('disarming the only refused lane rebuilds the others unprotected', async () => {
		const { engine, manager } = setup();
		const build = vi.spyOn(engine, 'buildChain');
		const tracks = withYoloOnly(initialTracks());
		await manager.sync(tracks);
		expect(build).toHaveBeenCalledTimes(4);
		await manager.sync(tracks.map((track) => (track.id === 2 ? { ...track, armed: false } : track)));
		// The protection changed: lanes 1, 3 and 4 are rebuilt without it.
		expect(build).toHaveBeenCalledTimes(7);
		const rebuilt = build.mock.results.slice(4).map((result): PreviewChain => result.value);
		expect(rebuilt.map(normalizeGain)).toEqual([null, null, null]);
		// Arming it again protects every lane once more.
		await manager.sync(tracks);
		expect(build).toHaveBeenCalledTimes(11);
		const again = build.mock.results.slice(7).map((result): PreviewChain => result.value);
		expect(again.map(normalizeGain).every((gain) => gain !== null)).toBe(true);
		manager.dispose();
	});

	test('failed worklet load is reported and can be retried without rebuilding', async () => {
		const { engine } = setup();
		const build = vi.spyOn(engine, 'buildChain');
		const handle: FakeTap = { subscribe: () => () => undefined, disconnect: vi.fn() };
		const tap = vi
			.fn<() => Promise<FakeTap>>()
			.mockRejectedValueOnce(new Error('Worklet refused'))
			.mockResolvedValue(handle);
		const manager = createTrackChains(engine, () => undefined, tap);
		const tracks = initialTracks().map((track) => ({ ...track, armed: track.id === 1 }));
		await expect(manager.sync(tracks)).rejects.toThrow('Worklet refused');
		await manager.sync(tracks);
		expect(build).toHaveBeenCalledOnce();
		expect(tap).toHaveBeenCalledTimes(2);
		manager.dispose();
	});
});
