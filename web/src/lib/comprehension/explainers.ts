import { m } from '#lib/paraglide/messages.js';
import { glossary, type GlossaryTerm } from './glossary.ts';

function entry(
	term: GlossaryTerm,
	body: () => string,
	title: () => string = glossary[term].title,
	preview: () => string = body
) {
	return { term, anchor: glossary[term].href, title, body, preview };
}

/** Getters keep locale changes live; no prose or plan codes in component templates. */
export const explainers = {
	gate: entry('gate', () => m.explain_gate_body()),
	envelope: entry('envelope', () => m.explain_envelope_body()),
	q: entry(
		'q',
		() => m.explain_q_body(),
		glossary.q.title,
		() => m.explain_q_preview()
	),
	preamp: entry('preamp', () => m.explain_preamp_body()),
	s1: entry(
		's1',
		() => m.explain_s1_body(),
		glossary.s1.title,
		() => m.explain_s1_preview()
	),
	s5: entry('s5', () => m.explain_s5_body()),
	s6: entry('s6', () => m.explain_s6_body()),
	s7: entry(
		's7',
		() => m.explain_s7_body(),
		glossary.s7.title,
		() => m.explain_s7_preview()
	),
	'ab-nivel': entry(
		'ab-nivel',
		() => m.explain_ab_body(),
		glossary['ab-nivel'].title,
		() => m.explain_ab_preview()
	),
	'teste-cego': entry(
		'teste-cego',
		() => m.explain_blind_body(),
		glossary['teste-cego'].title,
		() => m.explain_blind_preview()
	),
	checklist: {
		...entry('checklist', () => m.explain_checklist_body()),
		warning: () => m.explain_checklist_warning()
	},
	camadas: entry('camadas', () => m.explain_layers_body()),
	neutro: entry('neutro', () => m.explain_neutral_body()),
	flash: entry('flash', () => m.explain_flash_body()),
	crc: entry('crc', () => m.explain_crc_body()),
	q27: entry('q27', () => m.explain_q27_body()),
	q23: entry('q23', () => m.explain_q23_body()),
	'gate-a': entry(
		'gate',
		() => m.explain_gate_a_body(),
		() => m.explain_gate_a_title()
	),
	'gate-b': entry(
		'gate',
		() => m.explain_gate_b_body(),
		() => m.explain_gate_b_title()
	),
	'gate-c': entry(
		'gate',
		() => m.explain_gate_c_body(),
		() => m.explain_gate_c_title()
	),
	'gate-d': entry(
		'gate',
		() => m.explain_gate_d_body(),
		() => m.explain_gate_d_title()
	),
	'gate-e': entry(
		'gate',
		() => m.explain_gate_e_body(),
		() => m.explain_gate_e_title()
	),
	'gate-f': entry(
		'gate',
		() => m.explain_gate_f_body(),
		() => m.explain_gate_f_title()
	),
	'gate-g': entry(
		'gate',
		() => m.explain_gate_g_body(),
		() => m.explain_gate_g_title()
	)
} as const;

export type ExplainerId = keyof typeof explainers;
export const gateReasonContext = () => m.explain_gate_whole();
