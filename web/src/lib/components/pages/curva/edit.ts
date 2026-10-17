/**
 * Discrete edits validated by the core gate on the full grid: reordering sections (patch cables in
 * Engenharia) and changing a section's kind. A refusal leaves the curve untouched and returns the
 * reasons, so the UI snaps the module back and explains why.
 */
import { autoPreamp, clampToAbs, roundToGrid, SOFT_RANGES } from 'open-auri/safety';
import { hasExperimental, hasGain, replaceBand, verdictFor } from './model.ts';
import type { Band, BandKind, Curve } from './model.ts';
import type { GateVerdict, Reason } from './reasons.ts';

export type EditResult =
	{ ok: true; bands: Band[]; verdict: GateVerdict } | { ok: false; reasons: Reason[] };

export type PreampResult =
	| { ok: true; preampDb: number; changed: boolean; verdict: GateVerdict }
	| { ok: false; reasons: Reason[] };

/**
 * "Máximo sem clipping": the highest preamp on the 0.1 dB grid that the full gate accepts for these
 * bands (core `autoPreamp`), verified again with the write gate. The bands are never touched. When
 * no preamp can fix the curve (kinds, D7, coefficients…), the curve's own reasons explain why.
 */
export function maxPreamp(curve: Curve): PreampResult {
	const preampDb = autoPreamp(curve.bands, { experimental: hasExperimental(curve.bands) });
	const verdict =
		preampDb === null ? verdictFor(curve) : verdictFor({ bands: curve.bands, preampDb });
	if (preampDb === null || !verdict.ok) return { ok: false, reasons: verdict.reasons };
	return { ok: true, preampDb, changed: preampDb !== curve.preampDb, verdict };
}

/** Section `from` moves to position `to`; the others keep their relative order. */
export function moveSection(bands: readonly Band[], from: number, to: number): Band[] {
	const out = bands.slice();
	if (from === to || from < 0 || to < 0 || from >= out.length || to >= out.length) return out;
	const [moved] = out.splice(from, 1);
	if (moved) out.splice(to, 0, moved);
	return out;
}

export function reorderSections(curve: Curve, from: number, to: number): EditResult {
	const bands = moveSection(curve.bands, from, to);
	const verdict = verdictFor({ bands, preampDb: curve.preampDb });
	return verdict.ok ? { ok: true, bands, verdict } : { ok: false, reasons: verdict.reasons };
}

/** The core default order (D1): cuts before boosts, OFF last; stable within each group. */
export function defaultOrder(bands: readonly Band[]): Band[] {
	const rank = (band: Band) => {
		if (band.kind === 'OFF') return 2;
		return hasGain(band) && band.gainDb > 0 ? 1 : 0;
	};
	return bands
		.map((band, index) => ({ band, index }))
		.sort((a, b) => rank(a.band) - rank(b.band) || a.index - b.index)
		.map(({ band }) => band);
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

export function changeKind(curve: Curve, index: number, kind: BandKind): EditResult {
	const previous = curve.bands[index];
	if (!previous) return { ok: false, reasons: [] };
	const bands = replaceBand(curve.bands, index, bandOfKind(previous, kind));
	const verdict = verdictFor({ bands, preampDb: curve.preampDb });
	return verdict.ok ? { ok: true, bands, verdict } : { ok: false, reasons: verdict.reasons };
}
