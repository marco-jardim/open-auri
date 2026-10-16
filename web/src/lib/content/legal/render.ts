// Prerender-time renderer of the legal pages (/privacidade, /termos). Only the routes'
// +page.server.ts import it, so the check runs while the build prerenders: a missing required
// operator field throws and fails `vite build`; an empty optional one only warns and its
// sentences are left out of the text.
//
// The output is structured data (LegalDocument), never HTML. LegalPage renders every string as a
// Svelte text node, so HTML in a value is escaped there. Values may not contain the inline markup
// that InlineText interprets (`**`, backticks, `[label](url)`) nor `{`/`}`, so an operator value
// can neither inject formatting or links nor smuggle another placeholder.
import { legalContent } from '../docs/legal-content.ts';
import {
	LEGAL_KEYS,
	fillLegalText,
	type LegalBlock,
	type LegalDocument,
	type LegalKey,
	type PublicLegalValues
} from '../docs/legal.ts';
import type { DocsLocale } from '../docs/types.ts';
import { POLICY_VERSION } from './version.ts';

/** Without these the policy cannot identify the controller: the production build fails. */
export const REQUIRED_LEGAL_KEYS = [
	'PUBLIC_ORIGIN',
	'PUBLIC_LGPD_CONTROLLER',
	'PUBLIC_LGPD_CONTACT_EMAIL',
	'PUBLIC_POLICY_EFFECTIVE_DATE'
] as const satisfies readonly LegalKey[];

/** Empty → build warning and every sentence that mentions them is omitted. */
export const OPTIONAL_LEGAL_KEYS = [
	'PUBLIC_LGPD_CNPJ',
	'PUBLIC_LGPD_ADDRESS',
	'PUBLIC_LGPD_DPO_NAME'
] as const satisfies readonly LegalKey[];

export type LegalKind = 'privacy' | 'terms';
export const LEGAL_LOCALES = ['pt-BR', 'en-US'] as const satisfies readonly DocsLocale[];

export interface LegalPageData {
	kind: LegalKind;
	policyVersion: string;
	values: PublicLegalValues;
	documents: Record<DocsLocale, LegalDocument>;
}

export interface ResolvedLegalConfig {
	values: PublicLegalValues;
	/** Optional keys left empty, whose sentences are omitted. */
	omitted: LegalKey[];
	/** Build warnings. They name keys only, never values. */
	warnings: string[];
}

/** Configuration problem. The message lists key names only, never the configured values. */
export class LegalConfigError extends Error {
	readonly keys: readonly LegalKey[];
	constructor(problems: readonly { key: LegalKey; reason: string }[]) {
		super(
			`Invalid legal configuration (production build blocked): ${problems
				.map(({ key, reason }) => `${key} ${reason}`)
				.join('; ')}`
		);
		this.name = 'LegalConfigError';
		this.keys = problems.map(({ key }) => key);
	}
}

// The inline markup InlineText interprets and placeholder braces.
const UNSAFE_CHARACTERS = '*`[]{}';

/** Control characters, inline markup or braces in an operator value. */
export function hasUnsafeCharacters(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f || UNSAFE_CHARACTERS.includes(char)) return true;
	}
	return false;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// YYYY-MM-DD, or YYYY/MM/DD (normalized to the ISO form).
const CALENDAR_DATE = /^(\d{4})([-/])(\d{2})\2(\d{2})$/;

/** The ISO form of a valid calendar date, or null. */
function calendarDate(value: string): string | null {
	const match = CALENDAR_DATE.exec(value);
	if (!match) return null;
	const [year, month, day] = [Number(match[1]), Number(match[3]), Number(match[4])];
	const date = new Date(Date.UTC(year, month - 1, day));
	const valid =
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
	return valid ? `${match[1]}-${match[3]}-${match[4]}` : null;
}

function normalizeOrigin(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
	return url.origin;
}

/**
 * Validates the PUBLIC_* operator fields read from `$app/env/public` (via #lib/config/public.ts).
 * Throws {@link LegalConfigError} when a required field is empty or malformed, or when any value
 * contains unsafe characters.
 */
export function resolveLegalConfig(config: Readonly<Record<string, unknown>>): ResolvedLegalConfig {
	const problems: { key: LegalKey; reason: string }[] = [];
	const values = {} as PublicLegalValues;
	for (const key of LEGAL_KEYS) {
		const raw = config[key];
		const value = typeof raw === 'string' ? raw.trim() : '';
		if (hasUnsafeCharacters(value)) {
			problems.push({ key, reason: 'contains unsupported characters' });
		}
		values[key] = value;
	}
	for (const key of REQUIRED_LEGAL_KEYS) {
		if (!values[key]) problems.push({ key, reason: 'is empty' });
	}
	const email = values.PUBLIC_LGPD_CONTACT_EMAIL;
	if (email && !EMAIL.test(email)) {
		problems.push({ key: 'PUBLIC_LGPD_CONTACT_EMAIL', reason: 'is not an e-mail address' });
	}
	const effectiveDate = values.PUBLIC_POLICY_EFFECTIVE_DATE;
	if (effectiveDate) {
		const iso = calendarDate(effectiveDate);
		if (iso) values.PUBLIC_POLICY_EFFECTIVE_DATE = iso;
		else problems.push({ key: 'PUBLIC_POLICY_EFFECTIVE_DATE', reason: 'is not a YYYY-MM-DD date' });
	}
	if (values.PUBLIC_ORIGIN) {
		const origin = normalizeOrigin(values.PUBLIC_ORIGIN);
		if (origin) values.PUBLIC_ORIGIN = origin;
		else problems.push({ key: 'PUBLIC_ORIGIN', reason: 'is not an http(s) origin' });
	}
	if (problems.length) throw new LegalConfigError(problems);

	const omitted = OPTIONAL_LEGAL_KEYS.filter((key) => !values[key]);
	const warnings = omitted.map(
		(key) => `[legal] ${key} is empty: the sentences mentioning it are omitted.`
	);
	return { values, omitted, warnings };
}

// A sentence ends at . ! or ? followed by whitespace and something that does not continue the
// sentence (a lowercase letter or a digit, as in "art. 7º" or "nº 2/2022").
const SENTENCE_BREAK = /(?<=[.!?])\s+(?![\p{Ll}\d])/u;

function mentions(text: string, keys: ReadonlySet<LegalKey>): boolean {
	for (const key of keys) if (text.includes(`{{${key}}}`)) return true;
	return false;
}

/** Fills one text; returns null when every sentence of it mentions an omitted field. */
export function renderLegalText(
	template: string,
	values: PublicLegalValues,
	omitted: ReadonlySet<LegalKey>
): string | null {
	let text = template;
	if (mentions(template, omitted)) {
		const sentences = template.split(SENTENCE_BREAK);
		const kept = sentences.filter((sentence) => !mentions(sentence, omitted));
		if (!kept.length) return null;
		text = kept.join(' ');
	}
	return fillLegalText(text, values);
}

/** Renders a template document: placeholders filled, sentences with omitted fields removed. */
export function renderLegalDocument(
	template: LegalDocument,
	values: PublicLegalValues,
	omitted: Iterable<LegalKey> = []
): LegalDocument {
	const skip = new Set(omitted);
	const blocks: LegalBlock[] = [];
	for (const block of template.blocks) {
		if (block.kind === 'list') {
			const items = block.items
				.map((item) => renderLegalText(item, values, skip))
				.filter((item): item is string => item !== null);
			if (items.length) blocks.push({ kind: 'list', items });
		} else if (block.kind === 'table') {
			// A table cell is not a sentence: rows that mention an omitted field go away whole.
			const rows = block.rows
				.filter((row) => !row.some((cell) => mentions(cell, skip)))
				.map((row) => row.map((cell) => fillLegalText(cell, values)));
			if (rows.length > 1) blocks.push({ kind: 'table', rows });
		} else {
			const text = renderLegalText(block.text, values, skip);
			if (text !== null) blocks.push({ ...block, text });
		}
	}
	return { locale: template.locale, title: fillLegalText(template.title, values), blocks };
}

/**
 * Data for /privacidade or /termos, computed once at prerender. `warn` receives the build warnings
 * for empty optional fields (defaults to console.warn, which Vite prints during the build).
 */
export function renderLegalPage(
	kind: LegalKind,
	config: Readonly<Record<string, unknown>>,
	warn: (message: string) => void = (message) => console.warn(message)
): LegalPageData {
	const { values, omitted, warnings } = resolveLegalConfig(config);
	for (const warning of warnings) warn(warning);
	const documents = {} as Record<DocsLocale, LegalDocument>;
	for (const locale of LEGAL_LOCALES) {
		documents[locale] = renderLegalDocument(legalContent(kind, locale), values, omitted);
	}
	return { kind, policyVersion: POLICY_VERSION, values, documents };
}
