import { checkBand, snapshotBands } from 'open-auri/dsp';
import { NEUTRO } from 'open-auri/catalog';
import { isRecord } from './storage.ts';

export type Bands = ReturnType<typeof snapshotBands>;
export type CurveSource = `preset:${string}` | 'custom' | 'import' | `community:${string}`;
export interface CurveData {
	readonly name: string;
	readonly source: CurveSource;
	readonly preampDb: number;
	readonly bands: Bands;
}
export interface CurrentCurve extends CurveData {
	readonly schema: 1;
	readonly updatedAt: number;
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
		updatedAt: value.updatedAt
	});
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
