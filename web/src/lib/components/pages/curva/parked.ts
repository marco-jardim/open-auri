/**
 * Neutro's empty state (spec §4.4): with every section OFF, the scope shows ten points parked at
 * 0 dB, one per section. Grabbing one (pointer or keys) creates a PK filter there, through the gate
 * like any other edit. The parked points are a starting place, never data.
 *
 * The points sit inside the PK safe box (core SOFT_RANGES 'PK-main': 150 Hz to 20 kHz, Q 1 to 2),
 * spaced on preferred numbers about two thirds of an octave apart and kept below 16 kHz (no PK
 * boost above it). Lower frequencies would ask the chip for coefficients beyond what the official
 * presets use (gate criterion (a)), so the bass is reached by dragging, as LS, or from a preset.
 */
import { bandOfKind } from './edit.ts';
import type { Band } from './model.ts';

export const PARKED_HZ: readonly number[] = [
	150, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000
];

/** True when the curve has no active section (the parked points are shown). */
export function isEmptyCurve(bands: readonly Band[]): boolean {
	return bands.every((band) => band.kind === 'OFF');
}

/** The flat PK band a parked point stands for: 0 dB at its frequency, the PK safe-box Q. */
export function parkedBand(index: number): Band {
	const base = bandOfKind({ kind: 'OFF' }, 'PK');
	const freqHz = PARKED_HZ[index] ?? 1000;
	if (base.kind !== 'PK') return base;
	return { ...base, freqHz, gainDb: 0 };
}
