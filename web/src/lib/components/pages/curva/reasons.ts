import type { gate } from 'open-auri/safety';
import { m } from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import { formatHzCompact } from './format.ts';

export type GateVerdict = ReturnType<typeof gate>;
export type Reason = GateVerdict['reasons'][number];
export type ReasonCode = Reason['code'];

/**
 * Every gate reason code, with the message key that explains it in plain language: what would go
 * wrong, where (band number and frequency, from the gate's 1-based `stage`) and how to fix it.
 */
export const REASON_MESSAGE_KEYS = {
	'a:b0': 'curva_why_coef',
	'a:b2': 'curva_why_coef',
	'a:-a1': 'curva_why_coef',
	'a:b1': 'curva_why_coef',
	'a:-a2': 'curva_why_coef',
	'b:pole-radius': 'curva_why_pole',
	'c:section-peak': 'curva_why_section_peak',
	'd:prefix-peak': 'curva_why_prefix_peak',
	'e:output-audible': 'curva_why_output_audible',
	'e:output-full': 'curva_why_output_full',
	'f:codec': 'curva_why_codec',
	'g:preamp': 'curva_why_preamp',
	'k:kind-not-allowed': 'curva_why_kind',
	'd7:pk-boost-above-16k': 'curva_why_d7_high',
	'd7:boost-q': 'curva_why_d7_q'
} as const satisfies Record<ReasonCode, string>;

export const REASON_CODES = Object.keys(REASON_MESSAGE_KEYS) as ReasonCode[];

/** What a reason can say about its band: the curve the gate judged (wire order) and the locale. */
export interface ReasonContext {
	bands?: readonly { kind: string; freqHz?: number }[];
	locale?: string;
}

/** The 1-based band the gate points at, or null when it gave no usable stage (never invented). */
export function bandOf(reason: Reason): number | null {
	const stage = reason.stage;
	return typeof stage === 'number' && Number.isInteger(stage) && stage >= 1 && stage <= 10
		? stage
		: null;
}

/** "A banda 4 (2,2 kHz)", "A banda 4" or, without a stage, "Uma das bandas". Never a placeholder. */
export function whereText(reason: Reason, context: ReasonContext = {}): string {
	const index = bandOf(reason);
	if (index === null) return m.curva_where_any();
	const band = context.bands?.[index - 1];
	const freq = band && band.kind !== 'OFF' ? band.freqHz : undefined;
	if (typeof freq === 'number' && Number.isFinite(freq)) {
		return m.curva_where_band({
			index: String(index),
			freq: formatHzCompact(freq, context.locale ?? getLocale())
		});
	}
	return m.curva_where_band_bare({ index: String(index) });
}

const COEFFICIENT: Partial<Record<ReasonCode, string>> = {
	'a:b0': 'b0',
	'a:b2': 'b2',
	'a:-a1': '−a1',
	'a:b1': 'b1',
	'a:-a2': '−a2'
};

/** One plain-language explanation for a gate reason: what, where and how to fix it. */
export function reasonText(reason: Reason, context: ReasonContext = {}): string {
	const where = () => whereText(reason, context);
	switch (reason.code) {
		case 'a:b0':
		case 'a:b2':
		case 'a:-a1':
		case 'a:b1':
		case 'a:-a2':
			return m.curva_why_coef({ where: where(), coef: COEFFICIENT[reason.code] ?? reason.code });
		case 'b:pole-radius':
			return m.curva_why_pole({ where: where() });
		case 'c:section-peak':
			return m.curva_why_section_peak({ where: where() });
		case 'd:prefix-peak':
			return m.curva_why_prefix_peak({ where: where() });
		case 'e:output-audible':
			return m.curva_why_output_audible();
		case 'e:output-full':
			return m.curva_why_output_full();
		case 'f:codec':
			return m.curva_why_codec();
		case 'g:preamp':
			return m.curva_why_preamp();
		case 'k:kind-not-allowed':
			return m.curva_why_kind({ where: where() });
		case 'd7:pk-boost-above-16k':
			return m.curva_why_d7_high({ where: where() });
		case 'd7:boost-q':
			return m.curva_why_d7_q({ where: where() });
		default:
			return m.curva_reason_unknown();
	}
}

/** The first reason in plain language, or the generic sentence when the gate gave none. */
export function firstReasonText(reasons: readonly Reason[], context: ReasonContext = {}): string {
	const first = reasons[0];
	return first ? reasonText(first, context) : m.curva_reason_unknown();
}
