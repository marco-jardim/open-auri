import { m } from '#lib/paraglide/messages.js';
import { glossary, type GlossaryTerm } from './glossary.ts';

/**
 * The eager half of the explainer registry: each explainer's glossary term and localized title,
 * which is all the trigger needs for its accessible name. The bodies (the long §4.3 prose, both
 * locales) live in `explainers.ts`, loaded with the panel on first intent (FUX.B budget pass).
 */
function heading(term: GlossaryTerm, title: () => string = glossary[term].title) {
	return { term, title };
}

export const explainerHeadings = {
	gate: heading('gate'),
	envelope: heading('envelope'),
	q: heading('q'),
	preamp: heading('preamp'),
	s1: heading('s1'),
	s5: heading('s5'),
	s6: heading('s6'),
	s7: heading('s7'),
	'ab-nivel': heading('ab-nivel'),
	'teste-cego': heading('teste-cego'),
	checklist: heading('checklist'),
	camadas: heading('camadas'),
	neutro: heading('neutro'),
	flash: heading('flash'),
	crc: heading('crc'),
	q27: heading('q27'),
	q23: heading('q23'),
	'gate-a': heading('gate', () => m.explain_gate_a_title()),
	'gate-b': heading('gate', () => m.explain_gate_b_title()),
	'gate-c': heading('gate', () => m.explain_gate_c_title()),
	'gate-d': heading('gate', () => m.explain_gate_d_title()),
	'gate-e': heading('gate', () => m.explain_gate_e_title()),
	'gate-f': heading('gate', () => m.explain_gate_f_title()),
	'gate-g': heading('gate', () => m.explain_gate_g_title())
} as const;

export type ExplainerId = keyof typeof explainerHeadings;
