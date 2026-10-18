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

describe('gain below 10 Hz and at Nyquist (free preview, codec only)', () => {
	/**
	 * The review's case: +12,2 dB at DC with the preamp, near 0 dB from 10 Hz up. Checked at the
	 * fallback rates, where the section is designed in float: at 96 kHz a 1 Hz corner is below
	 * what the Q27 words resolve, and the response there is the quantization's.
	 */
	const SUBSONIC_SHELF: PreviewCurve = {
		bands: pad([{ kind: 'LS', freqHz: 1, gainDb: 12.7, qFactor: 0.7 }]),
		preampDb: -0.5
	};
	/** About +11,5 dB at 5 Hz, which the Q27 words hold at 96 kHz; about +3,5 dB at 10 Hz. */
	const SUBSONIC_PEAK: PreviewCurve = {
		bands: pad([{ kind: 'PK', freqHz: 5, gainDb: 12, qFactor: 1 }]),
		preampDb: -0.5
	};
	/** Gains up to Nyquist (experimental HS): its peak is at ω = π. */
	const AIR_SHELF: PreviewCurve = {
		bands: pad([{ kind: 'HS', freqHz: 40000, gainDb: 12, qFactor: 0.71 }]),
		preampDb: -0.5
	};
	/** |H| (dB) of a built chain at `w` rad/sample: its preamp node, then its exact sections. */
	function chainDbAt(chain: PreviewChain, w: number): number {
		const [c1, c2, s1, s2] = [Math.cos(w), Math.cos(2 * w), Math.sin(w), Math.sin(2 * w)];
		let gain = as(chain.preamp, FakeGainNode).gain.value;
		for (const { feedforward: b, feedback: a } of chain.coefficients) {
			const top = Math.hypot(b[0] + b[1] * c1 + b[2] * c2, b[1] * s1 + b[2] * s2);
			const bottom = Math.hypot(a[0] + a[1] * c1 + a[2] * c2, a[1] * s1 + a[2] * s2);
			gain *= top / bottom;
		}
		return 20 * Math.log10(gain);
	}
	/** Brute-force peak (dB) of a built chain from DC to 10 Hz, every 5 mHz. */
	function peakBelow10Hz(chain: PreviewChain): number {
		let peak = -Infinity;
		for (let i = 0; i <= 2000; i++) {
			peak = Math.max(peak, chainDbAt(chain, (2 * Math.PI * (i / 200)) / chain.rate));
		}
		return peak;
	}

	it.each([
		['a 1 Hz low shelf', 48000, SUBSONIC_SHELF, 11.5],
		['a 1 Hz low shelf', 44100, SUBSONIC_SHELF, 11.5],
		['a 5 Hz peak', 96000, SUBSONIC_PEAK, 10],
		['a 5 Hz peak', 48000, SUBSONIC_PEAK, 10]
	] as const)('%s at %i Hz is normalized to -1 dBFS', (_, rate, curve, atLeast) => {
		audioConfig.supportedRates = [rate];
		audioConfig.deviceRate = rate;
		const chain = makeEngine().buildChain(curve.bands, curve.preampDb);
		expect(chain.rate).toBe(rate);
		const low = peakBelow10Hz(chain);
		expect(low).toBeGreaterThan(atLeast);
		// What a grid starting at 10 Hz saw: far less than the real peak.
		expect(chainDbAt(chain, (2 * Math.PI * 10) / rate)).toBeLessThan(low - 5);
		const peak = chainPeakDb(curve.bands, curve.preampDb, rate);
		expect(peak).toBeGreaterThanOrEqual(low - 1e-6);
		// Normalized to -1 dBFS where it really peaks.
		const found = protection(chain);
		expect(found).not.toBeNull();
		expect(low + 20 * Math.log10(found?.gain ?? 1)).toBeLessThanOrEqual(
			YOLO_PREVIEW_PEAK_DBFS + 1e-6
		);
	});

	it.each([48000, 44100])('the 1 Hz low shelf peaks at DC itself at %i Hz', (rate) => {
		audioConfig.supportedRates = [rate];
		audioConfig.deviceRate = rate;
		const chain = makeEngine().buildChain(SUBSONIC_SHELF.bands, SUBSONIC_SHELF.preampDb);
		const dcDb = chainDbAt(chain, 0);
		expect(dcDb).toBeCloseTo(12.2, 1);
		const peak = chainPeakDb(SUBSONIC_SHELF.bands, SUBSONIC_SHELF.preampDb, rate);
		expect(peak).toBeGreaterThanOrEqual(dcDb - 1e-9);
	});

	it('chainPeakDb probes Nyquist exactly', () => {
		const chain = makeEngine().buildChain(AIR_SHELF.bands, AIR_SHELF.preampDb, {
			experimental: true
		});
		const nyquistDb = chainDbAt(chain, Math.PI);
		const peak = chainPeakDb(AIR_SHELF.bands, AIR_SHELF.preampDb, chain.rate);
		expect(peak).toBeGreaterThanOrEqual(nyquistDb - 1e-9);
		const found = protection(chain);
		expect(found).not.toBeNull();
		expect(nyquistDb + 20 * Math.log10(found?.gain ?? 1)).toBeLessThanOrEqual(
			YOLO_PREVIEW_PEAK_DBFS + 1e-9
		);
	});
});
