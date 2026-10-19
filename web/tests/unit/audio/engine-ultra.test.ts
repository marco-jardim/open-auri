/**
 * Filters above 20 kHz in the preview. At 96 kHz (the chip's rate) the chain is exact, Q27 words
 * included. At a fallback rate (48 or 44,1 kHz) every section above 20 kHz is bypassed (an
 * identity stage, so stage k is still the k-th active section) instead of being redesigned near
 * or past that rate's Nyquist; the chain says how many (`skipped`), and its protection still
 * counts them (the louder of what plays and the full curve at 96 kHz). The official presets have
 * nothing above 20 kHz: they play exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NEUTRO, OFFICIAL_PRESETS } from 'open-auri/catalog';
import { designSection, encodeSection, fromWords } from 'open-auri/dsp';
import { gateForWrite } from 'open-auri/safety';
import {
	bypassedOffRate,
	chainPeakDb,
	createAudioEngine,
	dbToGain,
	isBypassedAt,
	PREVIEW_PEAK_LIMIT_DB,
	PREVIEW_RATE,
	sectionCoefficients,
	skippedSections,
	standardGateAccepts,
	YOLO_PREVIEW_PEAK_DBFS,
	type AudioEngine,
	type Band,
	type PreviewChain
} from '#lib/audio/engine.ts';
import {
	audioConfig,
	FakeDynamicsCompressorNode,
	FakeGainNode,
	FakeIIRFilterNode,
	fakeEnv,
	resetAudioConfig
} from './fake-audio.ts';

/** Core's gain band (PK/LS/HS share one type), so spreads keep a gain. */
type GainBand = Extract<Band, { kind: 'PK' | 'LS' | 'HS' }>;
const pad = (active: Band[]): Band[] => [...active, ...NEUTRO.bands.slice(active.length)];
const AUDIBLE: GainBand = { kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 };
const ULTRA_CUT: GainBand = { kind: 'PK', freqHz: 25000, gainDb: -6, qFactor: 1 };
/** A Modo YOLO boost above 20 kHz: +6 dB at 25 kHz, refused by the standard gate. */
const ULTRA_BOOST: GainBand = { kind: 'PK', freqHz: 25000, gainDb: 6, qFactor: 1 };
const IDENTITY = { feedforward: [1, 0, 0], feedback: [1, 0, 0] };

const engines: AudioEngine[] = [];
function engineAt(rate: number): AudioEngine {
	audioConfig.supportedRates = [rate];
	audioConfig.deviceRate = rate;
	const engine = createAudioEngine(fakeEnv(null).env);
	engines.push(engine);
	return engine;
}
function as<T>(node: unknown, type: abstract new (...args: never[]) => T): T {
	if (!(node instanceof type)) throw new Error(`Expected ${type.name}`);
	return node;
}
function coefficients(stage: AudioNode | undefined) {
	const fake = as(stage, FakeIIRFilterNode);
	return { feedforward: fake.feedforward, feedback: fake.feedback };
}
/** The normalizing gain (dB) of a protected chain, or null when it is unprotected. */
function protectionDb(chain: PreviewChain): number | null {
	const tail = chain.stages.length > 0 ? as(chain.stages.at(-1), FakeIIRFilterNode) : null;
	const next: unknown = (tail ?? as(chain.preamp, FakeGainNode)).connections[0];
	if (next === chain.output) return null;
	// A protected chain runs sections → level trim → normalize → limiter → output (#39).
	const trim = as(next, FakeGainNode);
	const normalize = as(trim.connections[0], FakeGainNode);
	expect(as(normalize.connections[0], FakeDynamicsCompressorNode).connections).toEqual([
		chain.output
	]);
	return 20 * Math.log10(normalize.gain.value);
}

beforeEach(resetAudioConfig);
afterEach(async () => {
	await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
});

describe('which sections are bypassed', () => {
	it('only sections above 20 kHz, only away from 96 kHz', () => {
		expect(bypassedOffRate(ULTRA_CUT)).toBe(true);
		expect(bypassedOffRate(ULTRA_BOOST)).toBe(true);
		expect(bypassedOffRate({ kind: 'LP', freqHz: 32000, qFactor: 0.7 })).toBe(true);
		expect(bypassedOffRate({ ...AUDIBLE, freqHz: 20000 })).toBe(false);
		expect(bypassedOffRate({ kind: 'OFF' })).toBe(false);
		// Not a frequency the chip takes: designed (and refused) as before, never silently skipped.
		expect(bypassedOffRate({ ...AUDIBLE, freqHz: Number.NaN })).toBe(false);
		expect(bypassedOffRate({ ...AUDIBLE, freqHz: 48000 })).toBe(false);
		for (const rate of [48000, 44100]) expect(isBypassedAt(ULTRA_CUT, rate)).toBe(true);
		expect(isBypassedAt(ULTRA_CUT, PREVIEW_RATE)).toBe(false);
		const bands = pad([AUDIBLE, ULTRA_CUT, { kind: 'LP', freqHz: 30000, qFactor: 0.7 }]);
		expect(skippedSections(bands, 48000)).toBe(2);
		expect(skippedSections(bands, 44100)).toBe(2);
		expect(skippedSections(bands, PREVIEW_RATE)).toBe(0);
	});

	it('a section above 20 kHz is identity at 48 kHz and exact at 96 kHz, never a throw', () => {
		expect(sectionCoefficients(ULTRA_CUT, 1, 48000)).toEqual(IDENTITY);
		expect(sectionCoefficients(ULTRA_BOOST, 1, 44100)).toEqual(IDENTITY);
		const s = fromWords(encodeSection(designSection(ULTRA_CUT, PREVIEW_RATE), 1));
		expect(sectionCoefficients(ULTRA_CUT, 1, PREVIEW_RATE)).toEqual({
			feedforward: [s.b0, s.b1, s.b2],
			feedback: [1, s.a1, s.a2]
		});
		// Audible sections are still redesigned for the fallback rate.
		const a = designSection(AUDIBLE, 48000);
		expect(sectionCoefficients(AUDIBLE, 0, 48000)).toEqual({
			feedforward: [a.b0, a.b1, a.b2],
			feedback: [1, a.a1, a.a2]
		});
	});

	it('the official presets have nothing above 20 kHz: nothing is ever skipped', () => {
		expect(OFFICIAL_PRESETS).toHaveLength(11);
		[...OFFICIAL_PRESETS, NEUTRO].forEach((preset, index) => {
			for (const rate of [PREVIEW_RATE, 48000, 44100]) {
				expect(skippedSections(preset.bands, rate), `#${index} @ ${rate}`).toBe(0);
			}
		});
	});
});

describe('chains at a fallback rate', () => {
	it('a 25 kHz band at 48 kHz is bypassed in place, without throwing', () => {
		const engine = engineAt(48000);
		const bands = pad([AUDIBLE, ULTRA_CUT]);
		expect(gateForWrite(bands, -1).ok).toBe(true);
		const chain = engine.buildChain(bands, -1);
		expect(chain.exact).toBe(false);
		expect(chain.skipped).toBe(1);
		// One stage per active section, in written order: stage meters stay on their bands.
		expect(chain.stages).toHaveLength(2);
		const a = designSection(AUDIBLE, 48000);
		expect(coefficients(chain.stages[0])).toEqual({
			feedforward: [a.b0, a.b1, a.b2],
			feedback: [1, a.a1, a.a2]
		});
		expect(coefficients(chain.stages[1])).toEqual(IDENTITY);
		expect(engine.state().note).toBe('rate-fallback');
		// A standard curve, quiet: unprotected, as before.
		expect(protectionDb(chain)).toBeNull();
	});

	it('at 96 kHz the same curve plays exactly, nothing skipped', () => {
		const engine = engineAt(PREVIEW_RATE);
		const chain = engine.buildChain(pad([AUDIBLE, ULTRA_CUT]), -1);
		expect(chain.exact).toBe(true);
		expect(chain.skipped).toBe(0);
		const s = fromWords(encodeSection(designSection(ULTRA_CUT, PREVIEW_RATE), 1));
		expect(coefficients(chain.stages[1])).toEqual({
			feedforward: [s.b0, s.b1, s.b2],
			feedback: [1, s.a1, s.a2]
		});
	});

	it('the protection still counts a bypassed boost: the full curve at 96 kHz', () => {
		const bands = pad([ULTRA_BOOST]);
		const preampDb = -0.5;
		expect(standardGateAccepts(bands, preampDb)).toBe(false);
		const full = chainPeakDb(bands, preampDb, PREVIEW_RATE);
		// About +5,5 dB at 25 kHz: louder than anything the standard gate allows.
		expect(full).toBeGreaterThan(5);
		expect(full).toBeGreaterThan(PREVIEW_PEAK_LIMIT_DB);
		for (const rate of [48000, 44100]) {
			// What plays at that rate is the preamp alone; the peak is still the full curve's.
			expect(chainPeakDb(bands, preampDb, rate)).toBe(full);
		}
		const engine = engineAt(48000);
		const chain = engine.buildChain(bands, preampDb);
		expect(chain.skipped).toBe(1);
		expect(protectionDb(chain)).toBeCloseTo(YOLO_PREVIEW_PEAK_DBFS - full, 6);
		// The shared protection (Comparar, Teste cego, createAB) counts it the same way.
		const shared = engine.sharedProtection([{ bands, preampDb }]);
		expect(shared?.gainDb).toBeCloseTo(YOLO_PREVIEW_PEAK_DBFS - full, 6);
		const neutral = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
		const ab = engine.createAB(neutral, { bands, preampDb });
		expect(ab.b.skipped).toBe(1);
		const loudest = Math.max(
			chainPeakDb(NEUTRO.bands, NEUTRO.preampDb, 48000) + ab.trims[0],
			full + ab.trims[1]
		);
		expect(protectionDb(ab.b)).toBeCloseTo(
			20 * Math.log10(dbToGain(Math.min(0, YOLO_PREVIEW_PEAK_DBFS - loudest))),
			6
		);
	});

	it('the played chain counts too when it is the louder one', () => {
		// A cut above 20 kHz lowers the top of the full curve; the chain that plays lacks it.
		const lift: Band = { kind: 'PK', freqHz: 18000, gainDb: 6, qFactor: 1 };
		const bands = pad([lift, ULTRA_CUT]);
		const played = chainPeakDb(pad([lift]), -3, 48000);
		const full = chainPeakDb(bands, -3, PREVIEW_RATE);
		expect(played).toBeGreaterThan(full);
		expect(chainPeakDb(bands, -3, 48000)).toBe(played);
	});
});
