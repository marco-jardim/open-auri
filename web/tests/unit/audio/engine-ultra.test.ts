/**
 * Filters above 20 kHz in the preview. At 96 kHz (the chip's rate) the chain is exact, Q27 words
 * included. At a fallback rate (48 or 44,1 kHz) no section above 20 kHz is redesigned as it is
 * near or past that rate's Nyquist: one that changes nothing audible on the chip (less than
 * 0,1 dB between 20 Hz and 20 kHz) is bypassed (an identity stage, so stage k is still the k-th
 * active section); one that does plays a stand-in matching the chip's audible response, unless
 * the bypass is closer. The chain says how many of each (`skipped`, `approximated`), and its
 * protection still counts them (the louder of what plays and the full curve at 96 kHz). The
 * official presets have nothing above 20 kHz: they play exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NEUTRO, OFFICIAL_PRESETS } from 'open-auri/catalog';
import { designSection, encodeSection, fromWords } from 'open-auri/dsp';
import { gateForWrite } from 'open-auri/safety';
import {
	approximatedSections,
	chainPeakDb,
	createAudioEngine,
	dbToGain,
	isApproximatedAt,
	isBypassedAt,
	OFF_RATE_BYPASS_DB,
	offRateTreatment,
	PREVIEW_PEAK_LIMIT_DB,
	PREVIEW_RATE,
	sectionCoefficients,
	skippedSections,
	ultrasonicOffRate,
	YOLO_PREVIEW_PEAK_DBFS,
	type AudioEngine,
	type Band,
	type IIRCoefficients,
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
/** A cut above 20 kHz whose skirt the chip plays below 20 kHz (about −4 dB at 20 kHz). */
const ULTRA_CUT: GainBand = { kind: 'PK', freqHz: 25000, gainDb: -6, qFactor: 1 };
/** A cut above 20 kHz nobody hears below 20 kHz on the chip (about −0,07 dB at 20 kHz). */
const TINY: GainBand = { kind: 'PK', freqHz: 30000, gainDb: -0.2, qFactor: 1 };
/** An Engenharia cut above 20 kHz that lowers the whole audible band (about −60 dB at 1 kHz). */
const ULTRA_HP: Band = { kind: 'HP', freqHz: 25000, qFactor: 0.71 };
/**
 * A narrow Modo YOLO boost above 20 kHz: +6 dB at 30 kHz (refused by the standard gate), under
 * 0,1 dB anywhere below 20 kHz on the chip, so a fallback rate bypasses it.
 */
const ULTRA_BOOST: GainBand = { kind: 'PK', freqHz: 30000, gainDb: 6, qFactor: 8 };
const IDENTITY = { feedforward: [1, 0, 0], feedback: [1, 0, 0] };

type Coefficients = Readonly<Record<keyof IIRCoefficients, readonly number[]>>;

/** |H| (dB) of one section at `freqHz`, at `rate`. */
function sectionDb(c: Coefficients, freqHz: number, rate: number): number {
	const w = (2 * Math.PI * freqHz) / rate;
	const [b0 = NaN, b1 = NaN, b2 = NaN] = c.feedforward;
	const [a0 = NaN, a1 = NaN, a2 = NaN] = c.feedback;
	const re = (x0: number, x1: number, x2: number) => x0 + x1 * Math.cos(w) + x2 * Math.cos(2 * w);
	const im = (x1: number, x2: number) => x1 * Math.sin(w) + x2 * Math.sin(2 * w);
	const num = Math.hypot(re(b0, b1, b2), im(b1, b2));
	return 20 * Math.log10(num / Math.hypot(re(a0, a1, a2), im(a1, a2)));
}
/** Largest |dB| the chip's exact section makes between 20 Hz and 20 kHz. */
function audibleEffectDb(band: Band): number {
	const exact = sectionCoefficients(band, 0, PREVIEW_RATE);
	let worst = Math.abs(sectionDb(exact, 20000, PREVIEW_RATE));
	for (let f = 20; f <= 20000; f *= 1.05) {
		worst = Math.max(worst, Math.abs(sectionDb(exact, f, PREVIEW_RATE)));
	}
	return worst;
}

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

describe('which sections are bypassed or approximated', () => {
	it('only sections above 20 kHz, only away from 96 kHz', () => {
		expect(ultrasonicOffRate(ULTRA_CUT)).toBe(true);
		expect(ultrasonicOffRate(ULTRA_BOOST)).toBe(true);
		expect(ultrasonicOffRate({ kind: 'LP', freqHz: 32000, qFactor: 0.7 })).toBe(true);
		expect(ultrasonicOffRate({ ...AUDIBLE, freqHz: 20000 })).toBe(false);
		expect(ultrasonicOffRate({ kind: 'OFF' })).toBe(false);
		// Not a frequency the chip takes: designed (and refused) as before, never silently skipped.
		expect(ultrasonicOffRate({ ...AUDIBLE, freqHz: Number.NaN })).toBe(false);
		expect(ultrasonicOffRate({ ...AUDIBLE, freqHz: 48000 })).toBe(false);
		for (const band of [ULTRA_CUT, TINY, ULTRA_HP, AUDIBLE]) {
			expect(offRateTreatment(band, PREVIEW_RATE)).toBeNull();
		}
		expect(offRateTreatment(AUDIBLE, 48000)).toBeNull();
	});

	it('a section nobody hears below 20 kHz is still bypassed', () => {
		expect(audibleEffectDb(TINY)).toBeLessThan(OFF_RATE_BYPASS_DB);
		expect(audibleEffectDb(ULTRA_BOOST)).toBeLessThan(OFF_RATE_BYPASS_DB);
		for (const rate of [48000, 44100]) {
			expect(isBypassedAt(TINY, rate)).toBe(true);
			expect(isApproximatedAt(TINY, rate)).toBe(false);
			expect(isBypassedAt(ULTRA_BOOST, rate)).toBe(true);
			expect(sectionCoefficients(TINY, 1, rate)).toEqual(IDENTITY);
			expect(sectionCoefficients(ULTRA_BOOST, 1, rate)).toEqual(IDENTITY);
		}
	});

	it('a section the chip plays below 20 kHz gets a stand-in closer than the bypass', () => {
		expect(audibleEffectDb(ULTRA_CUT)).toBeGreaterThan(1);
		expect(audibleEffectDb(ULTRA_HP)).toBeGreaterThan(40);
		expect(isApproximatedAt(ULTRA_CUT, 48000)).toBe(true);
		for (const rate of [48000, 44100]) {
			expect(isApproximatedAt(ULTRA_HP, rate)).toBe(true);
			expect(isBypassedAt(ULTRA_HP, rate)).toBe(false);
			const stand = sectionCoefficients(ULTRA_HP, 1, rate);
			expect(stand).not.toEqual(IDENTITY);
			expect([...stand.feedforward, ...stand.feedback].every(Number.isFinite)).toBe(true);
		}
		const bands = pad([AUDIBLE, TINY, ULTRA_HP]);
		for (const rate of [48000, 44100]) {
			expect(skippedSections(bands, rate)).toBe(1);
			expect(approximatedSections(bands, rate)).toBe(1);
		}
		expect(skippedSections(bands, PREVIEW_RATE)).toBe(0);
		expect(approximatedSections(bands, PREVIEW_RATE)).toBe(0);
	});

	it('an HP at 25 kHz plays attenuated across the audible band at 48 and 44,1 kHz', () => {
		const exact = sectionCoefficients(ULTRA_HP, 1, PREVIEW_RATE);
		const chip1k = sectionDb(exact, 1000, PREVIEW_RATE);
		// The chip cuts about 60 dB at 1 kHz.
		expect(chip1k).toBeLessThan(-50);
		for (const rate of [48000, 44100]) {
			const played = sectionCoefficients(ULTRA_HP, 1, rate);
			expect(Math.abs(sectionDb(played, 1000, rate) - chip1k)).toBeLessThan(1);
			for (const f of [100, 5000]) {
				const chip = sectionDb(exact, f, PREVIEW_RATE);
				expect(Math.abs(sectionDb(played, f, rate) - chip)).toBeLessThan(1);
			}
		}
	});

	it('a section above 20 kHz is exact at 96 kHz and never a throw elsewhere', () => {
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

	it('the official presets have nothing above 20 kHz: nothing is ever skipped or approximated', () => {
		expect(OFFICIAL_PRESETS).toHaveLength(11);
		[...OFFICIAL_PRESETS, NEUTRO].forEach((preset, index) => {
			for (const rate of [PREVIEW_RATE, 48000, 44100]) {
				expect(skippedSections(preset.bands, rate), `#${index} @ ${rate}`).toBe(0);
				expect(approximatedSections(preset.bands, rate), `#${index} @ ${rate}`).toBe(0);
				// Every preset section is designed for the rate exactly as before.
				preset.bands.forEach((band, i) => {
					if (band.kind === 'OFF') return;
					const s =
						rate === PREVIEW_RATE
							? fromWords(encodeSection(designSection(band, PREVIEW_RATE), i))
							: designSection(band, rate);
					expect(sectionCoefficients(band, i, rate)).toEqual({
						feedforward: [s.b0, s.b1, s.b2],
						feedback: [1, s.a1, s.a2]
					});
				});
			}
		});
	});
});

describe('chains at a fallback rate', () => {
	it('an inaudible band above 20 kHz at 48 kHz is bypassed in place, without throwing', () => {
		const engine = engineAt(48000);
		const bands = pad([AUDIBLE, TINY]);
		const chain = engine.buildChain(bands, -1);
		expect(chain.exact).toBe(false);
		expect(chain.skipped).toBe(1);
		expect(chain.approximated).toBe(0);
		// One stage per active section, in written order: stage meters stay on their bands.
		expect(chain.stages).toHaveLength(2);
		const a = designSection(AUDIBLE, 48000);
		expect(coefficients(chain.stages[0])).toEqual({
			feedforward: [a.b0, a.b1, a.b2],
			feedback: [1, a.a1, a.a2]
		});
		expect(coefficients(chain.stages[1])).toEqual(IDENTITY);
		expect(engine.state().note).toBe('rate-fallback');
		// A quiet curve the standard gate accepts stays unprotected, as before.
		expect(protectionDb(chain) === null).toBe(gateForWrite(bands, -1).ok);
	});

	it('a 25 kHz HP at 48 kHz plays its audible-band stand-in in place', () => {
		const engine = engineAt(48000);
		const bands = pad([AUDIBLE, ULTRA_HP]);
		const chain = engine.buildChain(bands, -1, { experimental: true });
		expect(chain.skipped).toBe(0);
		expect(chain.approximated).toBe(1);
		expect(chain.stages).toHaveLength(2);
		const stand = coefficients(chain.stages[1]);
		expect(stand).toEqual(sectionCoefficients(ULTRA_HP, 1, 48000));
		const chip = sectionCoefficients(ULTRA_HP, 1, PREVIEW_RATE);
		// Within 1 dB of what the chip plays at 1 kHz (about −60 dB), not full band.
		const played = sectionDb(stand, 1000, 48000);
		expect(played).toBeLessThan(-50);
		expect(Math.abs(played - sectionDb(chip, 1000, PREVIEW_RATE))).toBeLessThan(1);
	});

	it('at 96 kHz the same curve plays exactly, nothing skipped', () => {
		const engine = engineAt(PREVIEW_RATE);
		const chain = engine.buildChain(pad([AUDIBLE, ULTRA_CUT]), -1);
		expect(chain.exact).toBe(true);
		expect(chain.skipped).toBe(0);
		expect(chain.approximated).toBe(0);
		const s = fromWords(encodeSection(designSection(ULTRA_CUT, PREVIEW_RATE), 1));
		expect(coefficients(chain.stages[1])).toEqual({
			feedforward: [s.b0, s.b1, s.b2],
			feedback: [1, s.a1, s.a2]
		});
	});

	it('the protection still counts a bypassed boost: the full curve at 96 kHz', () => {
		const bands = pad([ULTRA_BOOST]);
		const preampDb = -0.5;
		expect(isBypassedAt(ULTRA_BOOST, 48000)).toBe(true);
		const full = chainPeakDb(bands, preampDb, PREVIEW_RATE);
		// About +5,5 dB at 30 kHz: louder than anything the standard gate allows.
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
		// A (bypassed) cut above 20 kHz lowers the top of the full curve; the chain that plays
		// lacks it.
		const lift: Band = { kind: 'PK', freqHz: 18000, gainDb: 6, qFactor: 1 };
		const bands = pad([lift, TINY]);
		const played = chainPeakDb(pad([lift]), -3, 48000);
		const full = chainPeakDb(bands, -3, PREVIEW_RATE);
		expect(played).toBeGreaterThan(full);
		expect(chainPeakDb(bands, -3, 48000)).toBe(played);
	});

	it('an approximated section is protected for the louder of its stand-in and the chip', () => {
		const lift: Band = { kind: 'PK', freqHz: 18000, gainDb: 6, qFactor: 1 };
		const bands = pad([lift, ULTRA_CUT]);
		expect(approximatedSections(bands, 48000)).toBe(1);
		const full = chainPeakDb(bands, -3, PREVIEW_RATE);
		expect(chainPeakDb(bands, -3, 48000)).toBeGreaterThanOrEqual(full);
		const engine = engineAt(48000);
		const chain = engine.buildChain(pad([ULTRA_HP]), -0.5, { experimental: true });
		expect(chain.approximated).toBe(1);
		expect(chainPeakDb(pad([ULTRA_HP]), -0.5, 48000)).toBeGreaterThanOrEqual(
			chainPeakDb(pad([ULTRA_HP]), -0.5, PREVIEW_RATE)
		);
	});
});
