// T4.T gate parity: the server gate (`checkCurve`, social/gate.ts: S1 → cache → gateForWrite) and
// the browser gate (`handleGateRequest` commit of src/lib/workers/gate-handler.ts, the entry the
// editor worker, the SSR fallback and the write checklist use) must agree on the verdict and on
// the reason codes (de-duplicated, gate order) for every curve.
//
// Corpus (> 500 curves, deterministic): the 11 official presets of the reference fixture, Neutro
// at the preamp limits, known-rejected shapes, single-band boundary curves at the edges of
// ABS_RANGES / THRESHOLDS (open-auri/safety; the same numbers as design/analysis/limites-v2.json)
// and seeded random curves. Both sides gate the S1-decoded bands (what is published and written).
// Only curves the S1 codec accepts are compared (the codec refuses the rest before any gate).
//
// CPU: gateForWrite is ~150 ms per curve in workerd and runs twice per curve here, sequentially
// (never in parallel), in chunks with their own generous timeout.
import { env } from 'cloudflare:workers';
import { NEUTRAL_BANDS } from 'open-auri/dsp';
import { ABS_RANGES, isExperimentalKind, THRESHOLDS } from 'open-auri/safety';
import { decodeS1, encodeS1 } from 'open-auri/share';
import { describe, expect, it } from 'vitest';
import { checkCurve } from '#lib/server/social/gate.ts';
import { handleGateRequest } from '#lib/workers/gate-handler.ts';
import reference from '../../../test/fixtures/eq0xcb.reference.json';

type Curve = Parameters<typeof encodeS1>[0];
type Band = Curve['bands'][number];
type Kind = 'PK' | 'LS' | 'HS' | 'LP' | 'HP';

const CORPUS_TARGET = 560;
const CHUNK = 80;
const CHUNK_TIMEOUT_MS = 300_000;

function band(kind: Kind, freqHz: number, gainDb: number, qFactor: number): Band {
	if (kind === 'LP' || kind === 'HP') return { kind, freqHz, qFactor };
	return { kind, freqHz, gainDb, qFactor };
}

/** Neutral bands with `bands` in the first slots. */
function curve(bands: readonly Band[], preampDb: number): Curve {
	return { bands: NEUTRAL_BANDS.map((neutral, i) => bands[i] ?? neutral), preampDb };
}

/** mulberry32: small seeded PRNG (deterministic corpus). */
function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const round = (value: number, step: number) => Math.round(value / step) * step;

function presets(): Curve[] {
	return Object.values(reference.presets).map((preset) => ({
		bands: preset.eqBands as Band[],
		preampDb: preset.preampDb
	}));
}

function knownRejected(): Curve[] {
	const pk = (freqHz: number, gainDb: number, qFactor: number) =>
		band('PK', freqHz, gainDb, qFactor);
	return [
		// HS shelves: experimental kinds, allowed by the flag both sides derive from the curve
		// (standard since GATE_IMPL 2); the boost one still fails other checks or passes alike.
		curve([band('HS', 8000, -3, 0.71)], -1),
		curve([band('HS', 4000, 3, 0.71), band('HS', 12000, -6, 0.71)], -6),
		// D7: no PK boost above 16 kHz, no boost with Q above 4.
		curve([pk(ABS_RANGES.pkBoostMaxHz + 1, 3, 1)], -4),
		curve([pk(1000, 3, ABS_RANGES.boostQMax + 0.01)], -4),
		// Stacked boosts: output above the audible / full-scale limits.
		curve(
			Array.from({ length: 10 }, () => pk(1000, ABS_RANGES.gainDb.max, 1)),
			THRESHOLDS.preampMaxDb
		),
		curve(
			Array.from({ length: 5 }, (_, i) => pk(200 * (i + 1), 6, 0.7)),
			THRESHOLDS.preampMaxDb
		),
		// Preamp outside the window.
		curve([pk(1000, -3, 1)], 0),
		curve([pk(1000, -3, 1)], THRESHOLDS.preampMinDb - 1)
	];
}

function boundaries(): Curve[] {
	const out: Curve[] = [];
	const { freqHz, gainDb, qFactor, boostQMax, pkBoostMaxHz } = ABS_RANGES;
	const freqs = [freqHz.min, freqHz.max, pkBoostMaxHz, pkBoostMaxHz + 1, 1000];
	const gains = [gainDb.max, gainDb.max + 0.1, gainDb.min, gainDb.min - 0.1, 0.1, -0.1];
	const qs = [qFactor.min, qFactor.max, boostQMax, boostQMax + 0.01];
	const preamps = [
		THRESHOLDS.preampMaxDb,
		THRESHOLDS.preampMinDb,
		THRESHOLDS.preampMaxDb - 0.1,
		-12
	];
	let p = 0;
	for (const kind of ['PK', 'LS'] as const) {
		for (const f of freqs) {
			for (const g of gains) {
				for (const q of qs) {
					out.push(curve([band(kind, f, g, q)], preamps[p++ % preamps.length] ?? -12));
				}
			}
		}
	}
	for (const kind of ['LP', 'HP'] as const) {
		for (const f of [20, 30, 50, 20000]) {
			for (const q of [0.49, 0.5, 0.7, 0.71]) {
				out.push(curve([band(kind, f, 0, q)], preamps[p++ % preamps.length] ?? -12));
			}
		}
	}
	return out;
}

function randomCurve(next: () => number): Curve {
	const kinds: readonly Kind[] = ['PK', 'PK', 'PK', 'PK', 'LS', 'LS', 'HS', 'LP', 'HP'];
	const count = 1 + Math.floor(next() * 4);
	const bands: Band[] = [];
	for (let i = 0; i < count; i++) {
		const kind = kinds[Math.floor(next() * kinds.length)] ?? 'PK';
		const freq = round(20 * Math.pow(1000, next()), 1);
		const gain = round(-24 + next() * 33.2, 0.1);
		const pass = kind === 'LP' || kind === 'HP';
		const q = pass ? round(0.5 + next() * 0.2, 0.01) : round(0.1 + next() * 5.9, 0.01);
		bands.push(band(kind, freq, gain, q));
	}
	return curve(bands, round(-25.5 + next() * 25, 0.1));
}

interface Entry {
	label: string;
	s1: string;
}

/** Encodable, distinct curves, in a fixed order. */
function buildCorpus(): Entry[] {
	const entries: Entry[] = [];
	const seen = new Set<string>();
	const add = (label: string, candidate: Curve) => {
		let s1: string;
		try {
			s1 = encodeS1(candidate);
			decodeS1(s1);
		} catch {
			return; // refused by the codec: never reaches a gate
		}
		if (seen.has(s1)) return;
		seen.add(s1);
		entries.push({ label, s1 });
	};
	presets().forEach((preset, i) => add(`preset ${i}`, preset));
	add('neutro 0 dB', curve([], 0));
	add('neutro max preamp', curve([], THRESHOLDS.preampMaxDb));
	add('neutro min preamp', curve([], THRESHOLDS.preampMinDb));
	knownRejected().forEach((shape, i) => add(`rejected shape ${i}`, shape));
	boundaries().forEach((shape, i) => add(`boundary ${i}`, shape));
	const next = prng(0x0a0f1e1d);
	for (let i = 0; entries.length < CORPUS_TARGET && i < 20 * CORPUS_TARGET; i++) {
		add(`random ${i}`, randomCurve(next));
	}
	return entries;
}

const CORPUS = buildCorpus();

/**
 * Codes only the YOLO profile computes: a rejected curve's cached reasons add them when the
 * server's classification ran that profile (GATE_IMPL 2); the standard browser verdict never has
 * them.
 */
const YOLO_ONLY = new Set(['d:prefix-peak-full', 'd:prefix-peak-extended', 'e:output-extended']);

/**
 * The editor's commit verdict, with `experimental` derived from the curve exactly as the editor
 * (`hasExperimental`) and the server (gate.ts) derive it.
 */
function browserVerdict(s1: string): { ok: boolean; reasons: string[] } {
	const { bands, preampDb } = decodeS1(s1);
	const experimental = bands.some((band) => isExperimentalKind(band.kind));
	const response = handleGateRequest({ type: 'commit', id: 1, bands, preampDb, experimental });
	if (response.type !== 'commit') throw new Error('unexpected gate response');
	const { verdict } = response;
	return { ok: verdict.ok, reasons: [...new Set(verdict.reasons.map((r) => String(r.code)))] };
}

/**
 * What the server answers for `s1` (cache included, exactly as publication sees it). The cache is
 * not forced stale: other files rely on cached presets concurrently, and every curve of this
 * corpus is either a preset (accepted either way) or deterministic and unique to this file.
 */
async function serverVerdict(s1: string): Promise<{ ok: boolean; reasons: string[] }> {
	const check = await checkCurve(env.DB, s1);
	if (check.ok) return { ok: true, reasons: [] };
	if (check.code === 'invalid-curve') return { ok: false, reasons: check.codes };
	// `checkCurve` keeps ok = standard: a YOLO curve answers its waived codes (the standard ones),
	// a rejected one its standard codes plus the YOLO-only ones, dropped here.
	return { ok: false, reasons: check.reasons.filter((code) => !YOLO_ONLY.has(code)) };
}

const verdicts = { accepted: 0, rejected: 0 };

describe('gate parity: server checkCurve × browser gateForWrite', () => {
	it(`the corpus has more than 500 distinct encodable curves, presets and Neutro included`, () => {
		expect(CORPUS.length).toBeGreaterThan(500);
		expect(CORPUS.filter((entry) => entry.label.startsWith('preset')).length).toBe(11);
		expect(CORPUS.some((entry) => entry.label.startsWith('neutro'))).toBe(true);
		expect(CORPUS.some((entry) => entry.label.startsWith('rejected'))).toBe(true);
		expect(CORPUS.some((entry) => entry.label.startsWith('boundary'))).toBe(true);
	});

	for (let start = 0; start < CORPUS.length; start += CHUNK) {
		const chunk = CORPUS.slice(start, start + CHUNK);
		it(
			`curves ${start}–${start + chunk.length - 1}: same verdict and same reason codes`,
			async () => {
				for (const entry of chunk) {
					const browser = browserVerdict(entry.s1);
					const server = await serverVerdict(entry.s1);
					expect(server, `${entry.label} ${entry.s1}`).toEqual(browser);
					verdicts[browser.ok ? 'accepted' : 'rejected']++;
				}
			},
			CHUNK_TIMEOUT_MS
		);
	}

	it('the corpus exercises both verdicts', () => {
		expect(verdicts.accepted).toBeGreaterThan(0);
		expect(verdicts.rejected).toBeGreaterThan(0);
	});
});
