export type DocsLocale = 'pt-BR' | 'en-US';

export interface ContentLink {
	label: string;
	href: string;
}

export interface DocSection {
	id: string;
	title: string;
	paragraphs: readonly string[];
	items?: readonly string[];
	links?: readonly ContentLink[];
	/** Browser-only instructions: inert sizing placeholders in the app, never links or search entries. */
	browserOnly?: { paragraphs?: readonly string[]; links?: readonly ContentLink[] };
	appOnly?: { paragraphs?: readonly string[]; links?: readonly ContentLink[] };
}

export interface DocsContent {
	locale: DocsLocale;
	title: string;
	titleLead: string;
	titleEmphasis: string;
	subtitle: string;
	reprint: string;
	introduction: string;
	polarCaption: string;
	telegraphNote: string;
	stabilityNote: string;
	safetyCaveat: string;
	flashNotice: string;
	sections: readonly DocSection[];
	thresholdLabels: readonly string[];
	glossary: readonly (readonly [string, string])[];
}
