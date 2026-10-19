import { decodeS1, encodeS1, S1Error, validateEnvelope } from 'open-auri/share';
import {
	createSocialApi,
	type CurveOrigin,
	type EnqueueInput,
	type SocialFetch
} from '#lib/social/index.ts';
import type { Curve } from './model.ts';
import { s5Labels } from './io.ts';
import { REASON_CODES, reasonText } from './reasons.ts';
import { m } from '#lib/paraglide/messages.js';

export function currentS1(curve: Curve): string | null {
	try {
		return encodeS1(curve);
	} catch (cause) {
		if (cause instanceof S1Error) return null;
		throw cause;
	}
}

/** A new version (`POST /lineages/[id]/versions`) is a publication too. */
const VERSIONS_PATH = /^\/api\/v1\/lineages\/[^/]+\/versions$/;

/**
 * The shared client deliberately accepts any 2xx; publication (a new lineage or a new version)
 * requires exactly 201.
 */
export function curvaSocialApi(fetcher: SocialFetch = (input, init) => fetch(input, init)) {
	return createSocialApi({
		fetch: async (input, init) => {
			const response = await fetcher(input, init);
			const publication = input === '/api/v1/curves' || VERSIONS_PATH.test(input);
			if (init.method === 'POST' && publication && response.ok) {
				if (response.status !== 201) {
					return new Response('{"error":{"code":"INTERNAL"}}', { status: 502 });
				}
			}
			return response;
		}
	});
}

type License = 'CC0-1.0' | 'CC-BY-4.0';

function langOf(locale: string): 'pt-BR' | 'en-US' {
	return locale.startsWith('en') ? 'en-US' : 'pt-BR';
}

/**
 * Raw S5 envelope of an editor curve. The text is exactly what the person typed: `checkEnvelope`
 * normalizes and validates it with the same core rules as the server. Filter labels make it
 * `open-auri/preset@2` (`s5Labels`: refused entries dropped); without labels it stays `@1`.
 */
export function socialEnvelope(
	curve: Curve,
	meta: {
		name: string;
		description: string;
		license: License;
		locale: string;
		labels?: readonly (string | null)[] | null;
	}
): Record<string, unknown> {
	// `@2` with labels or a band above 20 kHz (an S1 v2 curve), `@1` otherwise.
	const { format, labels } = s5Labels(meta.labels, curve.bands);
	return {
		format,
		name: meta.name,
		description: meta.description,
		license: meta.license,
		source: 'custom',
		code: currentS1(curve) ?? '',
		preampDb: curve.preampDb,
		bands: curve.bands,
		...(labels ? { labels } : {}),
		lang: langOf(meta.locale),
		createdAt: new Date().toISOString()
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored recipe (JSON text of the version); anything unreadable is dropped. */
function parseRecipe(text: string | null): Record<string, unknown> | null {
	if (text === null) return null;
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? value : null;
	} catch (cause) {
		if (cause instanceof SyntaxError) return null;
		throw cause;
	}
}

/**
 * Raw S5 envelope of a stored version with new text: the same curve (preamp and bands decoded
 * from its exact S1), license, language, recipe and filter labels (`@2` when it has any). Used
 * to rename an own creation: a rename keeps the version's labels.
 */
export function versionEnvelope(
	source: {
		s1: string;
		license: string;
		lang: string;
		recipe: string | null;
		labels?: readonly (string | null)[] | null;
	},
	text: { name: string; description: string }
): Record<string, unknown> {
	let decoded: ReturnType<typeof decodeS1> | null = null;
	try {
		decoded = decodeS1(source.s1);
	} catch (cause) {
		if (!(cause instanceof S1Error)) throw cause;
	}
	// `@2` with labels or a band above 20 kHz (an S1 v2 curve), `@1` otherwise.
	const { format, labels } = s5Labels(source.labels, decoded?.bands);
	const raw: Record<string, unknown> = {
		format,
		name: text.name,
		description: text.description,
		license: source.license,
		source: 'custom',
		code: source.s1,
		preampDb: decoded?.preampDb ?? 0,
		bands: decoded?.bands ?? [],
		...(labels ? { labels } : {}),
		lang: source.lang,
		createdAt: new Date().toISOString()
	};
	const recipe = parseRecipe(source.recipe);
	if (recipe) raw.recipe = recipe;
	return raw;
}

/** The text fields a person edits; `null` for an issue elsewhere in the envelope. */
export type TextField = 'name' | 'description';

export interface TextIssue {
	field: TextField | null;
	code: string;
}

export type CheckedEnvelope =
	| { ok: true; envelope: Record<string, unknown>; code: string; name: string; description: string }
	| { ok: false; issues: TextIssue[] };

function fieldOf(path: string): TextField | null {
	return path === '/name' ? 'name' : path === '/description' ? 'description' : null;
}

/**
 * Core validation (lengths in code points, at most five description lines, no links, no control
 * characters) before anything is sent; the normalized envelope is what the server stores. Text
 * that normalizes to nothing is refused like the server does.
 */
export function checkEnvelope(raw: Record<string, unknown>): CheckedEnvelope {
	const checked = validateEnvelope(raw);
	const issues: TextIssue[] = checked.ok
		? []
		: checked.errors.map((issue) => ({ field: fieldOf(issue.path), code: issue.code }));
	const typed = raw.description;
	if (
		checked.ok &&
		typeof typed === 'string' &&
		typed.trim() !== '' &&
		checked.value.description === ''
	) {
		issues.push({ field: 'description', code: 'env:length' });
	}
	if (!checked.ok || issues.length > 0) {
		const seen = new Set<string>();
		return {
			ok: false,
			issues: issues.filter((issue) => {
				const key = `${issue.field ?? ''}:${issue.code}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			})
		};
	}
	const value = checked.value;
	return {
		ok: true,
		envelope: { ...value },
		code: value.code,
		name: value.name,
		description: value.description
	};
}

/** Localized message of a text issue (the envelope messages, with the S5 limits per field). */
export function textIssueText(issue: TextIssue): string {
	switch (issue.code) {
		case 'env:url':
			return m.comunidade_env_url();
		case 'env:url-like':
			return m.cvedit_url_like();
		case 'env:length':
		case 'env:required':
			if (issue.field === 'name') return m.cvedit_name_length();
			if (issue.field === 'description') return m.cvedit_description_length();
			return m.comunidade_env_invalid();
		case 'env:pattern':
			return issue.field ? m.cvedit_text_control() : m.comunidade_env_invalid();
		default:
			return m.comunidade_env_invalid();
	}
}

/** API details are untrusted: only known gate codes reach the existing localized mapper. */
export function serverGateMessages(details: unknown): string[] {
	const reasons: unknown =
		typeof details === 'object' && details !== null ? Reflect.get(details, 'reasons') : null;
	if (!Array.isArray(reasons) || reasons.length === 0) return [m.curva_reason_unknown()];
	return reasons.map((entry: unknown) => {
		const code: unknown =
			typeof entry === 'string'
				? entry
				: typeof entry === 'object' && entry !== null
					? Reflect.get(entry, 'code')
					: null;
		const known = REASON_CODES.find((candidate) => candidate === code);
		if (!known) return m.curva_reason_unknown();
		const stage: unknown =
			typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'stage') : undefined;
		return reasonText({ code: known, ...(typeof stage === 'number' ? { stage } : {}) });
	});
}

/** Audio-context seconds, not wall time. Gaps, silence, A-side and edits break continuity. */
export class PreviewActivity {
	#session = -1;
	#sent = false;
	#s1: string | null = null;
	#since: number | null = null;
	#last: number | null = null;

	interrupt(): void {
		this.#since = this.#last = null;
	}

	sample(
		session: number,
		s1: string | null,
		origin: CurveOrigin | null,
		seconds: number | null
	): EnqueueInput | null {
		if (session !== this.#session) {
			this.#session = session;
			this.#sent = false;
			this.interrupt();
		}
		if (s1 !== this.#s1) {
			this.#s1 = s1;
			this.interrupt();
		}
		if (!s1 || !origin || seconds === null || !Number.isFinite(seconds)) {
			this.interrupt();
			return null;
		}
		if (this.#sent) return null;
		if (this.#last === null || seconds < this.#last || seconds - this.#last > 0.5) {
			this.#since = seconds;
		}
		this.#last = seconds;
		const durationMs = Math.floor((seconds - (this.#since ?? seconds)) * 1000);
		if (durationMs < 10_000) return null;
		this.#sent = true;
		return { kind: 'previewed', lineageId: origin.lineageId, durationMs };
	}
}
