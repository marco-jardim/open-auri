import { describe, expect, test } from 'vitest';
import { curveResponseDb, ISO226_TABLE, loudnessCompensationDb } from 'open-auri/dsp';
import { autoPreamp, gateForWrite, HARD_REASONS, isWaivable } from 'open-auri/safety';
import { decodeS1, encodeS1, normalizeLabels } from 'open-auri/share';
import {
	decideExperiment,
	EXPERIMENT_IDS,
	EXPERIMENTS,
	experimentStatus,
	getExperiment,
	lockedIn,
	needsEngenharia,
	requiresYolo,
	type Experiment
} from '#lib/components/pages/curva/experiments.ts';
import { hasExperimental } from '#lib/components/pages/curva/model.ts';
import type { GateVerdict } from '#lib/components/pages/curva/reasons.ts';

const codes = (verdict: GateVerdict) => verdict.reasons.map((reason) => reason.code);

/** The core write gate (full grid) in both profiles, called the way the editor calls it. */
function gates(experiment: Experiment) {
	const experimental = hasExperimental(experiment.bands);
	return {
		standard: gateForWrite(experiment.bands, experiment.preampDb, { experimental }),
		yolo: gateForWrite(experiment.bands, experiment.preampDb, { experimental, profile: 'yolo' })
	};
}

function experiment(id: string): Experiment {
	const found = getExperiment(id);
	if (!found) throw new Error(`no experiment ${id}`);
	return found;
}

/** Response in dB at `freqHz`, preamp excluded (the ideal sections, as the scope draws them). */
function responseAt(x: Experiment, freqHz: number): number {
	return curveResponseDb({ bands: x.bands, preampDb: 0 }, [freqHz])[0] ?? Number.NaN;
}

/** Response in dB at `freqs` (preamp excluded), relative to the response at `refHz`. */
function relative(x: Experiment, freqs: readonly number[], refHz = 1000): number[] {
	const ref = responseAt(x, refHz);
	return freqs.map((freqHz) => responseAt(x, freqHz) - ref);
}

describe('Experimentos: curated experimental curves', () => {
	test('thirteen experiments, unique ids, ten bands and ten labels each', () => {
		expect(EXPERIMENTS.map((x) => x.id)).toEqual([...EXPERIMENT_IDS]);
		expect(new Set(EXPERIMENT_IDS).size).toBe(EXPERIMENT_IDS.length);
		for (const x of EXPERIMENTS) {
			expect(x.bands, x.id).toHaveLength(10);
			expect(x.labels, x.id).toHaveLength(10);
			expect(Object.isFrozen(x) && Object.isFrozen(x.bands) && Object.isFrozen(x.labels)).toBe(true);
			expect(getExperiment(x.id)).toBe(x);
		}
		expect(getExperiment('nope')).toBeNull();
	});

	test('every experiment is a curve the cable takes: S1 v1 round trip, preamp −25.5..0 dB', () => {
		for (const x of EXPERIMENTS) {
			const decoded = decodeS1(encodeS1({ bands: x.bands, preampDb: x.preampDb }));
			expect(decoded.bands, x.id).toEqual(x.bands);
			expect(decoded.preampDb, x.id).toBe(x.preampDb);
			expect(x.preampDb, x.id).toBeGreaterThanOrEqual(-25.5);
			expect(x.preampDb, x.id).toBeLessThanOrEqual(0);
		}
	});

	test('labels: a short role name on every active band, none on OFF, kept by normalizeLabels', () => {
		for (const x of EXPERIMENTS) {
			x.bands.forEach((band, index) => {
				const label = x.labels[index];
				if (band.kind === 'OFF') expect(label, `${x.id} ${index}`).toBeNull();
				else {
					expect(typeof label, `${x.id} ${index}`).toBe('string');
					expect([...(label ?? '')].length, `${x.id} ${index}`).toBeLessThanOrEqual(16);
				}
			});
			expect(normalizeLabels(x.labels), x.id).toEqual(x.labels);
		}
		expect(experiment('notch-60').labels.slice(0, 3)).toEqual(['Notch 60', 'Notch 120', 'Notch 180']);
		expect(experiment('subsonica').labels[0]).toBe('HP 30');
	});

	test('(i) every experiment passes at least the YOLO gate: no hard reason anywhere', () => {
		for (const x of EXPERIMENTS) {
			const { yolo } = gates(x);
			expect(yolo.ok, `${x.id}: ${JSON.stringify(yolo.reasons)}`).toBe(true);
			for (const code of HARD_REASONS) expect(codes(yolo), x.id).not.toContain(code);
			// Same verdict as the editor's own (memoized) status.
			expect(experimentStatus(x).yolo.ok, x.id).toBe(true);
		}
	});

	test('(ii) requiresYolo is computed: exactly "fails standard, passes YOLO"', () => {
		for (const x of EXPERIMENTS) {
			const { standard, yolo } = gates(x);
			expect(requiresYolo(x), x.id).toBe(!standard.ok && yolo.ok);
			expect(experimentStatus(x).standard.ok, x.id).toBe(standard.ok);
			if (requiresYolo(x)) {
				// Only class-2 (waivable) reasons stop it in the standard profile.
				expect(codes(standard).every((code) => isWaivable(code)), x.id).toBe(true);
				expect(yolo.waived?.length ?? 0, x.id).toBeGreaterThan(0);
			} else {
				expect(standard.ok, `${x.id}: ${JSON.stringify(standard.reasons)}`).toBe(true);
			}
		}
		// The engineering result, pinned: what needs YOLO and why.
		expect(EXPERIMENTS.filter(requiresYolo).map((x) => x.id)).toEqual(['ressonancia', 'subsonica']);
		for (const [id, code] of [
			['ressonancia', 'c:section-peak'],
			['subsonica', 'a:b2']
		] as const) {
			const { standard, yolo } = gates(experiment(id));
			expect(codes(standard), id).toEqual([code]);
			expect(yolo.waived, id).toEqual([code]);
		}
		// The status is computed once per experiment.
		const x = experiment('telefone');
		expect(experimentStatus(x)).toBe(experimentStatus(x));
	});

	test('the preamp is the highest 0.1 dB step the gate accepts, in the profile it needs', () => {
		for (const x of EXPERIMENTS) {
			const experimental = hasExperimental(x.bands);
			const best = requiresYolo(x)
				? autoPreamp(x.bands, { experimental, profile: 'yolo' })
				: autoPreamp(x.bands, { experimental });
			expect(x.preampDb, x.id).toBe(best);
		}
	});

	test('Volume baixo follows ISO 226:2003 (40 phon instead of 80) within 1 dB, 20 Hz–12.5 kHz', () => {
		const grid = ISO226_TABLE.map((row) => row.freqHz);
		const target = loudnessCompensationDb(80, 40, grid).compensationDb;
		const got = relative(experiment('volume-baixo'), grid);
		grid.forEach((freqHz, index) => {
			const error = Math.abs((got[index] ?? NaN) - (target[index] ?? NaN));
			expect(error, `${freqHz} Hz`).toBeLessThanOrEqual(1);
		});
	});

	test('each experiment does what its name says (response checks, preamp excluded)', () => {
		// Telefone: Butterworth 4th order, −3 dB at both edges, deep outside the band.
		const [t300, t3400, t100, t10k] = relative(experiment('telefone'), [300, 3400, 100, 10000]);
		expect(t300).toBeCloseTo(-3, 0);
		expect(t3400).toBeCloseTo(-3, 0);
		expect(t100).toBeLessThan(-30);
		expect(t10k).toBeLessThan(-30);
		// Solo: LR4 at 2 and 4 kHz (−6 dB at each edge), the rest far down.
		const [s2k, s4k, s500, s12k] = relative(experiment('solo'), [2000, 4000, 500, 12000], 2800);
		for (const edge of [s2k, s4k]) {
			expect(edge).toBeGreaterThan(-3.5);
			expect(edge).toBeLessThan(-1.5);
		}
		expect(responseAt(experiment('solo'), 2000)).toBeLessThan(-6);
		expect(s500).toBeLessThan(-40);
		expect(s12k).toBeLessThan(-30);
		// Notches: every harmonic at least 24 dB down.
		for (const [id, fundamental] of [
			['notch-60', 60],
			['notch-50', 50]
		] as const) {
			const harmonics = Array.from({ length: 10 }, (_, n) => fundamental * (n + 1));
			for (const db of relative(experiment(id), harmonics)) expect(db, id).toBeLessThan(-24);
		}
		// Parede: flat to 14 kHz, −3 dB at 16 kHz, a wall above.
		const [w14, w16, w20] = relative(experiment('parede-16k'), [14000, 16000, 20000]);
		expect(w14).toBeGreaterThan(-1);
		expect(w16).toBeCloseTo(-3, 0);
		expect(w20).toBeLessThan(-18);
		// Subsônica: Butterworth at 30 Hz.
		const [h30, h60, h15] = relative(experiment('subsonica'), [30, 60, 15]);
		expect(h30).toBeCloseTo(-3, 0);
		expect(h60).toBeGreaterThan(-0.5);
		expect(h15).toBeLessThan(-11);
		// Ressonância: a peak of more than 14 dB at the cutoff, then 24 dB/octave down.
		const [r1k, r4k] = relative(experiment('ressonancia'), [1000, 4000], 100);
		expect(r1k).toBeGreaterThan(14);
		expect(r4k).toBeLessThan(-40);
		// Vowels: formants well above the valleys.
		const [a800, a1200, a1900, a300] = relative(experiment('vogal-a'), [800, 1200, 1900, 300]);
		expect(Math.min(a800 ?? 0, a1200 ?? 0) - Math.max(a1900 ?? 0, a300 ?? 0)).toBeGreaterThan(8);
		const [i300, i2300, i1000] = relative(experiment('vogal-i'), [300, 2300, 1000]);
		expect(Math.min(i300 ?? 0, i2300 ?? 0) - (i1000 ?? 0)).toBeGreaterThan(10);
		// Rádio AM: 1.2 kHz on top, nothing much above the IF filter.
		const [am8k, am60] = relative(experiment('radio-am'), [8000, 60], 1200);
		expect(am8k).toBeLessThan(-20);
		expect(am60).toBeLessThan(-12);
		// Tilts: about 1 dB per octave, mirror images.
		const [dark] = relative(experiment('escuro'), [100], 10000);
		const [light] = relative(experiment('claro'), [100], 10000);
		expect(dark).toBeGreaterThan(5);
		expect(light).toBeCloseTo(-(dark ?? 0), 5);
	});

	test('HS, LP and HP need Engenharia; PK and LS work from Ajustar', () => {
		expect(EXPERIMENTS.filter(needsEngenharia).map((x) => x.id)).toEqual([
			'solo',
			'radio-am',
			'telefone',
			'vogal-a',
			'vogal-i',
			'ressonancia',
			'subsonica',
			'parede-16k'
		]);
		for (const x of EXPERIMENTS) {
			expect(lockedIn(x, 'ajustar'), x.id).toBe(needsEngenharia(x));
			expect(lockedIn(x, 'engenharia'), x.id).toBe(false);
		}
	});

	test('a press: Ouvir reads only, locked kinds need Engenharia, YOLO-only needs YOLO on', () => {
		for (const x of EXPERIMENTS) {
			expect(decideExperiment(x, { layer: 'ouvir', yoloOn: false }), x.id).toEqual({
				ok: false,
				reason: 'ouvir'
			});
			const ajustar = decideExperiment(x, { layer: 'ajustar', yoloOn: false });
			if (needsEngenharia(x)) expect(ajustar, x.id).toEqual({ ok: false, reason: 'engenharia' });
			else expect(ajustar.ok, x.id).toBe(true);
			const engenharia = decideExperiment(x, { layer: 'engenharia', yoloOn: false });
			if (requiresYolo(x)) expect(engenharia, x.id).toEqual({ ok: false, reason: 'yolo' });
			else expect(engenharia.ok, x.id).toBe(true);
			// With YOLO on, every experiment applies, judged by the YOLO profile.
			const yolo = decideExperiment(x, { layer: 'engenharia', yoloOn: true });
			expect(yolo.ok, x.id).toBe(true);
			if (yolo.ok) {
				expect(yolo.verdict.profile, x.id).toBe('yolo');
				expect(yolo.curve, x.id).toEqual({ bands: x.bands, preampDb: x.preampDb });
				expect(yolo.labels, x.id).toBe(x.labels);
			}
		}
		const tel = decideExperiment(experiment('telefone'), { layer: 'engenharia', yoloOn: false });
		expect(tel.ok && tel.labels.slice(0, 4)).toEqual([
			'HP 300 1/2',
			'HP 300 2/2',
			'LP 3400 1/2',
			'LP 3400 2/2'
		]);
	});

	test('a curve the gate refuses is never applied: the decision carries the verdict', () => {
		const loud: Experiment = { ...experiment('telefone'), preampDb: 0 };
		const decision = decideExperiment(loud, { layer: 'engenharia', yoloOn: false });
		expect(decision.ok).toBe(false);
		if (decision.ok || decision.reason !== 'gate') throw new Error('expected a gate refusal');
		expect(codes(decision.verdict)).toContain('g:preamp');
		// Not even YOLO takes it: the output would reach 0 dB.
		const yolo = decideExperiment(loud, { layer: 'engenharia', yoloOn: true });
		expect(yolo.ok).toBe(false);
		if (!yolo.ok && yolo.reason === 'gate') expect(codes(yolo.verdict)).toContain('e:output-audible');
	});
});
