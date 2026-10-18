import { checkBand, snapshotBands } from 'open-auri/dsp';
import { NEUTRO } from 'open-auri/catalog';
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

/** snapshotBands alone deliberately does not validate field types or values. */
export function checkedCurve(value: unknown): CurrentCurve {
	if (
		!isRecord(value) ||
		value.schema !== 1 ||
		typeof value.name !== 'string' ||
		!isSource(value.source) ||
		typeof value.preampDb !== 'number' ||
		!Number.isFinite(value.preampDb) ||
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
 * anything else malformed give null; one refused entry (link, control, too long) gives null
 * for that entry only. Never throws: labels can never make a curve unreadable.
 */
export function checkedLabels(value: unknown): CurveLabels | null {
	const labels = normalizeLabels(value, { lenient: true });
	return labels ? Object.freeze(labels) : null;
}

/** Labels compared by value (null and an all-null list are the same: no labels). */
export function sameLabels(
	a: CurveLabels | null | undefined,
	b: CurveLabels | null | undefined
): boolean {
	const left = a ?? null;
	const right = b ?? null;
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
