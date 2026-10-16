import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import {
	AudioEngineError,
	createAudioEngine,
	type ABPreview,
	type AudioEngine,
	type AudioErrorCode
} from '#lib/audio/engine.ts';
import { tap, tapStages, type MeterListener, type MeterTap } from '#lib/audio/meters.ts';
import { CurvaPreview } from '#lib/components/pages/curva/preview.svelte.ts';
import type { Curve } from '#lib/components/pages/curva/model.ts';
import { audioConfig, fakeEnv, resetAudioConfig } from '../../audio/fake-audio.ts';

vi.mock(import('#lib/audio/meters.ts'), async (original) => ({
	...(await original()),
	tap: vi.fn(),
	tapStages: vi.fn()
}));

const neutral: Curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
const editor: Curve = {
	bands: [
		{ kind: 'OFF' },
		{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 },
		{ kind: 'OFF' },
		{ kind: 'LS', freqHz: 120, gainDb: -2, qFactor: 0.7 },
		...NEUTRO.bands.slice(4)
	],
	preampDb: -1
};
const engines: AudioEngine[] = [];
const previews: CurvaPreview[] = [];

function meter(source: AudioNode) {
	const unsubscribe = vi.fn();
	const handle = {
		// The worklet boundary is mocked; these tests never instantiate or connect a worklet.
		node: source as unknown as AudioWorkletNode,
		source,
		kinds: [],
		current: () => ({ mode: 'live' as const, frame: null }),
		subscribe: vi.fn((listener: MeterListener) => {
			listener({ mode: 'live', frame: null });
			return unsubscribe;
		}),
		setReference: vi.fn(),
		setPpmType: vi.fn(),
		reset: vi.fn(),
		disconnect: vi.fn()
	} satisfies MeterTap;
	return { handle, unsubscribe };
}

function setup() {
	const engine = createAudioEngine(fakeEnv(null).env);
	engines.push(engine);
	const start = vi.spyOn(engine, 'start').mockResolvedValue();
	const stop = vi.spyOn(engine, 'stop').mockImplementation(() => undefined);
	const sharedDispose = vi.spyOn(engine, 'dispose');
	const abInstances: ABPreview[] = [];
	const create = engine.createAB;
	const createAB = vi.spyOn(engine, 'createAB').mockImplementation((...args) => {
		const ab = create(...args);
		vi.spyOn(ab, 'dispose');
		vi.spyOn(ab, 'select');
		abInstances.push(ab);
		return ab;
	});
	const handles: ReturnType<typeof meter>[] = [];
	vi.mocked(tap).mockImplementation(async (node) => {
		const value = meter(node);
		handles.push(value);
		return value.handle;
	});
	vi.mocked(tapStages).mockImplementation(async (nodes) =>
		nodes.map((node) => {
			const value = meter(node);
			handles.push(value);
			return value.handle;
		})
	);
	const preview = new CurvaPreview(engine);
	previews.push(preview);
	return { preview, engine, start, stop, sharedDispose, createAB, abInstances, handles };
}

beforeEach(() => {
	resetAudioConfig();
	vi.clearAllMocks();
});

afterEach(async () => {
	for (const preview of previews.splice(0)) preview.dispose();
	await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
	vi.restoreAllMocks();
});

test('idle operations allocate no chains; selection is retained at start', async () => {
	const { preview, createAB, start, stop } = setup();
	preview.update(neutral, editor);
	preview.select('A');
	preview.stop();
	expect(createAB).not.toHaveBeenCalled();
	expect(start).not.toHaveBeenCalled();
	expect(stop).not.toHaveBeenCalled();
	expect(preview.vu.mode).toBe('data');
	await preview.start(neutral, editor);
	expect(createAB).toHaveBeenCalledWith(neutral, editor, { initial: 'A', experimental: false });
	expect(start).toHaveBeenCalledWith('chains');
	expect(preview.playing).toBe(true);
	expect(preview.error).toBeNull();
	expect(preview.analyser).not.toBeNull();
});

test('routes VU/stages, rebuilds on edit, and releases page resources', async () => {
	const { preview, createAB, abInstances, handles, stop, sharedDispose } = setup();
	await preview.start(neutral, editor);
	await vi.waitFor(() => expect(preview.vu.mode).toBe('live'));
	expect(preview.stages.map((stage) => stage.mode)).toEqual([
		'data',
		'live',
		'data',
		'live',
		'data',
		'data',
		'data',
		'data',
		'data',
		'data'
	]);
	const a = handles[0];
	const b = handles[1];
	if (!a || !b) throw new Error('Missing output taps');
	expect(b.handle.subscribe).toHaveBeenCalledTimes(1);
	preview.select('A');
	expect(abInstances[0]?.select).toHaveBeenLastCalledWith('A');
	expect(b.unsubscribe).toHaveBeenCalledTimes(1);
	expect(a.handle.subscribe).toHaveBeenCalledTimes(1);
	preview.select('B');
	expect(a.unsubscribe).toHaveBeenCalledTimes(1);
	expect(b.handle.subscribe).toHaveBeenCalledTimes(2);
	preview.update(editor, neutral);
	expect(createAB).toHaveBeenCalledTimes(2);
	expect(abInstances[0]?.dispose).toHaveBeenCalledTimes(1);
	for (const { handle } of handles.slice(0, 4)) expect(handle.disconnect).toHaveBeenCalledTimes(1);
	await vi.waitFor(() => expect(preview.vu.mode).toBe('live'));
	expect(preview.stages.every((stage) => stage.mode === 'data')).toBe(true);
	preview.dispose();
	expect(stop).toHaveBeenCalledTimes(1);
	expect(abInstances[1]?.dispose).toHaveBeenCalledTimes(1);
	expect(preview.playing).toBe(false);
	expect(preview.analyser).toBeNull();
	expect(preview.vu.mode).toBe('data');
	expect(sharedDispose).not.toHaveBeenCalled();
	preview.dispose();
	expect(stop).toHaveBeenCalledTimes(1);
});

test.each(['reference', 'editor'] as const)(
	'experimental %s enables experimental chains',
	async (side) => {
		const { preview, createAB } = setup();
		const hs: Curve = {
			bands: [{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 }, ...NEUTRO.bands.slice(1)],
			preampDb: -1
		};
		await preview.start(side === 'reference' ? hs : neutral, side === 'editor' ? hs : neutral);
		expect(createAB).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), {
			initial: 'B',
			experimental: true
		});
		expect(preview.playing).toBe(true);
	}
);

test.each([
	['gesture', 'gesture'],
	['suspended', 'suspended'],
	['unsupported', 'unsupported'],
	['invalid-file', 'failed']
] as const satisfies readonly (readonly [AudioErrorCode, string])[])(
	'maps %s errors and can retry',
	async (code, expected) => {
		const { preview, start, abInstances } = setup();
		start.mockRejectedValueOnce(new AudioEngineError(code));
		await preview.start(neutral, editor);
		expect(preview.error).toBe(expected);
		expect(preview.playing).toBe(false);
		expect(preview.analyser).toBeNull();
		expect(abInstances[0]?.dispose).toHaveBeenCalledTimes(1);
		await preview.start(neutral, editor);
		expect(preview.error).toBeNull();
		expect(preview.playing).toBe(true);
	}
);

test('unexpected chain failures are logged without starting audio', async () => {
	const { preview, createAB, start } = setup();
	const cause = new Error('broken graph');
	createAB.mockImplementationOnce(() => {
		throw cause;
	});
	const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	await preview.start(neutral, editor);
	expect(preview.error).toBe('failed');
	expect(preview.playing).toBe(false);
	expect(start).not.toHaveBeenCalled();
	expect(log).toHaveBeenCalledWith('Curva preview failed', cause);
});

test('late taps disconnect instead of resurrecting stopped meters', async () => {
	const { preview, engine } = setup();
	const late = meter(engine.getContext().createGain());
	let resolve: (handle: MeterTap) => void = () => {
		throw new Error('Deferred meter not initialised');
	};
	const pending = new Promise<MeterTap>((done) => {
		resolve = done;
	});
	vi.mocked(tap).mockReturnValue(pending);
	vi.mocked(tapStages).mockResolvedValue([late.handle]);
	await preview.start(neutral, editor);
	preview.stop();
	resolve(late.handle);
	await vi.waitFor(() => expect(late.handle.disconnect).toHaveBeenCalled());
	expect(late.handle.subscribe).not.toHaveBeenCalled();
	expect(preview.vu.mode).toBe('data');
	expect(preview.stages.every((stage) => stage.mode === 'data')).toBe(true);
});

test('a worklet failure leaves audio playing with meters honestly in DATA mode', async () => {
	const { preview } = setup();
	const cause = new Error('worklet unavailable');
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	vi.mocked(tap).mockRejectedValue(cause);
	await preview.start(neutral, editor);
	await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('Curva meters unavailable', cause));
	expect(preview.playing).toBe(true);
	expect(preview.error).toBeNull();
	expect(preview.vu.mode).toBe('data');
});

function deferredStart() {
	let resolve: () => void = () => {
		throw new Error('Engine start not begun');
	};
	const started = new Promise<void>((done) => {
		resolve = done;
	});
	return { started, resolve: () => resolve() };
}

test('stop during the engine start wins: the late start is stopped and no chain remains', async () => {
	const { preview, engine, start, stop, abInstances } = setup();
	const gate = deferredStart();
	start.mockImplementationOnce(() => gate.started);
	const pending = preview.start(neutral, editor);
	expect(preview.starting).toBe(true);
	expect(preview.playing).toBe(false);
	// The click that cancels: the engine is stopped even though `playing` never became true.
	preview.stop();
	expect(stop).toHaveBeenCalledTimes(1);
	expect(preview.starting).toBe(false);
	gate.resolve();
	await pending;
	// The start resolved after the stop: it is stopped again, nothing is rebuilt.
	expect(stop).toHaveBeenCalledTimes(2);
	expect(preview.playing).toBe(false);
	expect(preview.analyser).toBeNull();
	const ab = abInstances[0];
	if (!ab) throw new Error('Missing A/B preview');
	expect(ab.dispose).toHaveBeenCalledTimes(1);
	expect(abInstances).toHaveLength(1);
	expect(engine.getChainOutput(ab.a.id)).toBeNull();
	expect(engine.getChainOutput(ab.b.id)).toBeNull();
});

test('dispose (unmount) during the engine start leaves the real engine off', async () => {
	const { preview, engine, start, stop, abInstances } = setup();
	start.mockRestore();
	stop.mockRestore();
	const realStart = engine.start.bind(engine);
	const engineStop = vi.spyOn(engine, 'stop');
	const gate = deferredStart();
	vi.spyOn(engine, 'start').mockImplementationOnce(async (mode) => {
		await gate.started;
		await realStart(mode);
	});
	const pending = preview.start(neutral, editor);
	preview.dispose();
	gate.resolve();
	await pending;
	expect(engine.state().mode).toBe('off');
	expect(engine.state().playing).toBe(false);
	expect(engineStop).toHaveBeenCalled();
	const ab = abInstances[0];
	if (!ab) throw new Error('Missing A/B preview');
	expect(engine.getChainOutput(ab.a.id)).toBeNull();
	expect(engine.getChainOutput(ab.b.id)).toBeNull();
	expect(preview.playing).toBe(false);
});

test('a second start while the first is still pending keeps the engine to the newer one', async () => {
	const { preview, start, stop } = setup();
	const first = deferredStart();
	start.mockImplementationOnce(() => first.started);
	const pendingFirst = preview.start(neutral, editor);
	const pendingSecond = preview.start(neutral, editor);
	first.resolve();
	await Promise.all([pendingFirst, pendingSecond]);
	expect(stop).not.toHaveBeenCalled();
	expect(preview.playing).toBe(true);
});

test('an edit during the engine start is what plays once it resolves', async () => {
	const { preview, start, createAB, abInstances } = setup();
	const gate = deferredStart();
	start.mockImplementationOnce(() => gate.started);
	const pending = preview.start(neutral, neutral);
	preview.update(neutral, editor);
	// Nothing is rebuilt while starting; the latest curves are kept.
	expect(createAB).toHaveBeenCalledTimes(1);
	gate.resolve();
	await pending;
	expect(preview.playing).toBe(true);
	expect(createAB).toHaveBeenCalledTimes(2);
	expect(createAB).toHaveBeenLastCalledWith(neutral, editor, {
		initial: 'B',
		experimental: false
	});
	expect(abInstances[0]?.dispose).toHaveBeenCalledTimes(1);
	expect(abInstances[1]?.dispose).not.toHaveBeenCalled();
});

test('without an edit during the start the chains are not rebuilt', async () => {
	const { preview, createAB } = setup();
	await preview.start(neutral, editor);
	expect(createAB).toHaveBeenCalledTimes(1);
});

test('output and stage taps receive the app 0 VU reference', async () => {
	const { engine } = setup();
	const preview = new CurvaPreview(engine, { reference: () => -20 });
	previews.push(preview);
	await preview.start(neutral, editor);
	await vi.waitFor(() => expect(tap).toHaveBeenCalledTimes(2));
	for (const [, options] of vi.mocked(tap).mock.calls) {
		expect(options).toMatchObject({ reference: -20 });
	}
	expect(vi.mocked(tapStages).mock.calls[0]?.[1]).toMatchObject({ reference: -20 });
});

test('reports an approximate preview when the browser refuses 96 kHz', async () => {
	audioConfig.supportedRates = [48000];
	const { preview, engine } = setup();
	expect(preview.exact).toBe(true);
	await preview.start(neutral, editor);
	expect(engine.state().exact).toBe(false);
	expect(preview.exact).toBe(false);
});

test('reports an exact preview at 96 kHz', async () => {
	const { preview } = setup();
	await preview.start(neutral, editor);
	expect(preview.exact).toBe(true);
});

test('missing stage taps remain in DATA mode without preventing output metering', async () => {
	const { preview } = setup();
	vi.mocked(tapStages).mockResolvedValue([]);
	await preview.start(neutral, editor);
	await vi.waitFor(() => expect(preview.vu.mode).toBe('live'));
	expect(preview.stages.every((stage) => stage.mode === 'data')).toBe(true);
	expect(preview.playing).toBe(true);
});
