/**
 * Display values of the gate criteria (a)–(g), read from the SAME verdict the checklist shows.
 * Presentation only: it never runs a second gate, never decides anything and never changes a
 * lamp. A missing metric (codec refusal, unknown section) is shown as `null`, never invented.
 */
import type { GateResult, LampId } from '#lib/cable/types.ts';
import { formatCrc, formatNumber } from './i18n.ts';

export interface CriterionValue {
	/** Measured value of this curve, formatted for the current locale. */
	value: string | null;
	/** The observed-envelope limit it is compared with. */
	limit: string | null;
}

const EMPTY: CriterionValue = Object.freeze({ value: null, limit: null });

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function db(value: number, digits = 2): string {
	return `${formatNumber(value, digits, true)} dB`;
}

/** Largest share of the coefficient limit used by any section word (criterion a), in percent. */
function coefficientShare(gate: GateResult): number | null {
	const sections = gate.metrics.sections;
	const limits = gate.metrics.thresholds.coefficientAbsWords;
	if (sections === undefined) return null;
	let worst: number | null = null;
	for (const section of sections) {
		section.words.forEach((word, index) => {
			const limit = limits[index];
			if (!finite(word) || !finite(limit) || limit <= 0) return;
			const share = (Math.abs(word) / limit) * 100;
			if (worst === null || share > worst) worst = share;
		});
	}
	return worst;
}

function largest(values: readonly number[]): number | null {
	const usable = values.filter(finite);
	return usable.length === 0 ? null : Math.max(...usable);
}

/** One value per lamp id; `k` (kinds and editing limits) has no single number to show. */
export function criteriaValues(gate: GateResult | null): Record<LampId, CriterionValue> {
	const values: Record<LampId, CriterionValue> = {
		a: EMPTY,
		b: EMPTY,
		c: EMPTY,
		d: EMPTY,
		e: EMPTY,
		f: EMPTY,
		g: EMPTY,
		k: EMPTY
	};
	if (gate === null) return values;
	const { metrics } = gate;
	const limits = metrics.thresholds;

	const share = coefficientShare(gate);
	if (share !== null) {
		values.a = { value: `${formatNumber(share, 1)} %`, limit: `${formatNumber(100, 0)} %` };
	}
	const sections = metrics.sections ?? [];
	const radius = largest(sections.map((section) => section.poleRadius));
	if (radius !== null) {
		values.b = { value: `r ${formatNumber(radius, 6)}`, limit: formatNumber(limits.poleRadius, 6) };
	}
	const peak = largest(sections.map((section) => section.fullPeak.db));
	if (peak !== null) values.c = { value: db(peak), limit: db(limits.sectionPeakDb, 1) };
	if (metrics.internalAudible !== undefined && finite(metrics.internalAudible.db)) {
		values.d = { value: db(metrics.internalAudible.db), limit: db(limits.internalAudibleDb) };
	}
	if (metrics.outputAudible !== undefined && finite(metrics.outputAudible.db)) {
		values.e = { value: db(metrics.outputAudible.db), limit: db(limits.outputAudibleDb) };
	}
	const crc = metrics.payloadCrc === undefined ? Number.NaN : Number(metrics.payloadCrc);
	if (Number.isInteger(crc)) values.f = { value: `CRC ${formatCrc(crc)}`, limit: null };
	if (finite(metrics.preampDb)) {
		values.g = {
			value: db(metrics.preampDb, 1),
			limit: `${formatNumber(limits.preampMinDb, 1)} … ${formatNumber(limits.preampMaxDb, 1)} dB`
		};
	}
	return values;
}
