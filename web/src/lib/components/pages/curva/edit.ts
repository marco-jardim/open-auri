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
 *
 * During "Prévia sem limites" the discrete edits take the `'codec'` judge (`EditJudge`): the codec
 * accepts the curve, the very check the drags use (`codecAccepts`), within the same −25,5 dB floor.
 * The page then keeps such an edit in its memory-only draft, never in the store.
 */
import {
	autoPreamp,
	clampToAbs,
	freqMaxFor,
	isUltrasonic,
	roundToGrid,
	SOFT_RANGES,
	THRESHOLDS,
	ULTRA_CUT_Q_MAX
} from 'open-auri/safety';
import { codecAccepts } from '#lib/workers/gate-handler.ts';
import type { Layer } from './layers.ts';
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
 * What judges a discrete edit: a gate profile, or `'codec'` during "Prévia sem limites" (the
 * editor profile of that moment, `editorProfile`), where the codec alone accepts, as for drags.
 */
export type EditJudge = EditProfile | 'codec';

/** The gate profile behind a judge: the free preview searches and explains with YOLO's. */
function gateProfileOf(judge: EditJudge): EditProfile {
	return judge === 'standard' ? 'standard' : 'yolo';
}

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
 * The free preview's verdict: the codec accepts the curve (`codecAccepts`, as for drags) and the
 * preamp is not below the editor floor. The metrics are the YOLO gate's, but its refusals do not
 * count: such a curve is only heard (behind the preview protection) from the memory-only draft,
 * never stored or written. A refusal names the codec's reasons (`f:codec`) and the floor's.
 */
function codecVerdict(curve: Curve): GateVerdict {
	const verdict = verdictFor(curve, 'yolo');
	const reasons: Reason[] = [];
	if (!codecAccepts(curve.bands, curve.preampDb)) {
		const codec = verdict.reasons.filter((reason) => reason.code === 'f:codec');
		reasons.push(...(codec.length > 0 ? codec : verdict.reasons));
	}
	const floor = floorReason(curve.preampDb, 'yolo');
	if (floor !== null) reasons.push(floor);
	return { ...verdict, ok: reasons.length === 0, reasons };
}

/**
 * The write gate's full-grid verdict in `profile` (`verdictFor`), plus the editor's −25,5 dB
 * preamp floor in YOLO: the verdict every discrete edit of the editor uses. With the `'codec'`
 * judge ("Prévia sem limites") the codec's acceptance decides instead (`codecVerdict`).
 */
export function editorVerdict(curve: Curve, profile: EditJudge = 'standard'): GateVerdict {
	if (profile === 'codec') return codecVerdict(curve);
	const verdict = verdictFor(curve, profile);
	const floor = floorReason(curve.preampDb, profile);
	return floor === null ? verdict : { ...verdict, ok: false, reasons: [...verdict.reasons, floor] };
}

/**
 * "Máximo sem clipping": the highest preamp on the 0.1 dB grid that the full gate of `profile`
 * accepts for these bands (core `autoPreamp`), verified again with the write gate. The bands are
 * never touched. When no preamp can fix the curve (kinds, D7, coefficients…), the curve's own
 * reasons explain why; in YOLO, a curve that needs a preamp below −25,5 dB is refused with the
 * `g:preamp` reason. In the free preview (`'codec'`) the search is YOLO's (what avoids clipping)
 * and the codec judges the result, like every other free-preview edit.
 */
export function maxPreamp(curve: Curve, profile: EditJudge = 'standard'): PreampResult {
	const gateProfile = gateProfileOf(profile);
	const experimental = hasExperimental(curve.bands);
	const preampDb = autoPreamp(
		curve.bands,
		gateProfile === 'yolo' ? { experimental, profile: 'yolo' } : { experimental }
	);
	const verdict =
		preampDb === null
			? verdictFor(curve, gateProfile)
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
	profile: EditJudge = 'standard'
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

/**
 * Editor context of a kind change: the layer and Modo YOLO (`freqMaxFor`). Without a layer a
 * band never stays above 20 kHz.
 */
export interface KindContext {
	readonly layer?: Layer;
	readonly yolo?: boolean;
}

/**
 * The new kind at an old frequency above 20 kHz, when `context` allows that kind there
 * (`freqMaxFor`), else null. In Engenharia without Modo YOLO only sections that never amplify go
 * there, so the gain is clamped to <= 0 and an LS/HS/LP/HP Q to <= `ULTRA_CUT_Q_MAX` (0,71); in
 * YOLO every kind keeps its frequency. Gain and Q stay inside the absolute ranges; the frequency
 * is kept (`clampToAbs` would bring it down to 20 kHz).
 */
function ultrasonicOfKind(
	freqHz: number,
	kind: Exclude<BandKind, 'OFF'>,
	gainDb: number,
	qFactor: number,
	context: KindContext
): Band | null {
	const yolo = context.layer === 'engenharia' && context.yolo === true;
	const gain = yolo ? gainDb : Math.min(0, gainDb);
	const q = yolo || kind === 'PK' ? qFactor : Math.min(ULTRA_CUT_Q_MAX, qFactor);
	const band: Band =
		kind === 'LP' || kind === 'HP'
			? { kind, freqHz, qFactor: q }
			: { ...clampToAbs({ kind, freqHz, gainDb: gain, qFactor: q }), freqHz };
	const max = freqMaxFor(band, { layer: context.layer ?? '', yolo: context.yolo === true });
	return freqHz <= max ? roundToGrid(band) : null;
}

/**
 * A band of `kind` that keeps the old parameters where they fit the kind's soft box. A band
 * above 20 kHz keeps its frequency when `context` allows the new kind there (Engenharia: gain
 * clamped to <= 0 and Q to <= 0,71; Modo YOLO: any kind); otherwise, and without a context, the
 * frequency comes back inside the soft box (20 kHz at most), as before.
 */
export function bandOfKind(previous: Band, kind: BandKind, context: KindContext = {}): Band {
	if (kind === 'OFF') return { kind: 'OFF' };
	const soft = SOFT_BY_KIND[kind];
	const fresh = previous.kind === 'OFF';
	const qFactor = clampRange(fresh ? soft.qFactor.min : previous.qFactor, soft.qFactor);
	const range = soft.gainDb ?? { min: 0, max: 0 };
	const oldGain = hasGain(previous) ? previous.gainDb : 0;
	const gainDb = clampRange(oldGain, range);
	if (previous.kind !== 'OFF' && isUltrasonic(previous)) {
		const kept = ultrasonicOfKind(previous.freqHz, kind, gainDb, qFactor, context);
		if (kept) return kept;
	}
	const freqHz = clampRange(fresh ? 1000 : previous.freqHz, soft.freqHz);
	if (kind === 'LP' || kind === 'HP') return roundToGrid({ kind, freqHz, qFactor });
	return roundToGrid(clampToAbs({ kind, freqHz, gainDb, qFactor }));
}

/**
 * A kind change judged by the full gate of `profile` (or by the codec, `'codec'`, during
 * "Prévia sem limites"). `layer` (the editor's) lets a band above 20 kHz keep its frequency where
 * that layer allows the new kind (`bandOfKind`); Modo YOLO is `profile === 'yolo'`, and the free
 * preview (`'codec'`, only ever on with Modo YOLO) counts as YOLO there too.
 */
export function changeKind(
	curve: Curve,
	index: number,
	kind: BandKind,
	profile: EditJudge = 'standard',
	layer?: Layer
): EditResult {
	const previous = curve.bands[index];
	if (!previous) return { ok: false, reasons: [] };
	const context: KindContext = layer ? { layer, yolo: gateProfileOf(profile) === 'yolo' } : {};
	const bands = replaceBand(curve.bands, index, bandOfKind(previous, kind, context));
	const verdict = editorVerdict({ bands, preampDb: curve.preampDb }, profile);
	return verdict.ok ? { ok: true, bands, verdict } : { ok: false, reasons: verdict.reasons };
}
