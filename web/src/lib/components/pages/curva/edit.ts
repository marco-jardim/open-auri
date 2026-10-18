/**
 * Discrete edits validated by the core gate on the full grid: reordering sections (patch cables in
 * Engenharia) and changing a section's kind. A refusal leaves the curve untouched and returns the
 * reasons, so the UI snaps the module back and explains why. A reorder moves the filter labels
 * with their bands (`movePermutation`, `defaultPermutation`, `permuteLabels`); a kind change
 * keeps the slot's label.
 *
 * Every edit takes the editor's gate profile (`'yolo'` while Modo YOLO is on, else standard), so
 * the discrete edits judge a curve exactly as the dial and the drags do. In YOLO the preamp still
 * never goes below −25,5 dB (`EDITOR_PREAMP_FLOOR_DB`, the S1 floor): a curve that would need
 * more attenuation is refused with the `g:preamp` reason, so a YOLO curve always stays storable.
 */
import { autoPreamp, clampToAbs, roundToGrid, SOFT_RANGES, THRESHOLDS } from 'open-auri/safety';
import { hasExperimental, hasGain, replaceBand, verdictFor } from './model.ts';
import type { Band, BandKind, Curve } from './model.ts';
import type { GateVerdict, Reason } from './reasons.ts';

export type EditResult =
	{ ok: true; bands: Band[]; verdict: GateVerdict } | { ok: false; reasons: Reason[] };

export type PreampResult =
	| { ok: true; preampDb: number; changed: boolean; verdict: GateVerdict }
	| { ok: false; reasons: Reason[] };

/** Gate profile of an editor edit: `'yolo'` only while Modo YOLO is on in this tab. */
export type EditProfile = 'standard' | 'yolo';

/**
 * Lowest editor preamp in every profile, YOLO included (operator decision): −25,5 dB, the floor S1
 * and S5 encode. The YOLO gate waives `g:preamp` (its own floor is the codec's, about −144 dB);
 * the editor does not, so a YOLO curve can always be stored and restored.
 */
export const EDITOR_PREAMP_FLOOR_DB = THRESHOLDS.preampMinDb;

/**
 * Highest manual preamp of `profile`: the gate's −0,5 dB in the standard profile; in YOLO, where
 * `g:preamp` is waived, 0 dB (the S1, S5 and codec ceiling). The gate still judges every value.
 */
export function editorPreampMaxDb(profile: EditProfile = 'standard'): number {
	return profile === 'yolo' ? 0 : THRESHOLDS.preampMaxDb;
}

/** The YOLO refusal of a preamp under the editor floor, or null. */
function floorReason(preampDb: number, profile: EditProfile): Reason | null {
	return profile === 'yolo' && !(preampDb >= EDITOR_PREAMP_FLOOR_DB)
		? { code: 'g:preamp', value: preampDb, limit: EDITOR_PREAMP_FLOOR_DB }
		: null;
}

/**
 * The write gate's full-grid verdict in `profile` (`verdictFor`), plus the editor's −25,5 dB
 * preamp floor in YOLO: the verdict every discrete edit of the editor uses.
 */
export function editorVerdict(curve: Curve, profile: EditProfile = 'standard'): GateVerdict {
	const verdict = verdictFor(curve, profile);
	const floor = floorReason(curve.preampDb, profile);
	return floor === null ? verdict : { ...verdict, ok: false, reasons: [...verdict.reasons, floor] };
}

/**
 * "Máximo sem clipping": the highest preamp on the 0.1 dB grid that the full gate of `profile`
 * accepts for these bands (core `autoPreamp`), verified again with the write gate. The bands are
 * never touched. When no preamp can fix the curve (kinds, D7, coefficients…), the curve's own
 * reasons explain why; in YOLO, a curve that needs a preamp below −25,5 dB is refused with the
 * `g:preamp` reason.
 */
export function maxPreamp(curve: Curve, profile: EditProfile = 'standard'): PreampResult {
	const experimental = hasExperimental(curve.bands);
	const preampDb = autoPreamp(
		curve.bands,
		profile === 'yolo' ? { experimental, profile: 'yolo' } : { experimental }
	);
	const verdict =
		preampDb === null
			? verdictFor(curve, profile)
			: editorVerdict({ bands: curve.bands, preampDb }, profile);
	if (preampDb === null || !verdict.ok) return { ok: false, reasons: verdict.reasons };
	return { ok: true, preampDb, changed: preampDb !== curve.preampDb, verdict };
}

/** Section `from` moves to position `to`; the others keep their relative order. */
export function moveSection<T>(bands: readonly T[], from: number, to: number): T[] {
	const out = bands.slice();
	if (from === to || from < 0 || to < 0 || from >= out.length || to >= out.length) return out;
	const [moved] = out.splice(from, 1);
	if (moved !== undefined) out.splice(to, 0, moved);
	return out;
}

/**
 * The reorder permutation of `moveSection` over `length` slots: entry i is the old wire index of
 * the section that lands at index i (identity when out of range).
 */
export function movePermutation(length: number, from: number, to: number): number[] {
	return moveSection(
		Array.from({ length }, (_, index) => index),
		from,
		to
	);
}

/**
 * Filter labels follow their bands through a reorder: entry i of the result is
 * `labels[order[i]]`. No labels stay no labels.
 */
export function permuteLabels(
	labels: readonly (string | null)[] | null | undefined,
	order: readonly number[]
): (string | null)[] | null {
	if (!labels) return null;
	return order.map((index) => labels[index] ?? null);
}

export function reorderSections(
	curve: Curve,
	from: number,
	to: number,
	profile: EditProfile = 'standard'
): EditResult {
	const bands = moveSection(curve.bands, from, to);
	const verdict = editorVerdict({ bands, preampDb: curve.preampDb }, profile);
	return verdict.ok ? { ok: true, bands, verdict } : { ok: false, reasons: verdict.reasons };
}

/** Bands in the core default order (D1) with their old wire index. */
function defaultEntries(bands: readonly Band[]): { band: Band; index: number }[] {
	const rank = (band: Band) => {
		if (band.kind === 'OFF') return 2;
		return hasGain(band) && band.gainDb > 0 ? 1 : 0;
	};
	return bands
		.map((band, index) => ({ band, index }))
		.sort((a, b) => rank(a.band) - rank(b.band) || a.index - b.index);
}

/** The core default order (D1): cuts before boosts, OFF last; stable within each group. */
export function defaultOrder(bands: readonly Band[]): Band[] {
	return defaultEntries(bands).map(({ band }) => band);
}

/** The permutation `defaultOrder` applies: entry i is the old wire index now at index i. */
export function defaultPermutation(bands: readonly Band[]): number[] {
	return defaultEntries(bands).map(({ index }) => index);
}

const SOFT_BY_KIND = {
	PK: SOFT_RANGES['PK-main'],
	LS: SOFT_RANGES.LS,
	HS: SOFT_RANGES['HS-cut'],
	LP: SOFT_RANGES.LP,
	HP: SOFT_RANGES.HP
} as const;

function clampRange(value: number, range: { min: number; max: number }) {
	return Math.min(range.max, Math.max(range.min, value));
}

/** A band of `kind` that keeps the old parameters where they fit the kind's soft box. */
export function bandOfKind(previous: Band, kind: BandKind): Band {
	if (kind === 'OFF') return { kind: 'OFF' };
	const soft = SOFT_BY_KIND[kind];
	const fresh = previous.kind === 'OFF';
	const freqHz = clampRange(fresh ? 1000 : previous.freqHz, soft.freqHz);
	const qFactor = clampRange(fresh ? soft.qFactor.min : previous.qFactor, soft.qFactor);
	if (kind === 'LP' || kind === 'HP') return roundToGrid({ kind, freqHz, qFactor });
	const range = soft.gainDb ?? { min: 0, max: 0 };
	const oldGain = hasGain(previous) ? previous.gainDb : 0;
	return roundToGrid(clampToAbs({ kind, freqHz, gainDb: clampRange(oldGain, range), qFactor }));
}

export function changeKind(
	curve: Curve,
	index: number,
	kind: BandKind,
	profile: EditProfile = 'standard'
): EditResult {
	const previous = curve.bands[index];
	if (!previous) return { ok: false, reasons: [] };
	const bands = replaceBand(curve.bands, index, bandOfKind(previous, kind));
	const verdict = editorVerdict({ bands, preampDb: curve.preampDb }, profile);
	return verdict.ok ? { ok: true, bands, verdict } : { ok: false, reasons: verdict.reasons };
}
