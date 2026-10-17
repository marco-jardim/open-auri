import { m } from '#lib/paraglide/messages.js';
import { glossary } from './glossary.ts';
import { explainerHeadings, type ExplainerId } from './explainer-titles.ts';

export type { ExplainerId };

function entry(id: ExplainerId, body: () => string, preview: () => string = body) {
	const { term, title } = explainerHeadings[id];
	return { term, anchor: glossary[term].href, title, body, preview };
}

/**
 * Getters keep locale changes live; no prose or plan codes in component templates. Titles come
 * from `explainer-titles.ts` (eager, for the triggers); this module holds the bodies and loads
 * with the explanation panel on first intent (FUX.B), or statically where a page prints them.
 */
export const explainers = {
	gate: entry('gate', () => m.explain_gate_body()),
	envelope: entry('envelope', () => m.explain_envelope_body()),
	q: entry(
		'q',
		() => m.explain_q_body(),
		() => m.explain_q_preview()
	),
	preamp: entry('preamp', () => m.explain_preamp_body()),
	s1: entry(
		's1',
		() => m.explain_s1_body(),
		() => m.explain_s1_preview()
	),
	s5: entry('s5', () => m.explain_s5_body()),
	s6: entry('s6', () => m.explain_s6_body()),
	s7: entry(
		's7',
		() => m.explain_s7_body(),
		() => m.explain_s7_preview()
	),
	'ab-nivel': entry(
		'ab-nivel',
		() => m.explain_ab_body(),
		() => m.explain_ab_preview()
	),
	'teste-cego': entry(
		'teste-cego',
		() => m.explain_blind_body(),
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
	'gate-a': entry('gate-a', () => m.explain_gate_a_body()),
	'gate-b': entry('gate-b', () => m.explain_gate_b_body()),
	'gate-c': entry('gate-c', () => m.explain_gate_c_body()),
	'gate-d': entry('gate-d', () => m.explain_gate_d_body()),
	'gate-e': entry('gate-e', () => m.explain_gate_e_body()),
	'gate-f': entry('gate-f', () => m.explain_gate_f_body()),
	'gate-g': entry('gate-g', () => m.explain_gate_g_body())
} as const satisfies Record<ExplainerId, unknown>;

export const gateReasonContext = () => m.explain_gate_whole();
