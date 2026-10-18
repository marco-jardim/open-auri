/**
 * C1 backstop versus the official catalog. The standard gate's limits are the envelope the 11
 * official presets define (`THRESHOLDS`, "observed envelope"), so one of them peaks exactly at
 * `outputFullDb` (Basshead: LS +8,2 dB with preamp −5,7 dB, at DC): the preview backstop
 * (`PREVIEW_PEAK_LIMIT_DB`, the same limit plus 0,01 dB for the numerics) must still let every
 * official preset and Neutro play unprotected, exactly as before, at the chip rate and at the
 * fallback rates, while any curve the standard gate refuses keeps its normalize + limiter stage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NEUTRO, OFFICIAL_PRESETS } from 'open-auri/catalog';
import { snapshotBands } from 'open-auri/dsp';
import { gateForWrite, THRESHOLDS } from 'open-auri/safety';
import {
	chainPeakDb,
	createAudioEngine,
	PREVIEW_PEAK_LIMIT_DB,
	PREVIEW_RATE,
	standardGateAccepts,
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

const CATALOG = [...OFFICIAL_PRESETS, NEUTRO];
const NEUTRAL: PreviewCurve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
const pad = (active: Band[]): Band[] => [...active, ...NEUTRO.bands.slice(active.length)];
/** Refused by the standard gate, quiet (YOLO only): HP 30 Hz. */
const QUIET_REFUSED: PreviewCurve = {
	bands: pad([{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]),
	preampDb: -0.5
};
/** Refused by the standard gate and louder than it allows: +12 dB at 1 kHz. */
const LOUD_REFUSED: PreviewCurve = {
	bands: pad([{ kind: 'PK', freqHz: 1000, gainDb: 12, qFactor: 1 }]),
	preampDb: -0.5
};
/** Chip rate, then the device rates a browser may fall back to (coefficients recomputed). */
const RATES = [PREVIEW_RATE, 48000, 44100] as const;

const engines: AudioEngine[] = [];
function engineAt(rate: number): { engine: AudioEngine; context: () => FakeAudioContext } {
	audioConfig.supportedRates = [rate];
	audioConfig.deviceRate = rate;
	const engine = createAudioEngine(fakeEnv(null).env);
	engines.push(engine);
	return {
		engine,
		context: () => {
			const only = audioConfig.instances[0];
			if (!only) throw new Error('No audio context');
			expect(only.sampleRate).toBe(rate);
			return only;
		}
	};
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
/** Whether the sections feed the chain's output directly (no protection stage). */
function unprotected(chain: PreviewChain): boolean {
	return afterSections(chain) === chain.output;
}
/** Whether a normalize gain then a limiter sit between the sections and the chain's output. */
function protectedChain(chain: PreviewChain): boolean {
	const next = afterSections(chain);
	if (next === chain.output) return false;
	const [limiter] = as(next, FakeGainNode).connections;
	expect(as(limiter, FakeDynamicsCompressorNode).connections).toEqual([chain.output]);
	return true;
}

beforeEach(resetAudioConfig);
afterEach(async () => {
	await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
	resetAudioConfig();
});

it('the catalog is the 11 official presets plus Neutro', () => {
	expect(OFFICIAL_PRESETS).toHaveLength(11);
	expect(new Set(CATALOG.map((preset) => preset.id)).size).toBe(12);
	expect(PREVIEW_PEAK_LIMIT_DB).toBe(THRESHOLDS.outputFullDb + 0.01);
});

describe.each(CATALOG.map((preset) => [preset.id, preset] as const))('%s', (id, preset) => {
	it('passes the standard gate (standardGateAccepts and gateForWrite)', () => {
		expect(gateForWrite(preset.bands, preset.preampDb).ok, id).toBe(true);
		expect(standardGateAccepts(snapshotBands(preset.bands), preset.preampDb), id).toBe(true);
	});

	it.each(RATES)('is under the preview backstop at %i Hz', (rate) => {
		const peak = chainPeakDb(preset.bands, preset.preampDb, rate);
		expect(Number.isFinite(peak), `${id} float peak`).toBe(true);
		expect(peak, `${id} float peak ${peak} dB at ${rate} Hz`).toBeLessThanOrEqual(
			PREVIEW_PEAK_LIMIT_DB
		);
	});

	it.each(RATES)('plays unprotected at %i Hz: buildChain and createAB add nothing', (rate) => {
		const { engine, context } = engineAt(rate);
		const chain = engine.buildChain(preset.bands, preset.preampDb, { experimental: true });
		expect(unprotected(chain), `${id} buildChain`).toBe(true);
		// As the Biblioteca sheet auditions a tape against the editor curve (TrackSheet).
		const ab = engine.createAB(NEUTRAL, preset, { experimental: true });
		expect(unprotected(ab.a), `${id} createAB A`).toBe(true);
		expect(unprotected(ab.b), `${id} createAB B`).toBe(true);
		expect(context().compressors).toHaveLength(0);
	});
});

describe('curves the standard gate refuses stay protected', () => {
	it('the fixtures are refused by the standard gate', () => {
		for (const curve of [QUIET_REFUSED, LOUD_REFUSED]) {
			expect(standardGateAccepts(snapshotBands(curve.bands), curve.preampDb)).toBe(false);
		}
		expect(chainPeakDb(QUIET_REFUSED.bands, QUIET_REFUSED.preampDb, PREVIEW_RATE)).toBeLessThan(
			PREVIEW_PEAK_LIMIT_DB
		);
		expect(chainPeakDb(LOUD_REFUSED.bands, LOUD_REFUSED.preampDb, PREVIEW_RATE)).toBeGreaterThan(
			PREVIEW_PEAK_LIMIT_DB
		);
	});

	it.each([
		['quiet but refused', QUIET_REFUSED],
		['loud and refused', LOUD_REFUSED]
	] as const)('%s: buildChain and createAB against an official preset', (_, curve) => {
		const { engine, context } = engineAt(PREVIEW_RATE);
		const official = OFFICIAL_PRESETS[0];
		if (!official) throw new Error('No official preset');
		expect(
			protectedChain(engine.buildChain(curve.bands, curve.preampDb, { experimental: true }))
		).toBe(true);
		// One refused side protects both, so the A/B level match holds.
		const ab = engine.createAB(official, curve, { experimental: true });
		expect(protectedChain(ab.a)).toBe(true);
		expect(protectedChain(ab.b)).toBe(true);
		expect(context().compressors).toHaveLength(3);
	});
});
