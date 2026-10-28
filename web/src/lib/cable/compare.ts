/**
 * Level-matched, pre-approved comparison set for the live cable preview (issues #73/#74, plan
 * `docs/plans/2026-10-28-x2-e-teste-cego-no-cabo-plano.md`, slice 1). Pure: no I/O, no clock.
 *
 * Every candidate is gated as given (`gateForWrite`, the same gate the service and the
 * transport run). With `match`, the louder candidates get their preamp lowered (floored to the
 * 0.1 dB grid) so each one plays at the level of the quietest (`levelDb`, the checklist's
 * metric, with the quantised preamp): a candidate is never made louder, and a candidate whose
 * lowered preamp would fall below the standard floor (−25.5 dB) refuses the whole set (the
 * quiet one is never boosted instead). Each adjusted curve is gated again. The confirmed level
 * of the set (`ackLevelDb`) is the highest level among the curves that will be played, so no
 * switch can be ≥ 3 dB above it.
 *
 * MVP: standard profile only. The originals are kept untouched ("Salvar esta" saves them).
 */
import { THRESHOLDS, gateForWrite } from 'open-auri/safety';
import { hasExperimentalKinds, hasUltrasonicBands, writtenLevelDb } from './checklist.ts';
import type {
	Band,
	ComparisonCurve,
	ComparisonItem,
	ComparisonOptions,
	ComparisonPlan,
	ComparisonRefusal,
	GateResult
} from './types.ts';

/** Fewest candidates a comparison needs. */
export const COMPARISON_MIN_CURVES = 2;

/** Grid of the matched preamp (dB). */
export const COMPARISON_PREAMP_STEP_DB = 0.1;

/**
 * `x` floored to the 0.1 dB grid. Differences below 0.1 mdB are ignored first: the Q23 preamp
 * quantisation makes level deltas off by up to ~10 µdB, which must not cost a whole 0.1 dB step
 * (−12.000002 floors to −12.0, not −12.1).
 */
function floorTenth(x: number): number {
	const tenthMilli = Math.round(x * 1e4);
	return Math.floor(tenthMilli / 1e3) / 10;
}

function experimentalOf(snapshot: readonly Readonly<Band>[]): boolean {
	try {
		return hasExperimentalKinds(snapshot) || hasUltrasonicBands(snapshot);
	} catch {
		// Unreadable bands: be conservative (the gate refuses them anyway).
		return true;
	}
}

function copyBands(bands: readonly Readonly<Band>[]): Band[] {
	return bands.map((band): Band => ({ ...band }));
}

function refused(
	refusal: ComparisonRefusal,
	experimental: boolean,
	match: boolean
): ComparisonPlan {
	return {
		items: [],
		ackLevelDb: null,
		targetLevelDb: null,
		match,
		experimental,
		experimentalRequired: false,
		profile: 'standard',
		refusal
	};
}

interface Gated {
	verdict: GateResult;
	snapshot: readonly Readonly<Band>[];
	preampDb: number;
	crc: number;
	levelDb: number;
}

/** Gates one curve; null with the verdict when it fails, or its level is unknown. */
function gateOne(
	bands: readonly Band[],
	preampDb: number,
	experimental: boolean
): { ok: true; gated: Gated } | { ok: false; verdict: GateResult; level: boolean } {
	const verdict = gateForWrite(bands, preampDb, { experimental });
	const snapshot = verdict.metrics.bands;
	const crc = verdict.metrics.payloadCrc === undefined ? null : Number(verdict.metrics.payloadCrc);
	if (!verdict.ok || snapshot === undefined || crc === null || !Number.isInteger(crc)) {
		return { ok: false, verdict, level: false };
	}
	const levelDb = writtenLevelDb({ bands: copyBands(snapshot), preampDb });
	if (levelDb === null) return { ok: false, verdict, level: true };
	return { ok: true, gated: { verdict, snapshot, preampDb, crc, levelDb } };
}

/**
 * Plans a comparison of `curves` (read once). Any refusal rejects the whole set: `items` is
 * then empty and `refusal` names the curve index and why.
 */
export function planComparison(
	curves: readonly ComparisonCurve[],
	options: ComparisonOptions
): ComparisonPlan {
	const match = options.match === true;
	// Read once: the list and each curve's fields.
	const list: ComparisonCurve[] = [];
	if (Array.isArray(curves)) {
		const length = curves.length;
		for (let index = 0; index < length; index++) {
			const curve = curves[index] as ComparisonCurve;
			list.push({
				bands: curve.bands,
				preampDb: curve.preampDb,
				experimental: curve.experimental === true,
				...(curve.profile === undefined ? {} : { profile: curve.profile })
			});
		}
	}
	// The gate option of every apply: the session's (one for the whole set).
	const experimental =
		options.experimental === true || list.some((curve) => curve.experimental === true);
	if (list.length < COMPARISON_MIN_CURVES) {
		return refused({ reason: 'too-few' }, experimental, match);
	}
	const profile: unknown = options.profile;
	if (profile === 'yolo') return refused({ reason: 'yolo-unsupported' }, experimental, match);
	const yoloCurve = list.findIndex((curve) => (curve.profile as unknown) === 'yolo');
	if (yoloCurve >= 0) {
		return refused({ reason: 'yolo-unsupported', index: yoloCurve }, experimental, match);
	}

	// 1. Each candidate as given.
	const originals: Gated[] = [];
	for (let index = 0; index < list.length; index++) {
		const curve = list[index] as ComparisonCurve;
		const result = gateOne(curve.bands, curve.preampDb, experimental);
		if (!result.ok) {
			if (result.level) return refused({ reason: 'level-unknown', index }, experimental, match);
			// A curve only the Modo YOLO gate accepts: not in the MVP.
			const yolo = gateForWrite(curve.bands, curve.preampDb, {
				experimental,
				profile: 'yolo'
			});
			if (yolo.ok) {
				return refused({ reason: 'yolo-unsupported', index }, experimental, match);
			}
			return refused(
				{ reason: 'gate', index, gateReasons: [...result.verdict.reasons] },
				experimental,
				match
			);
		}
		originals.push(result.gated);
	}

	// 2. Level matching: lower the louder ones to the quietest level (never boost).
	const target = Math.min(...originals.map((gated) => gated.levelDb));
	const items: ComparisonItem[] = [];
	for (let index = 0; index < originals.length; index++) {
		const original = originals[index] as Gated;
		let played = original;
		let matched = false;
		const deltaDb = original.levelDb - target;
		if (match && deltaDb > 0) {
			const preampDb = Math.min(original.preampDb, floorTenth(original.preampDb - deltaDb));
			if (preampDb !== original.preampDb) {
				if (!(preampDb >= THRESHOLDS.preampMinDb)) {
					return refused({ reason: 'level-range', index, preampDb }, experimental, match);
				}
				const again = gateOne(copyBands(original.snapshot), preampDb, experimental);
				if (!again.ok) {
					return refused(
						again.level
							? { reason: 'level-unknown', index, matched: true }
							: {
									reason: 'gate',
									index,
									matched: true,
									gateReasons: [...again.verdict.reasons]
								},
						experimental,
						match
					);
				}
				played = again.gated;
				matched = true;
			}
		}
		items.push({
			index,
			bands: copyBands(played.snapshot),
			preampDb: played.preampDb,
			crc: played.crc,
			levelDb: played.levelDb,
			residualDb: played.levelDb - target,
			matched,
			experimentalRequired: experimentalOf(played.snapshot),
			verdict: played.verdict,
			original: {
				bands: copyBands(original.snapshot),
				preampDb: original.preampDb,
				crc: original.crc,
				levelDb: original.levelDb
			}
		});
	}
	const ackLevelDb = Math.max(...items.map((item) => item.levelDb));
	return {
		items,
		ackLevelDb,
		targetLevelDb: target,
		match,
		experimental,
		experimentalRequired: items.some((item) => item.experimentalRequired),
		profile: 'standard'
	};
}
