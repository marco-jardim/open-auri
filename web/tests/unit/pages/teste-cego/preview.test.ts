import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AudioEngine, Band, PreviewChain, PreviewCurve } from '#lib/audio/engine.ts';
import {
	chainPeakDb,
	createAudioEngine,
	dbToGain,
	matchGains,
	YOLO_PREVIEW_PEAK_DBFS
} from '#lib/audio/engine.ts';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { candidate } from '#lib/components/pages/teste-cego/experiment.ts';
import { createBlindPreview } from '#lib/components/pages/teste-cego/preview.ts';
import {
	audioConfig,
	FakeDynamicsCompressorNode,
	FakeGainNode,
	FakeIIRFilterNode,
	fakeEnv,
	resetAudioConfig
} from '../../audio/fake-audio.ts';

function fakeChain(id: string) {
	// Only the methods used by the page controller; no fake meter readings or production fakes.
	return { id, setGain: vi.fn(), dispose: vi.fn() } as unknown as PreviewChain;
}
function fakeEngine(protect?: { gainDb: number }) {
	const a = fakeChain('a'),
		b = fakeChain('b'),
		c = fakeChain('c');
	const queue = [a, b, c];
	const buildChain = vi.fn(() => {
		const next = queue.shift();
		if (!next) throw new Error('no more chains');
		return next;
	});
	const sharedProtection = vi.fn(() => protect);
	const engine = {
		buildChain,
		sharedProtection,
		matchGains: vi.fn(matchGains)
	} as unknown as AudioEngine;
	return { engine, a, b, c, buildChain, sharedProtection };
}

describe('shared preview level matching', () => {
	test('one chain per candidate, global three-way attenuation and only the selected chain is audible', () => {
		const fake = fakeEngine();
		const candidates = [-1, -4, -9].map((level, i) => ({
			...candidate(String(i), String(i), NEUTRO),
			level
		}));
		const preview = createBlindPreview(fake.engine, candidates);
		expect(fake.buildChain).toHaveBeenCalledTimes(3);
		expect(preview.chains).toEqual([fake.a, fake.b, fake.c]);
		expect(preview.trims).toEqual([-8, -5, 0]);
		// The protection is judged once, for the whole set, with each candidate's trim.
		expect(fake.sharedProtection).toHaveBeenCalledOnce();
		expect(fake.sharedProtection.mock.calls[0]).toEqual([
			candidates.map((c, i) => ({
				bands: c.bands,
				preampDb: c.preampDb,
				trimDb: [-8, -5, 0][i]
			}))
		]);
		// Each chain is built at its trim and stays there while silent (the trim runs ahead of a
		// shared protection, whose gain counted it).
		(fake.buildChain.mock.calls as unknown[][]).forEach((call, i) => {
			expect(call[2]).toMatchObject({ gainDb: [-8, -5, 0][i], on: false });
		});
		preview.chains.forEach((chain, i) => {
			expect(chain.setGain).toHaveBeenLastCalledWith([-8, -5, 0][i], false);
		});
		preview.select('1');
		expect(fake.a.setGain).toHaveBeenLastCalledWith(-8, false);
		expect(fake.b.setGain).toHaveBeenLastCalledWith(-5, true);
		expect(fake.c.setGain).toHaveBeenLastCalledWith(0, false);
		preview.dispose();
		for (const chain of preview.chains) expect(chain.dispose).toHaveBeenCalledOnce();
	});
	test('a shared protection goes to every chain, unchanged', () => {
		const fake = fakeEngine({ gainDb: -7 });
		const candidates = ['a', 'b', 'c'].map((id) => candidate(id, id, NEUTRO));
		createBlindPreview(fake.engine, candidates);
		for (const call of fake.buildChain.mock.calls as unknown[][]) {
			expect(call[2]).toMatchObject({ on: false, protect: { gainDb: -7 } });
		}
	});
	test('cleans up the chains already built if a later one fails', () => {
		const fake = fakeEngine();
		fake.buildChain
			.mockImplementationOnce(() => fake.a)
			.mockImplementationOnce(() => fake.b)
			.mockImplementationOnce(() => {
				throw new Error('unsupported');
			});
		const candidates = ['a', 'b', 'c'].map((id) => candidate(id, id, NEUTRO));
		expect(() => createBlindPreview(fake.engine, candidates)).toThrow('unsupported');
		expect(fake.a.dispose).toHaveBeenCalledOnce();
		expect(fake.b.dispose).toHaveBeenCalledOnce();
	});
	test('two candidates build two chains and never touch transport or playback', () => {
		const fake = fakeEngine();
		createBlindPreview(
			fake.engine,
			['a', 'b'].map((id) => candidate(id, id, NEUTRO))
		);
		expect(fake.buildChain).toHaveBeenCalledTimes(2);
		expect(() => createBlindPreview(fake.engine, [])).toThrow(RangeError);
	});
});

describe('protection on the real engine (C1)', () => {
	const pad = (active: Band[]): Band[] => [...active, ...NEUTRO.bands.slice(active.length)];
	/** Refused by the standard gate, accepted by the YOLO one: HP 30 Hz. */
	const YOLO_ONLY: PreviewCurve = {
		bands: pad([{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]),
		preampDb: -0.5
	};
	const engines: AudioEngine[] = [];
	beforeEach(resetAudioConfig);
	afterEach(async () => {
		await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
	});
	function as<T>(node: unknown, type: abstract new (...args: never[]) => T): T {
		if (!(node instanceof type)) throw new Error(`Expected ${type.name}`);
		return node;
	}
	/**
	 * The normalize gain of a protected chain (sections, trim, normalize, limiter, output), or
	 * null when it is unprotected (the sections feed the output).
	 */
	function normalizeGain(chain: PreviewChain): number | null {
		const tail = chain.stages.length > 0 ? as(chain.stages.at(-1), FakeIIRFilterNode) : null;
		const [next] = (tail ?? as(chain.preamp, FakeGainNode)).connections;
		// The fake node and the typed chain output: compared as plain objects.
		if (Object.is(next, chain.output)) return null;
		const [normalizeNode] = as(next, FakeGainNode).connections;
		const normalize = as(normalizeNode, FakeGainNode);
		const [limiter] = normalize.connections;
		expect(as(limiter, FakeDynamicsCompressorNode).connections).toEqual([chain.output]);
		return normalize.gain.value;
	}
	/** The trim gain ahead of a protected chain's normalize gain. */
	function trimGain(chain: PreviewChain): number {
		const tail = chain.stages.length > 0 ? as(chain.stages.at(-1), FakeIIRFilterNode) : null;
		const [next] = (tail ?? as(chain.preamp, FakeGainNode)).connections;
		return as(next, FakeGainNode).gain.value;
	}

	test('one YOLO-only candidate protects every chain with the same gain: nothing tells them apart', () => {
		const engine = createAudioEngine(fakeEnv(null).env);
		engines.push(engine);
		const candidates = [
			candidate('a', 'Neutro', NEUTRO),
			candidate('b', 'Subsônica', YOLO_ONLY),
			candidate('c', 'Padrão', PADRAO_AURI)
		];
		const preview = createBlindPreview(engine, candidates);
		const rate = audioConfig.instances[0]?.sampleRate ?? 0;
		const loudest = Math.max(
			...candidates.map((c, i) => chainPeakDb(c.bands, c.preampDb, rate) + (preview.trims[i] ?? 0))
		);
		const expected = dbToGain(Math.min(0, YOLO_PREVIEW_PEAK_DBFS - loudest));
		const gains = preview.chains.map(normalizeGain);
		for (const gain of gains) {
			expect(gain).not.toBeNull();
			expect(gain ?? Number.NaN).toBeCloseTo(expected, 12);
		}
		// Every trim plays ahead of the limiter, muted or selected, so no limiter input passes
		// -1 dBFS.
		const check = () =>
			preview.chains.forEach((chain, i) => {
				const trim = preview.trims[i] ?? 0;
				expect(trimGain(chain)).toBeCloseTo(dbToGain(trim), 12);
				const c = candidates[i];
				if (!c) throw new Error('missing candidate');
				const atLimiter =
					chainPeakDb(c.bands, c.preampDb, rate) + 20 * Math.log10(trimGain(chain) * expected);
				expect(atLimiter).toBeLessThanOrEqual(YOLO_PREVIEW_PEAK_DBFS + 1e-9);
			});
		check();
		preview.select('b');
		check();
		preview.mute();
		check();
		expect(audioConfig.instances[0]?.compressors).toHaveLength(3);
		preview.dispose();
	});

	test('standard candidates only: no chain is protected', () => {
		const engine = createAudioEngine(fakeEnv(null).env);
		engines.push(engine);
		const preview = createBlindPreview(engine, [
			candidate('a', 'Neutro', NEUTRO),
			candidate('b', 'Padrão', PADRAO_AURI)
		]);
		expect(preview.chains.map(normalizeGain)).toEqual([null, null]);
		expect(audioConfig.instances[0]?.compressors).toHaveLength(0);
		preview.dispose();
	});
});
