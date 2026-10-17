/**
 * The seven gate criteria (a) to (g) for the filter-bank envelope strip, read from the gate verdict
 * the page already computed (never re-derived): a criterion passes when the gate gave no reason
 * with its letter. Values come from the verdict metrics; limits from the verdict's thresholds.
 */
import { m } from '#lib/paraglide/messages.js';
import { formatNumber, formatSignedDb, payloadCrc } from './format.ts';
import type { GateVerdict } from './reasons.ts';

export type CriterionId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';
export const CRITERIA: readonly CriterionId[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

export interface Criterion {
	id: CriterionId;
	/** The gate gave no reason for this criterion. */
	pass: boolean;
	/** The verdict carries the metric (false when, for example, the codec refused the curve). */
	known: boolean;
	value: string;
	limit: string;
}

export const criterionName: Record<CriterionId, () => string> = {
	a: () => m.curva_v2_crit_a(),
	b: () => m.curva_v2_crit_b(),
	c: () => m.curva_v2_crit_c(),
	d: () => m.curva_v2_crit_d(),
	e: () => m.curva_v2_crit_e(),
	f: () => m.curva_v2_crit_f(),
	g: () => m.curva_v2_crit_g()
};

/** Letter of a reason code ('a:b0' → 'a'; 'd7:…' and 'k:…' belong to no criterion). */
function letterOf(code: string): string {
	return code.split(':')[0] ?? '';
}

export function criteria(verdict: GateVerdict, locale: string): Criterion[] {
	const metrics = verdict.metrics;
	const limits = metrics.thresholds;
	const sections = metrics.sections ?? [];
	const unknown = m.curva_out_unknown();
	const failed = new Set(verdict.reasons.map((reason) => letterOf(reason.code)));

	let ratio = -Infinity;
	let radius = -Infinity;
	let sectionPeak = -Infinity;
	for (const section of sections) {
		section.words.forEach((word, i) => {
			const limit = limits.coefficientAbsWords[i] ?? 0;
			if (limit > 0) ratio = Math.max(ratio, Math.abs(word) / limit);
		});
		radius = Math.max(radius, section.poleRadius);
		sectionPeak = Math.max(sectionPeak, section.fullPeak.db);
	}
	const has = sections.length > 0;
	const internal = metrics.internalAudible?.db;
	const output = metrics.outputAudible?.db;
	// Same spelling as the nameplate ("0x4FFF"): from the exact payload bytes when present.
	const crc = metrics.payload ? payloadCrc(metrics.payload) : metrics.payloadCrc;
	const preamp = metrics.quantizedPreampDb ?? metrics.preampDb;

	const row = (id: CriterionId, known: boolean, value: string, limit: string): Criterion => ({
		id,
		pass: !failed.has(id),
		known,
		value: known ? value : unknown,
		limit
	});

	return [
		row(
			'a',
			has && Number.isFinite(ratio),
			`${formatNumber(ratio * 100, locale, 1)} %`,
			`${formatNumber(100, locale, 0)} %`
		),
		row(
			'b',
			has && Number.isFinite(radius),
			formatNumber(radius, locale, 5),
			formatNumber(limits.poleRadius, locale, 5)
		),
		row(
			'c',
			has && Number.isFinite(sectionPeak),
			formatSignedDb(sectionPeak, locale, 2),
			formatSignedDb(limits.sectionPeakDb, locale, 2)
		),
		row(
			'd',
			typeof internal === 'number' && Number.isFinite(internal),
			formatSignedDb(internal ?? 0, locale, 2),
			formatSignedDb(limits.internalAudibleDb, locale, 2)
		),
		row(
			'e',
			typeof output === 'number' && Number.isFinite(output),
			formatSignedDb(output ?? 0, locale, 2),
			formatSignedDb(limits.outputAudibleDb, locale, 2)
		),
		row('f', typeof crc === 'string', crc ?? '', m.curva_v2_details_codec()),
		row(
			'g',
			typeof preamp === 'number' && Number.isFinite(preamp),
			formatSignedDb(preamp ?? 0, locale),
			m.curva_v2_details_range({
				min: formatSignedDb(limits.preampMinDb, locale),
				max: formatSignedDb(limits.preampMaxDb, locale)
			})
		)
	];
}
