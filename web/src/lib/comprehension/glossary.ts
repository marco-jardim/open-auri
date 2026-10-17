import { m } from '#lib/paraglide/messages.js';

/** IDs are a technical contract with Docs; names shown to readers are localized. */
export const glossary = {
	gate: { href: '/docs#g-gate', title: () => m.glossary_gate() },
	envelope: { href: '/docs#g-envelope', title: () => m.glossary_envelope() },
	q: { href: '/docs#g-q', title: () => m.glossary_q() },
	preamp: { href: '/docs#g-preamp', title: () => m.glossary_preamp() },
	s1: { href: '/docs#g-s1', title: () => m.glossary_s1() },
	s5: { href: '/docs#g-s5', title: () => m.glossary_s5() },
	s6: { href: '/docs#g-s6', title: () => m.glossary_s6() },
	s7: { href: '/docs#g-s7', title: () => m.glossary_s7() },
	'ab-nivel': { href: '/docs#g-ab-nivel', title: () => m.glossary_ab_nivel() },
	'teste-cego': { href: '/docs#g-teste-cego', title: () => m.glossary_teste_cego() },
	checklist: { href: '/docs#g-checklist', title: () => m.glossary_checklist() },
	flash: { href: '/docs#g-flash', title: () => m.glossary_flash() },
	crc: { href: '/docs#g-crc', title: () => m.glossary_crc() },
	q27: { href: '/docs#g-q27', title: () => m.glossary_q27() },
	q23: { href: '/docs#g-q23', title: () => m.glossary_q23() },
	camadas: { href: '/docs#g-camadas', title: () => m.glossary_camadas() },
	neutro: { href: '/docs#g-neutro', title: () => m.glossary_neutro() }
} as const;

export type GlossaryTerm = keyof typeof glossary;

export function glossaryHref(term: GlossaryTerm): string {
	return glossary[term].href;
}
