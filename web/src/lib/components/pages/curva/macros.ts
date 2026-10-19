/**
 * N1 macros (Ouvir): Grave, Corpo, Presença, Brilho.
 *
 * Mapping (documented for T2.10; values in dB, knob range −6…+6, step 0.1):
 * - each macro owns one frequency region: Grave < 250 Hz, Corpo 250 Hz…1 kHz,
 *   Presença 1…6 kHz, Brilho ≥ 6 kHz;
 * - the knob adds its value to the gain of every PK or LS band of the base curve whose frequency
 *   lies in the region (HS/LP/HP and OFF are never touched), rounded to 0.1 dB and clamped to the
 *   absolute gain range (−24…+9.2 dB);
 * - D7 is respected up front: a band whose Q is above the boost limit, or a PK above 16 kHz, can
 *   only be cut (its gain is capped at 0 dB);
 * - when the region has no PK/LS band, the first free OFF slot becomes a new section:
 *   Grave LS 120 Hz Q 0.6, Corpo PK 500 Hz Q 1, Presença PK 3 kHz Q 1.4, Brilho PK 9 kHz Q 1.4;
 * - the preamp is never raised: it is the lower of the base preamp and the core `autoPreamp`;
 * - every candidate is judged by the core gate. A refused target is bisected back toward the last
 *   accepted value (core `boundarySearch`), snapped to the 0.1 dB grid toward the start and
 *   revalidated with `gateForWrite`, so a macro can never produce a curve the gate refuses;
 * - the gate is the editor's profile (`MacroInput.profile`: `'yolo'` while Modo YOLO is on, as
 *   for the dial and the drags). In YOLO the preamp still never goes below −25,5 dB
 *   (`EDITOR_PREAMP_FLOOR_DB`): a value that would need more attenuation is refused.
 */
import { ABS_RANGES, autoPreamp, boundarySearch } from 'open-auri/safety';
import { editorVerdict, EDITOR_PREAMP_FLOOR_DB, type EditJudge } from './edit.ts';
import type { Band, Curve } from './model.ts';
import { hasExperimental } from './model.ts';
import type { GateVerdict, Reason } from './reasons.ts';

export type MacroId = 'bass' | 'body' | 'presence' | 'air';
export type MacroValues = readonly [number, number, number, number];

export interface MacroDefinition {
	readonly id: MacroId;
	/** Inclusive lower bound and exclusive upper bound in Hz. */
	readonly region: readonly [number, number];
	readonly make: Readonly<{ kind: 'PK' | 'LS'; freqHz: number; qFactor: number }>;
}

export const MACRO_MIN_DB = -6;
export const MACRO_MAX_DB = 6;
export const MACRO_STEP_DB = 0.1;
export const ZERO_MACROS: MacroValues = [0, 0, 0, 0];

export const MACROS: readonly MacroDefinition[] = [
	{ id: 'bass', region: [0, 250], make: { kind: 'LS', freqHz: 120, qFactor: 0.6 } },
	{ id: 'body', region: [250, 1000], make: { kind: 'PK', freqHz: 500, qFactor: 1 } },
	{ id: 'presence', region: [1000, 6000], make: { kind: 'PK', freqHz: 3000, qFactor: 1.4 } },
	{
		id: 'air',
		region: [6000, Number.POSITIVE_INFINITY],
		make: { kind: 'PK', freqHz: 9000, qFactor: 1.4 }
	}
];

const round1 = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function regionOf(freqHz: number): number {
	return MACROS.findIndex(({ region }) => freqHz >= region[0] && freqHz < region[1]);
}

/** Bands a macro moves: PK and LS only, inside its region. */
export function macroTargets(base: readonly Band[], index: number): number[] {
	const targets: number[] = [];
	base.forEach((band, i) => {
		if ((band.kind === 'PK' || band.kind === 'LS') && regionOf(band.freqHz) === index) {
			targets.push(i);
		}
	});
	return targets;
}

export type MacroScope = { type: 'sections'; count: number } | { type: 'free' } | { type: 'none' };

export function macroScope(base: readonly Band[], index: number): MacroScope {
	const count = macroTargets(base, index).length;
	if (count > 0) return { type: 'sections', count };
	return base.some((band) => band.kind === 'OFF') ? { type: 'free' } : { type: 'none' };
}

function boostAllowed(band: { kind: string; freqHz: number; qFactor: number }): boolean {
	if (band.qFactor > ABS_RANGES.boostQMax) return false;
	return !(band.kind === 'PK' && band.freqHz > ABS_RANGES.pkBoostMaxHz);
}

/** Pure mapping from macro values to bands (no gate here; see `proposeMacro`). */
export function applyMacros(base: readonly Band[], values: MacroValues): Band[] {
	const out = base.slice();
	const used = new Set<number>();
	values.forEach((value, k) => {
		const macro = MACROS[k];
		if (!macro || Math.abs(value) < 1e-9) return;
		const targets = macroTargets(base, k);
		if (targets.length > 0) {
			for (const i of targets) {
				const band = base[i];
				if (!band || (band.kind !== 'PK' && band.kind !== 'LS')) continue;
				const { min, max } = ABS_RANGES.gainDb;
				let gainDb = clamp(round1(band.gainDb + value), min, max);
				if (gainDb > 0 && !boostAllowed(band)) gainDb = Math.min(gainDb, 0);
				out[i] = { ...band, gainDb };
			}
			return;
		}
		const slot = base.findIndex((band, i) => band.kind === 'OFF' && !used.has(i));
		if (slot < 0) return;
		used.add(slot);
		out[slot] = { ...macro.make, gainDb: round1(value) };
	});
	return out;
}

export interface MacroProposal {
	/** True when the returned curve differs from the start and passed `gateForWrite`. */
	ok: boolean;
	/** The macro value actually applied (the target, or where the gate stopped it). */
	value: number;
	bands: Band[];
	preampDb: number;
	/** The target was refused; `reasons` explains why in gate codes. */
	stopped: boolean;
	reasons: Reason[];
	verdict: GateVerdict | null;
}

export interface MacroInput {
	base: readonly Band[];
	basePreampDb: number;
	values: MacroValues;
	index: number;
	target: number;
	/**
	 * The editor's judge (`'codec'` during "Prévia sem limites"); standard when omitted, so a
	 * missing profile is never laxer.
	 */
	profile?: EditJudge;
}

export function clampMacro(value: number): number {
	return clamp(round1(value), MACRO_MIN_DB, MACRO_MAX_DB);
}

/** Candidate curve for one macro value: the preamp only ever goes down. */
export function macroCandidate(
	input: MacroInput,
	value: number
): { bands: Band[]; preampDb: number; accepted: boolean } {
	const pick = (k: number): number => (k === input.index ? value : (input.values[k] ?? 0));
	const values: MacroValues = [pick(0), pick(1), pick(2), pick(3)];
	const bands = applyMacros(input.base, values);
	const experimental = hasExperimental(bands);
	const yoloGate = input.profile === 'yolo' || input.profile === 'codec';
	const auto = autoPreamp(bands, yoloGate ? { experimental, profile: 'yolo' } : { experimental });
	if (auto === null) {
		// The free preview judges with the codec alone: no preamp from the YOLO search (its hard
		// limits) means none is lowered, and `editorVerdict(…, 'codec')` decides.
		const preampDb = input.basePreampDb;
		const accepted = input.profile === 'codec' && preampDb >= EDITOR_PREAMP_FLOOR_DB;
		return { bands, preampDb, accepted };
	}
	const preampDb = Math.min(input.basePreampDb, auto);
	// YOLO's own floor is the codec's; the editor stops at −25,5 dB (S1) in every profile.
	return { bands, preampDb, accepted: preampDb >= EDITOR_PREAMP_FLOOR_DB };
}

/** Moves one macro toward `target`, stopping at the gate boundary. Always gate-valid when ok. */
export function proposeMacro(input: MacroInput): MacroProposal {
	const start = input.values[input.index] ?? 0;
	const target = clampMacro(input.target);
	// `editorVerdict` sets the experimental flag from the candidate's own kinds (a macro never
	// adds an experimental kind, so this is the base's flag too), plus the YOLO preamp floor.
	const check = (curve: Curve) => editorVerdict(curve, input.profile ?? 'standard');
	const at = (value: number) => macroCandidate(input, value);
	const unchanged = (reasons: Reason[], stopped: boolean): MacroProposal => ({
		ok: false,
		value: start,
		bands: input.base.slice(),
		preampDb: input.basePreampDb,
		stopped,
		reasons,
		verdict: null
	});
	if (target === start) return unchanged([], false);
	const first = at(target);
	const firstVerdict = first.accepted ? check(first) : null;
	if (firstVerdict?.ok) {
		return {
			ok: true,
			value: target,
			bands: first.bands,
			preampDb: first.preampDb,
			stopped: false,
			reasons: [],
			verdict: firstVerdict
		};
	}
	const refusedReasons = (firstVerdict ?? check(first)).reasons;
	const begin = at(start);
	if (!begin.accepted) return unchanged(refusedReasons, true);
	const boundary = boundarySearch(start, target, (value: number) => at(value).accepted, {
		iterations: 10
	});
	const direction = Math.sign(target - start);
	let steps = Math.floor(Math.abs(boundary - start) / MACRO_STEP_DB + 1e-9);
	while (steps > 0) {
		const value = round1(start + direction * steps * MACRO_STEP_DB);
		const candidate = at(value);
		if (candidate.accepted) {
			const verdict = check(candidate);
			if (verdict.ok) {
				return {
					ok: true,
					value,
					bands: candidate.bands,
					preampDb: candidate.preampDb,
					stopped: true,
					reasons: refusedReasons,
					verdict
				};
			}
		}
		steps -= 1;
	}
	return unchanged(refusedReasons, true);
}
