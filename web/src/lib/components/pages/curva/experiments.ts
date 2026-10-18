/**
 * Experimentos: curated experimental curves for the Curva editor (pure data and rules, no UI).
 *
 * Every experiment is a whole curve within the cable's limits (10 bands, PK/LS/HS/LP/HP/OFF,
 * 96 kHz, gain −25.6..+12.7 dB, Q 0.01..20.47, 1..20000 Hz, preamp −25.5..0 dB, all on the S1 v1
 * grid) with short role labels for the filter bank. Its preamp is the highest 0.1 dB step the
 * gate accepts (the editor's "Máximo sem clipping"), in the profile the curve needs.
 *
 * Whether an experiment needs Modo YOLO is never written down: `experimentStatus` runs the core
 * write gate (`verdictFor`, i.e. `gateForWrite` on the full grid) in the standard and the YOLO
 * profiles, and `requiresYolo` is "fails standard, passes YOLO". The unit test pins that every
 * experiment passes at least the YOLO profile (no hard reason).
 *
 * Engineering notes (fs = 96 kHz; the hard limits come from the presets' coefficient envelope):
 * - A section's poles need `sin(w0)/(2·Q_pole) ≥ 0.00134` (`a:-a2`, hard), i.e. a pole
 *   bandwidth f/Q of at least ~41 Hz. That rules out a Butterworth HP at 15–20 Hz (Q 0.71 needs
 *   f ≥ 29 Hz) and narrow notches or boosts in the low bass.
 * - The feedforward word b2 (`a:b2`, waivable) is tighter: a Butterworth HP needs f ≥ ~41 Hz,
 *   and a −25.6 dB PK cut needs Q ≤ ~0.08·f.
 * - One boost section may peak at 9.2 dB (`c:section-peak`, waivable) with Q ≤ 4 (`d7:boost-q`).
 * - HS, LP and HP are experimental kinds: editable only in Engenharia.
 */
import { isExperimentalKind } from 'open-auri/safety';
import { isLockedKind, type Layer } from './layers.ts';
import { verdictFor, type Band, type Curve } from './model.ts';
import type { GateVerdict } from './reasons.ts';

export const EXPERIMENT_IDS = [
	'solo',
	'radio-am',
	'telefone',
	'notch-60',
	'notch-50',
	'vogal-a',
	'vogal-i',
	'ressonancia',
	'volume-baixo',
	'subsonica',
	'parede-16k',
	'escuro',
	'claro'
] as const;
export type ExperimentId = (typeof EXPERIMENT_IDS)[number];

export interface Experiment {
	readonly id: ExperimentId;
	/** Exactly ten bands in wire order (the active ones first, then OFF). */
	readonly bands: readonly Band[];
	readonly preampDb: number;
	/** Ten filter labels by wire index (`open-auri/preset@2` labels; null on OFF). */
	readonly labels: readonly (string | null)[];
}

const BAND_COUNT = 10;
const OFF: Band = Object.freeze({ kind: 'OFF' });

type Stage = readonly [band: Band, label: string];

const pk = (freqHz: number, gainDb: number, qFactor: number): Band => ({
	kind: 'PK',
	freqHz,
	gainDb,
	qFactor
});
const ls = (freqHz: number, gainDb: number, qFactor: number): Band => ({
	kind: 'LS',
	freqHz,
	gainDb,
	qFactor
});
const lp = (freqHz: number, qFactor: number): Band => ({ kind: 'LP', freqHz, qFactor });
const hp = (freqHz: number, qFactor: number): Band => ({ kind: 'HP', freqHz, qFactor });

/** Q on the 0.01 grid, at most the S1 maximum. */
const q = (value: number) => Math.min(20.47, Math.round(value * 100) / 100);

function define(id: ExperimentId, preampDb: number, stages: readonly Stage[]): Experiment {
	if (stages.length > BAND_COUNT) throw new RangeError(`${id}: more than ${BAND_COUNT} bands`);
	const pad = BAND_COUNT - stages.length;
	return Object.freeze({
		id,
		preampDb,
		bands: Object.freeze([
			...stages.map(([band]) => Object.freeze({ ...band })),
			...Array.from({ length: pad }, () => OFF)
		]),
		labels: Object.freeze([
			...stages.map(([, label]) => label),
			...Array.from({ length: pad }, () => null)
		])
	});
}

/**
 * Hum comb: a −25.6 dB PK cut on the fundamental and each harmonic. Q grows with the harmonic
 * (Q_n = n·Q_1, capped at 20.47) so every notch keeps the same width in Hz. Q_1 sits just under
 * the b2 limit of the fundamental, the narrowest notch the standard profile accepts there.
 */
function comb(id: ExperimentId, fundamentalHz: number, q1: number): Experiment {
	const stages = Array.from({ length: BAND_COUNT }, (_, index): Stage => {
		const freqHz = fundamentalHz * (index + 1);
		return [pk(freqHz, -25.6, q(q1 * (index + 1))), `Notch ${freqHz}`];
	});
	return define(id, -0.5, stages);
}

/** Four LS shelves two octaves apart (125 Hz to 8 kHz, Q 0.5): a tilt of about 1 dB/octave. */
function tilt(id: ExperimentId, stepDb: number, preampDb: number): Experiment {
	return define(
		id,
		preampDb,
		[125, 500, 2000, 8000].map((freqHz): Stage => {
			const name = freqHz >= 1000 ? `${freqHz / 1000}k` : String(freqHz);
			return [ls(freqHz, stepDb, 0.5), `Tilt ${name}`];
		})
	);
}

export const EXPERIMENTS: readonly Experiment[] = Object.freeze([
	// 2–4 kHz band: Linkwitz-Riley 4th order on both edges (two Butterworth Q 0.71 each).
	define('solo', -0.5, [
		[hp(2000, 0.71), 'HP 2k 1/2'],
		[hp(2000, 0.71), 'HP 2k 2/2'],
		[lp(4000, 0.71), 'LP 4k 1/2'],
		[lp(4000, 0.71), 'LP 4k 2/2']
	]),
	// AM receiver: small speaker (HP 150 Hz), steep IF filter (Butterworth 4th order at 4.5 kHz)
	// and the cabinet's midrange honk.
	define('radio-am', -4.5, [
		[hp(150, 0.71), 'HP 150'],
		[lp(4500, 0.54), 'LP 4500 1/2'],
		[lp(4500, 1.31), 'LP 4500 2/2'],
		[pk(1200, 4, 1), 'Mid 1200']
	]),
	// Telephone channel 300–3400 Hz: Butterworth 4th order on both edges (Q 0.54 and 1.31).
	define('telefone', -0.5, [
		[hp(300, 0.54), 'HP 300 1/2'],
		[hp(300, 1.31), 'HP 300 2/2'],
		[lp(3400, 0.54), 'LP 3400 1/2'],
		[lp(3400, 1.31), 'LP 3400 2/2']
	]),
	comb('notch-60', 60, 4.7),
	comb('notch-50', 50, 3.9),
	// /a/: formants F1 800, F2 1200, F3 2600 Hz (+9/+9/+6 dB, Q 4), a dip between F2 and F3, and
	// the band limited to 300 Hz–3.8 kHz. Cuts come first so no prefix overshoots.
	define('vogal-a', -10.1, [
		[hp(300, 0.71), 'HP 300'],
		[lp(3800, 0.71), 'LP 3800 1/2'],
		[lp(3800, 0.71), 'LP 3800 2/2'],
		[pk(1900, -8, 3), 'Dip 1900'],
		[pk(800, 9, 4), 'F1 800'],
		[pk(1200, 9, 4), 'F2 1200'],
		[pk(2600, 6, 4), 'F3 2600']
	]),
	// /i/: F1 300 Hz far from F2 2300 / F3 3000 Hz, with a wide dip around 1 kHz between them.
	define('vogal-i', -8, [
		[hp(200, 0.71), 'HP 200'],
		[lp(4500, 0.71), 'LP 4500 1/2'],
		[lp(4500, 0.71), 'LP 4500 2/2'],
		[pk(1000, -12, 1.2), 'Dip 1000'],
		[pk(300, 8, 3), 'F1 300'],
		[pk(2300, 9, 4), 'F2 2300'],
		[pk(3000, 7, 4), 'F3 3000']
	]),
	// Synth filter: 24 dB/oct low pass at 1 kHz whose second section resonates (Q 8, +18 dB alone).
	define('ressonancia', -15.7, [
		[lp(1000, 0.71), 'LP 1k'],
		[lp(1000, 8), 'Res 1k Q8']
	]),
	// ISO 226:2003, listening at 40 phon instead of 80: three LS shelves for the bass, a small
	// presence dip and an air lift (fit checked against loudnessCompensationDb in the test).
	define('volume-baixo', -22.1, [
		[pk(3150, -1.5, 0.7), 'Dip 3150'],
		[ls(30, 6, 0.5), 'Loudness 30'],
		[ls(80, 9, 0.5), 'Loudness 80'],
		[ls(300, 9, 0.5), 'Loudness 300'],
		[pk(12500, 7, 2), 'Loudness 12500']
	]),
	// Subsonic HP: Butterworth at 30 Hz, the lowest corner the hard pole limit accepts at Q 0.71.
	define('subsonica', -0.5, [[hp(30, 0.71), 'HP 30']]),
	// 16 kHz wall: Butterworth 8th order (Q 0.51, 0.60, 0.90, 2.56), 48 dB/octave.
	define('parede-16k', -0.5, [
		[lp(16000, 0.51), 'LP 16k 1/4'],
		[lp(16000, 0.6), 'LP 16k 2/4'],
		[lp(16000, 0.9), 'LP 16k 3/4'],
		[lp(16000, 2.56), 'LP 16k 4/4']
	]),
	tilt('escuro', 2, -8.5),
	tilt('claro', -2, -0.5)
]);

const BY_ID: ReadonlyMap<string, Experiment> = new Map(EXPERIMENTS.map((x) => [x.id, x]));

export function getExperiment(id: string): Experiment | null {
	return BY_ID.get(id) ?? null;
}

export function experimentCurve(experiment: Experiment): Curve {
	return { bands: experiment.bands, preampDb: experiment.preampDb };
}

/** Uses HS, LP or HP (experimental kinds): editable only in Engenharia. */
export function needsEngenharia(experiment: Experiment): boolean {
	return experiment.bands.some((band) => isExperimentalKind(band.kind));
}

/** Whether `layer` cannot edit some kind the experiment uses (HS/LP/HP outside Engenharia). */
export function lockedIn(experiment: Experiment, layer: Layer): boolean {
	return experiment.bands.some((band) => band.kind !== 'OFF' && isLockedKind(band.kind, layer));
}

export interface ExperimentStatus {
	/** The write gate in the standard profile (full grid). */
	readonly standard: GateVerdict;
	/** The write gate in the YOLO profile (full grid). */
	readonly yolo: GateVerdict;
	/** Fails the standard profile and passes the YOLO one. */
	readonly requiresYolo: boolean;
}

const statuses = new Map<ExperimentId, ExperimentStatus>();

/** Both gate verdicts of `experiment`, computed once per page (the data never changes). */
export function experimentStatus(experiment: Experiment): ExperimentStatus {
	const known = statuses.get(experiment.id);
	if (known && BY_ID.get(experiment.id) === experiment) return known;
	const curve = experimentCurve(experiment);
	const standard = verdictFor(curve, 'standard');
	const yolo = verdictFor(curve, 'yolo');
	const status: ExperimentStatus = Object.freeze({
		standard,
		yolo,
		requiresYolo: !standard.ok && yolo.ok
	});
	if (BY_ID.get(experiment.id) === experiment) statuses.set(experiment.id, status);
	return status;
}

/** Computed, never hand-set: fails the standard gate, passes the YOLO gate. */
export function requiresYolo(experiment: Experiment): boolean {
	return experimentStatus(experiment).requiresYolo;
}

export type ExperimentDecision =
	| {
			readonly ok: true;
			readonly curve: Curve;
			readonly labels: readonly (string | null)[];
			readonly verdict: GateVerdict;
	  }
	| { readonly ok: false; readonly reason: 'ouvir' | 'engenharia' | 'yolo' }
	| { readonly ok: false; readonly reason: 'gate'; readonly verdict: GateVerdict };

/**
 * What a press on `experiment` does in `layer` with Modo YOLO `yoloOn`:
 * - Ouvir is read-only; kinds locked outside Engenharia need Engenharia;
 * - a YOLO-only experiment while YOLO is off is never applied;
 * - otherwise the editor's own gate decides (the profile the editor runs in), like every other
 *   change of the curve; a refusal keeps the curve and carries the verdict.
 */
export function decideExperiment(
	experiment: Experiment,
	{ layer, yoloOn }: { layer: Layer; yoloOn: boolean }
): ExperimentDecision {
	if (layer === 'ouvir') return { ok: false, reason: 'ouvir' };
	if (lockedIn(experiment, layer)) return { ok: false, reason: 'engenharia' };
	if (!yoloOn && requiresYolo(experiment)) return { ok: false, reason: 'yolo' };
	const curve = experimentCurve(experiment);
	const verdict = verdictFor(curve, yoloOn ? 'yolo' : 'standard');
	if (!verdict.ok) return { ok: false, reason: 'gate', verdict };
	return { ok: true, curve, labels: experiment.labels, verdict };
}
