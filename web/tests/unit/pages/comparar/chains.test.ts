import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import type { MeterSource, MeterTap } from '#lib/audio/meters.ts';
import { createTrackChains } from '#lib/components/pages/comparar/chains.ts';
import { initialTracks } from '#lib/components/pages/comparar/comparison.ts';
import {
	asFake,
	fakeEnv,
	onlyContext,
	resetAudioConfig,
	FakeGainNode
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
