/**
 * C1 (hearing safety): the engine protects (normalize to -1 dBFS, then a limiter) every preview
 * whose curve the standard gate refuses, or that is louder than it allows, whether the page
 * asked for it or not: Curva, Soe como X, the shared curve, Perfil, the library sheet and the
 * community listener (createAB), Comparar and Teste cego (buildChain).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { gateForWrite } from 'open-auri/safety';
import {
	chainPeakDb,
	createAudioEngine,
	dbToGain,
	PREVIEW_PEAK_LIMIT_DB,
	standardGateAccepts,
	YOLO_PREVIEW_PEAK_DBFS,
	type AudioEngine,
	type Band,
	type PreviewChain,
	type PreviewCurve
} from '#lib/audio/engine.ts';
import {
	audioConfig,
	FakeDynamicsCompressorNode,
	FakeGainNode,
	FakeIIRFilterNode,
	fakeEnv,
	resetAudioConfig,
	type FakeAudioContext
} from './fake-audio.ts';

const pad = (active: Band[]): Band[] => [...active, ...NEUTRO.bands.slice(active.length)];
const STANDARD: PreviewCurve = { bands: PADRAO_AURI.bands, preampDb: PADRAO_AURI.preampDb };
const NEUTRAL: PreviewCurve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
/** Only the codec accepts it (the free preview): about +11,5 dB out. */
const CODEC_ONLY: PreviewCurve = {
	bands: pad([{ kind: 'PK', freqHz: 1000, gainDb: 12, qFactor: 1 }]),
	preampDb: -0.5
};
/** Quiet, but refused by the standard gate (YOLO only): HP 30 Hz, "subsônica". */
const YOLO_ONLY: PreviewCurve = {
	bands: pad([{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]),
	preampDb: -0.5
};

const engines: AudioEngine[] = [];
function makeEngine(): AudioEngine {
	const engine = createAudioEngine(fakeEnv(null).env);
	engines.push(engine);
	return engine;
}
function context(): FakeAudioContext {
	const only = audioConfig.instances[0];
	if (!only) throw new Error('No audio context');
	return only;
}
function as<T>(node: unknown, type: abstract new (...args: never[]) => T): T {
	if (!(node instanceof type)) throw new Error(`Expected ${type.name}`);
	return node;
}
/** The node right after the chain's last section (or its preamp). */
function afterSections(chain: PreviewChain): unknown {
	const tail = chain.stages.length > 0 ? as(chain.stages.at(-1), FakeIIRFilterNode) : null;
	const next = (tail ?? as(chain.preamp, FakeGainNode)).connections;
	expect(next).toHaveLength(1);
	return next[0];
}
/** Normalizing gain and limiter of a protected chain, or null when it is unprotected. */
function protection(chain: PreviewChain) {
	const next = afterSections(chain);
	if (next === chain.output) return null;
	const normalize = as(next, FakeGainNode);
	const [limiter] = normalize.connections;
	const compressor = as(limiter, FakeDynamicsCompressorNode);
	expect(compressor.connections).toEqual([chain.output]);
	return { gain: normalize.gain.value, compressor };
}

beforeEach(resetAudioConfig);
afterEach(async () => {
	await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
});

it('the fixtures are what they claim', () => {
	expect(gateForWrite(STANDARD.bands, STANDARD.preampDb).ok).toBe(true);
	expect(gateForWrite(YOLO_ONLY.bands, YOLO_ONLY.preampDb, { experimental: true }).ok).toBe(false);
	expect(
		gateForWrite(YOLO_ONLY.bands, YOLO_ONLY.preampDb, { experimental: true, profile: 'yolo' }).ok
	).toBe(true);
	expect(gateForWrite(CODEC_ONLY.bands, CODEC_ONLY.preampDb, { profile: 'yolo' }).ok).toBe(false);
	expect(chainPeakDb(YOLO_ONLY.bands, YOLO_ONLY.preampDb, 96000)).toBeLessThan(
		PREVIEW_PEAK_LIMIT_DB
	);
	expect(chainPeakDb(CODEC_ONLY.bands, CODEC_ONLY.preampDb, 96000)).toBeGreaterThan(11);
});

it('standardGateAccepts is the standard gate, OFF-padded and with the experimental flag', () => {
	expect(standardGateAccepts(STANDARD.bands, STANDARD.preampDb)).toBe(true);
	expect(standardGateAccepts(YOLO_ONLY.bands, YOLO_ONLY.preampDb)).toBe(false);
	expect(standardGateAccepts(CODEC_ONLY.bands, CODEC_ONLY.preampDb)).toBe(false);
	// A short list sounds like the same list padded with OFF.
	expect(standardGateAccepts([{ kind: 'OFF' }], -0.5)).toBe(true);
	expect(standardGateAccepts([{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 }], -1)).toBe(
		gateForWrite(pad([{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 }]), -1, {
			experimental: true
		}).ok
	);
});

describe('createAB', () => {
	it('leaves an A/B of standard curves exactly as before', () => {
		const ab = makeEngine().createAB(NEUTRAL, STANDARD);
		expect(protection(ab.a)).toBeNull();
		expect(protection(ab.b)).toBeNull();
		expect(context().compressors).toHaveLength(0);
	});

	it.each([
		['codec-only editor', NEUTRAL, CODEC_ONLY],
		['YOLO-only editor', NEUTRAL, YOLO_ONLY],
		['YOLO-only reference (a YOLO cable write)', YOLO_ONLY, STANDARD]
	] as const)('protects both sides unasked: %s', (_, a, b) => {
		const engine = makeEngine();
		const ab = engine.createAB(a, b, { experimental: true });
		const rate = context().sampleRate;
		const loudest = Math.max(
			chainPeakDb(a.bands, a.preampDb, rate) + ab.trims[0],
			chainPeakDb(b.bands, b.preampDb, rate) + ab.trims[1]
		);
		const expected = dbToGain(Math.min(0, YOLO_PREVIEW_PEAK_DBFS - loudest));
		for (const chain of [ab.a, ab.b]) {
			const found = protection(chain);
			expect(found).not.toBeNull();
			// One gain for both sides keeps the level match.
			expect(found?.gain).toBeCloseTo(expected, 12);
			expect(found?.compressor.threshold.value).toBe(YOLO_PREVIEW_PEAK_DBFS - 2);
		}
		expect(context().compressors).toHaveLength(2);
	});

	it('the codec-only side is brought down to -1 dBFS', () => {
		const ab = makeEngine().createAB(NEUTRAL, CODEC_ONLY);
		const rate = context().sampleRate;
		const peak = chainPeakDb(CODEC_ONLY.bands, CODEC_ONLY.preampDb, rate) + ab.trims[1];
		const gain = protection(ab.b)?.gain ?? 1;
		expect(peak + 20 * Math.log10(gain)).toBeLessThanOrEqual(YOLO_PREVIEW_PEAK_DBFS + 1e-9);
	});
});

describe('buildChain (Comparar, Teste cego)', () => {
	it.each([
		['codec-only', CODEC_ONLY, true],
		['YOLO-only', YOLO_ONLY, true],
		['standard', STANDARD, false],
		['short and quiet', { bands: [{ kind: 'OFF' }], preampDb: -0.5 }, false]
	] as const)('%s: protected = %s', (_, curve, expected) => {
		const chain = makeEngine().buildChain(curve.bands, curve.preampDb, { experimental: true });
		const found = protection(chain);
		expect(found !== null).toBe(expected);
		if (found) {
			const peak = chainPeakDb(curve.bands, curve.preampDb, chain.rate);
			expect(found.gain).toBeCloseTo(dbToGain(Math.min(0, YOLO_PREVIEW_PEAK_DBFS - peak)), 12);
		}
	});

	it('an explicit protection is kept as asked', () => {
		const chain = makeEngine().buildChain(STANDARD.bands, STANDARD.preampDb, {
			protect: { gainDb: -6 }
		});
		expect(protection(chain)?.gain).toBeCloseTo(dbToGain(-6), 12);
	});
});

it('chainPeakDb finds a resonance far narrower than its frequency grid', () => {
	const narrow: Band[] = pad([{ kind: 'PK', freqHz: 1234.5, gainDb: 12, qFactor: 300 }]);
	expect(chainPeakDb(narrow, -0.5, 96000)).toBeGreaterThan(11.3);
});
