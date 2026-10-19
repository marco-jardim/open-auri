import { checkBand, snapshotBands } from 'open-auri/dsp';
import { NEUTRO } from 'open-auri/catalog';
import { THRESHOLDS } from 'open-auri/safety';
import { normalizeLabels } from 'open-auri/share';
import { isRecord } from './storage.ts';

export type Bands = ReturnType<typeof snapshotBands>;
export type CurveSource = `preset:${string}` | 'custom' | 'import' | `community:${string}`;
/**
 * Custom filter names by wire index (exactly ten entries, null = automatic name), normalized
 * like the S5 `name` (core `normalizeLabels`). Presentation only: never part of the curve
 * signature, S1, curveId, the gate or `#p=` links.
 */
export type CurveLabels = readonly (string | null)[];
export interface CurveData {
	readonly name: string;
	readonly source: CurveSource;
	readonly preampDb: number;
	readonly bands: Bands;
	/** Absent or null: every filter keeps its automatic name. */
	readonly labels?: CurveLabels | null;
}
export interface CurrentCurve extends CurveData {
	readonly schema: 1;
	readonly updatedAt: number;
	readonly labels: CurveLabels | null;
}
export type Clock = () => number;

export function isTimestamp(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= 8640000000000000
	);
}

export function isSource(value: unknown): value is CurveSource {
	return (
		typeof value === 'string' &&
		(value === 'custom' || value === 'import' || /^(preset|community):[^\s:]+$/.test(value))
	);
}

/**
 * Lowest preamp of a curve the client keeps (C1): −25,5 dB, the floor S1 and S5 encode and the
 * editor's in every profile (Curva `EDITOR_PREAMP_FLOOR_DB`). The YOLO gate alone waives it, so
 * `checkedCurve` refuses anything below it: such a curve could neither be edited, encoded, saved
 * nor restored, and never reaches `oa.current`, the undo history or the library.
 */
export const CURVE_PREAMP_FLOOR_DB = THRESHOLDS.preampMinDb;

/**
 * snapshotBands alone deliberately does not validate field types or values. The preamp must be
 * finite and at least `CURVE_PREAMP_FLOOR_DB`.
 */
export function checkedCurve(value: unknown): CurrentCurve {
	if (
		!isRecord(value) ||
		value.schema !== 1 ||
		typeof value.name !== 'string' ||
		!isSource(value.source) ||
		typeof value.preampDb !== 'number' ||
		!Number.isFinite(value.preampDb) ||
		!(value.preampDb >= CURVE_PREAMP_FLOOR_DB) ||
		!isTimestamp(value.updatedAt)
	) {
		throw new TypeError('Invalid current curve structure');
	}
	const bands = snapshotBands(value.bands, 10);
	bands.forEach((band, index) => checkBand(band, index));
	return Object.freeze({
		schema: 1,
		name: value.name,
		source: value.source,
		preampDb: value.preampDb,
		bands,
		labels: checkedLabels(value.labels),
		updatedAt: value.updatedAt
	});
}

/**
 * Untrusted labels → frozen ten-entry copy, or null. Old records (no key), a wrong count or
 * anything else malformed give null; one refused entry (link, control, ill-formed text, more
 * than `LABEL_MAX` code points) gives null for that entry only. Never throws: labels can never
 * make a curve unreadable. Lenient on purpose, for stored and imported data only: a person's
 * rename is checked strictly before it gets here (Curva `band-labels.svelte.ts`, `checkLabel`),
 * so a refused name is reported in the field instead of silently becoming the automatic name.
 */
export function checkedLabels(value: unknown): CurveLabels | null {
	const labels = normalizeLabels(value, { lenient: true });
	return labels ? Object.freeze(labels) : null;
}

/** No labels: absent, null, or a list whose every entry is null (every filter keeps its name). */
function noLabels(labels: CurveLabels | null | undefined): boolean {
	return labels === null || labels === undefined || labels.every((label) => label === null);
}

/** Labels compared by value (absent, null and an all-null list are the same: no labels). */
export function sameLabels(
	a: CurveLabels | null | undefined,
	b: CurveLabels | null | undefined
): boolean {
	const left = noLabels(a) ? null : (a ?? null);
	const right = noLabels(b) ? null : (b ?? null);
	if (left === null || right === null) return left === right;
	return left.length === right.length && left.every((label, index) => label === right[index]);
}

export function neutralCurve(): CurrentCurve {
	return checkedCurve({
		schema: 1,
		name: NEUTRO.label,
		source: `preset:${NEUTRO.id}`,
		preampDb: NEUTRO.preampDb,
		bands: NEUTRO.bands,
		updatedAt: 0
	});
}

/** Metadata and timestamps do not change the curve sent to a cable. Order does. */
export function curveSignature(curve: Pick<CurveData, 'preampDb' | 'bands'>): string {
	return JSON.stringify([curve.preampDb, curve.bands]);
}

export function nextTimestamp(now: Clock, previous = 0): number {
	return Math.min(8640000000000000, Math.max(now(), previous + 1));
}
