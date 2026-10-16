import type { DocsLocale } from './types.ts';

export const LEGAL_KEYS = [
	'PUBLIC_ORIGIN',
	'PUBLIC_LGPD_CONTROLLER',
	'PUBLIC_LGPD_CONTACT_EMAIL',
	'PUBLIC_LGPD_CNPJ',
	'PUBLIC_LGPD_ADDRESS',
	'PUBLIC_LGPD_DPO_NAME',
	'PUBLIC_POLICY_EFFECTIVE_DATE'
] as const;
export type LegalKey = (typeof LEGAL_KEYS)[number];
export type PublicLegalValues = Record<LegalKey, string>;
export type LegalBlock =
	| { kind: 'paragraph'; text: string }
	| { kind: 'heading'; text: string }
	| { kind: 'list'; items: string[] }
	| { kind: 'table'; rows: string[][] };
export interface LegalDocument {
	locale: DocsLocale;
	title: string;
	blocks: LegalBlock[];
}

/** Routes call this with #lib/config/public.ts, never with hardcoded operator data. */
export function publicLegalValues(config: Readonly<Record<string, unknown>>): PublicLegalValues {
	const values = {} as PublicLegalValues;
	for (const key of LEGAL_KEYS) {
		const value = config[key];
		if (typeof value !== 'string' || (key !== 'PUBLIC_LGPD_DPO_NAME' && !value.trim())) {
			throw new Error(`Missing public legal configuration: ${key}`);
		}
		values[key] = value;
	}
	return values;
}

/** Parse the versioned policy at build time into data, not untrusted HTML. */
export function parseLegalMarkdown(markdown: string, locale: DocsLocale): LegalDocument {
	const lines = markdown
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\(Q-LEGAL\)/g, '')
		.split(/\r?\n/)
		.map((line) => line.replace(/^>\s?/, '').trim());
	const title = lines.find((line) => line.startsWith('# '))?.slice(2) ?? '';
	const blocks: LegalBlock[] = [];
	for (let i = 0; i < lines.length;) {
		const line = lines[i];
		if (!line || line === '---' || line.startsWith('# ')) {
			i++;
			continue;
		}
		if (line.startsWith('## ')) {
			blocks.push({ kind: 'heading', text: line.slice(3) });
			i++;
			continue;
		}
		if (line.startsWith('|')) {
			const rows: string[][] = [];
			while (i < lines.length && lines[i].startsWith('|')) {
				const cells = lines[i++]
					.slice(1, -1)
					.split('|')
					.map((cell) => cell.trim());
				if (!cells.every((cell) => /^:?-+:?$/.test(cell))) rows.push(cells);
			}
			blocks.push({ kind: 'table', rows });
			continue;
		}
		if (line.startsWith('- ')) {
			const items: string[] = [];
			while (i < lines.length && lines[i].startsWith('- ')) items.push(lines[i++].slice(2));
			blocks.push({ kind: 'list', items });
			continue;
		}
		const text: string[] = [];
		while (i < lines.length && lines[i] && !/^(?:#|\||- |---$)/.test(lines[i])) {
			text.push(lines[i++]);
		}
		if (text.length) blocks.push({ kind: 'paragraph', text: text.join(' ') });
		else i++;
	}
	return { locale, title, blocks };
}

export function fillLegalText(template: string, values: PublicLegalValues): string {
	return template.replace(/\{\{(PUBLIC_[A-Z_]+)\}\}/g, (_, key: string) => {
		if (!LEGAL_KEYS.some((known) => known === key)) {
			throw new Error(`Unknown legal placeholder: ${key}`);
		}
		return values[key as LegalKey];
	});
}

export function resolveLegalDocument(
	document: LegalDocument,
	values: PublicLegalValues
): LegalDocument {
	const fill = (text: string) => fillLegalText(text, values);
	return {
		...document,
		title: fill(document.title),
		blocks: document.blocks.map((block): LegalBlock => {
			if (block.kind === 'list') return { ...block, items: block.items.map(fill) };
			if (block.kind === 'table') return { ...block, rows: block.rows.map((row) => row.map(fill)) };
			return { ...block, text: fill(block.text) };
		})
	};
}
