import type { gate } from 'open-auri/safety';
import { m } from '#lib/paraglide/messages.js';

export type GateVerdict = ReturnType<typeof gate>;
export type Reason = GateVerdict['reasons'][number];
export type ReasonCode = Reason['code'];

/** Every gate reason code, with the staging message key that explains it in plain language. */
export const REASON_MESSAGE_KEYS = {
	'a:b0': 'curva_reason_a_b0',
	'a:b2': 'curva_reason_a_b2',
	'a:-a1': 'curva_reason_a_neg_a1',
	'a:b1': 'curva_reason_a_b1',
	'a:-a2': 'curva_reason_a_neg_a2',
	'b:pole-radius': 'curva_reason_b_pole_radius',
	'c:section-peak': 'curva_reason_c_section_peak',
	'd:prefix-peak': 'curva_reason_d_prefix_peak',
	'e:output-audible': 'curva_reason_e_output_audible',
	'e:output-full': 'curva_reason_e_output_full',
	'f:codec': 'curva_reason_f_codec',
	'g:preamp': 'curva_reason_g_preamp',
	'k:kind-not-allowed': 'curva_reason_k_kind_not_allowed',
	'd7:pk-boost-above-16k': 'curva_reason_d7_pk_boost_above_16k',
	'd7:boost-q': 'curva_reason_d7_boost_q'
} as const satisfies Record<ReasonCode, string>;

export const REASON_CODES = Object.keys(REASON_MESSAGE_KEYS) as ReasonCode[];

function stageOf(reason: Reason): string {
	return typeof reason.stage === 'number' && Number.isInteger(reason.stage)
		? String(reason.stage)
		: '?';
}

/** One plain-language sentence for a gate reason (the stage is 1-based, as the gate reports it). */
export function reasonText(reason: Reason): string {
	const stage = stageOf(reason);
	switch (reason.code) {
		case 'a:b0':
			return m.curva_reason_a_b0({ stage });
		case 'a:b2':
			return m.curva_reason_a_b2({ stage });
		case 'a:-a1':
			return m.curva_reason_a_neg_a1({ stage });
		case 'a:b1':
			return m.curva_reason_a_b1({ stage });
		case 'a:-a2':
			return m.curva_reason_a_neg_a2({ stage });
		case 'b:pole-radius':
			return m.curva_reason_b_pole_radius({ stage });
		case 'c:section-peak':
			return m.curva_reason_c_section_peak({ stage });
		case 'd:prefix-peak':
			return m.curva_reason_d_prefix_peak({ stage });
		case 'e:output-audible':
			return m.curva_reason_e_output_audible();
		case 'e:output-full':
			return m.curva_reason_e_output_full();
		case 'f:codec':
			return m.curva_reason_f_codec();
		case 'g:preamp':
			return m.curva_reason_g_preamp();
		case 'k:kind-not-allowed':
			return m.curva_reason_k_kind_not_allowed({ stage });
		case 'd7:pk-boost-above-16k':
			return m.curva_reason_d7_pk_boost_above_16k({ stage });
		case 'd7:boost-q':
			return m.curva_reason_d7_boost_q({ stage });
		default:
			return m.curva_reason_unknown();
	}
}

/** The first reason in plain language, or the generic sentence when the gate gave none. */
export function firstReasonText(reasons: readonly Reason[]): string {
	const first = reasons[0];
	return first ? reasonText(first) : m.curva_reason_unknown();
}
