import { explainers } from '#lib/comprehension/explainers.ts';
import { glossary, type GlossaryTerm } from '#lib/comprehension/glossary.ts';

/** Every term the explainers point to; each one owns the `#g-<term>` anchor in Docs. */
export const glossaryTerms = Object.keys(glossary) as GlossaryTerm[];

export interface GlossaryEntry {
	term: GlossaryTerm;
	id: `g-${GlossaryTerm}`;
	title: string;
	body: string;
	/** Literal text that must stay visible next to the term (checklist loudness warning). */
	warning?: string;
}

/** Natural-language names and the official explainer texts (spec §4.3, §4.5). */
export function glossaryEntries(): GlossaryEntry[] {
	return glossaryTerms.map((term) => {
		const explainer = explainers[term];
		return {
			term,
			id: `g-${term}`,
			title: explainer.title(),
			body: explainer.body(),
			warning: 'warning' in explainer ? explainer.warning() : undefined
		};
	});
}
