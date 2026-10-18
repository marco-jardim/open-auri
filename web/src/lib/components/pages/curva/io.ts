/**
 * Import and export of the editor curve. All parsing/serialisation is core (`open-auri/io`,
 * `open-auri/share`, `open-auri/dsp`); this module only adds the page rules:
 * - HS/LP/HP travel in `.txt`, S5 and links only in Engenharia (experimental);
 * - every imported curve passes `gateForWrite` before it may reach the editor;
 * - imported names are untrusted: normalised by core `normalizeText`, length-capped and always
 *   rendered as text by the components (never as HTML).
 */
import { EqualizerApoError, parseEqualizerApo, serializeEqualizerApo } from 'open-auri/io';
import {
	decodeS1,
	encodeS1,
	EnvelopeError,
	normalizeLabels,
	normalizeText,
	parseEnvelope,
	S1Error,
	serializeEnvelope
} from 'open-auri/share';
import type { Layer, UrlLike } from './layers.ts';
import { hasExperimental, verdictFor, type Band, type Curve } from './model.ts';
import type { Reason } from './reasons.ts';

export const NAME_MAX = 48;
export const LINK_PREFIX = '#p=';
export const S5_FORMAT = 'open-auri/preset@1';
/** Emitted only when the curve has at least one filter label; `@1` otherwise. */
export const S5_FORMAT_LABELS = 'open-auri/preset@2';

/**
 * The S5 format and `labels` field for a curve: `@2` with the normalized labels when at least
 * one is set, else `@1` without the key (byte-identical to an `@1` export). Labels refused by
 * the core rules are dropped here (entry by entry), never published.
 */
export function s5Labels(labels: unknown): {
	format: typeof S5_FORMAT | typeof S5_FORMAT_LABELS;
	labels?: (string | null)[];
} {
	const normalized = normalizeLabels(labels, { lenient: true });
	return normalized ? { format: S5_FORMAT_LABELS, labels: normalized } : { format: S5_FORMAT };
}

export type IoError =
	'format' | 'too-many' | 'experimental-layer' | 'gate' | 'link' | 'envelope' | 'grid';

export type IoFailure = { ok: false; error: IoError; reasons: Reason[]; detail?: string };
export interface ImportedCurve extends Curve {
	readonly name: string | null;
	readonly bands: Band[];
	/** Filter labels of an `open-auri/preset@2` file; never from `.txt` or `#p=` links. */
	readonly labels?: (string | null)[] | null;
}
export type ImportResult = { ok: true; curve: ImportedCurve; warnings: number } | IoFailure;
export type ExportResult<T> = { ok: true; value: T } | IoFailure;
export type Downloader = (name: string, blob: Blob) => void;
export type ClipboardWriter = (text: string) => Promise<void>;

const fail = (error: IoError, reasons: Reason[] = [], detail?: string): IoFailure => ({
	ok: false,
	error,
	reasons,
	...(detail === undefined ? {} : { detail })
});

/**
 * Untrusted text → display-safe name: core normalisation (NFKC, controls and invisible characters
 * removed, URL-like text refused) and at most 48 code points. Returns `fallback` when refused.
 */
export function safeName(raw: unknown, fallback: string): string {
	if (typeof raw !== 'string') return fallback;
	let normalized: string;
	try {
		normalized = normalizeText(raw);
	} catch (cause) {
		if (cause instanceof EnvelopeError) return fallback;
		throw cause;
	}
	const points = Array.from(normalized);
	return points.length === 0 ? fallback : points.slice(0, NAME_MAX).join('');
}

/** Layer rule and gate for anything coming from outside the editor. */
export function admit(curve: ImportedCurve, layer: Layer): ImportResult {
	if (hasExperimental(curve.bands) && layer !== 'engenharia') return fail('experimental-layer');
	const verdict = verdictFor(curve);
	if (!verdict.ok) return fail('gate', verdict.reasons);
	return { ok: true, curve, warnings: 0 };
}

export function importTxt(text: string, layer: Layer): ImportResult {
	let parsed: ReturnType<typeof parseEqualizerApo>;
	try {
		parsed = parseEqualizerApo(text);
	} catch (cause) {
		if (!(cause instanceof EqualizerApoError)) throw cause;
		return fail(cause.code === 'apo:too-many-filters' ? 'too-many' : 'format', [], cause.code);
	}
	const result = admit({ name: null, bands: parsed.bands, preampDb: parsed.preampDb }, layer);
	return result.ok ? { ...result, warnings: parsed.warnings.length } : result;
}

export function exportTxt(curve: Curve, layer: Layer): ExportResult<string> {
	if (hasExperimental(curve.bands) && layer !== 'engenharia') return fail('experimental-layer');
	try {
		return { ok: true, value: serializeEqualizerApo(curve) };
	} catch (cause) {
		if (cause instanceof EqualizerApoError) return fail('format', [], cause.code);
		throw cause;
	}
}

function s1Of(curve: Curve): ExportResult<string> {
	try {
		return { ok: true, value: encodeS1(curve) };
	} catch (cause) {
		if (cause instanceof S1Error) return fail('grid', [], cause.code);
		throw cause;
	}
}

export interface S5Meta {
	name: string;
	source: string;
	lang: 'pt-BR' | 'en-US';
	now: number;
	/** Filter labels by wire index: any set label makes the file `open-auri/preset@2`. */
	labels?: readonly (string | null)[] | null;
}

export function exportS5(curve: Curve, meta: S5Meta, layer: Layer): ExportResult<string> {
	if (hasExperimental(curve.bands) && layer !== 'engenharia') return fail('experimental-layer');
	const code = s1Of(curve);
	if (!code.ok) return code;
	const { format, labels } = s5Labels(meta.labels);
	try {
		return {
			ok: true,
			value: serializeEnvelope({
				format,
				name: safeName(meta.name, 'open-auri'),
				description: '',
				source: meta.source,
				license: 'CC0-1.0',
				code: code.value,
				preampDb: curve.preampDb,
				bands: curve.bands,
				...(labels ? { labels } : {}),
				lang: meta.lang,
				createdAt: new Date(meta.now).toISOString()
			})
		};
	} catch (cause) {
		if (cause instanceof EnvelopeError) {
			return fail('envelope', [], cause.errors.map((issue) => issue.code).join(', '));
		}
		throw cause;
	}
}

export function importS5(json: string, layer: Layer): ImportResult {
	const parsed = parseEnvelope(json);
	if (!parsed.ok) {
		return fail('envelope', [], parsed.errors.map((issue) => issue.code).join(', '));
	}
	const { value } = parsed;
	return admit(
		{
			name: safeName(value.name, ''),
			bands: value.bands,
			preampDb: value.preampDb,
			labels: value.labels ?? null
		},
		layer
	);
}

/** Text files: S5 JSON when it parses as an object, EqualizerAPO otherwise. */
export function importFileText(text: string, layer: Layer): ImportResult {
	return text.trimStart().startsWith('{') ? importS5(text, layer) : importTxt(text, layer);
}

/** The exact 220-byte payload a write would send, taken from the gate's own snapshot. */
export function exportBin(curve: Curve): ExportResult<Uint8Array<ArrayBuffer>> {
	const verdict = verdictFor(curve);
	const payload = verdict.metrics.payload;
	if (!verdict.ok || !payload) return fail('gate', verdict.reasons);
	return { ok: true, value: Uint8Array.from(payload) };
}

export function linkHash(curve: Curve, layer: Layer): ExportResult<string> {
	if (hasExperimental(curve.bands) && layer !== 'engenharia') return fail('experimental-layer');
	const code = s1Of(curve);
	return code.ok ? { ok: true, value: `${LINK_PREFIX}${code.value}` } : code;
}

/** `#p=<S1>` → admitted curve; `null` when the hash carries no curve link. */
export function readLinkHash(hash: string, layer: Layer): ImportResult | null {
	if (!hash.startsWith(LINK_PREFIX)) return null;
	const code = hash.slice(LINK_PREFIX.length);
	let decoded: ReturnType<typeof decodeS1>;
	try {
		decoded = decodeS1(code);
	} catch (cause) {
		if (cause instanceof S1Error) return fail('link', [], cause.code);
		throw cause;
	}
	return admit({ name: null, bands: decoded.bands, preampDb: decoded.preampDb }, layer);
}

/** Absolute link for `hash`; `current` is read only here (on click, in the browser). */
export function linkUrl(current: UrlLike, hash: string): string {
	const url = new URL(current.href);
	url.hash = hash.startsWith('#') ? hash.slice(1) : hash;
	return url.toString();
}

/** File names carry only a safe ASCII slug of the (untrusted) curve name. */
export function fileName(name: string, extension: 'txt' | 'json' | 'bin'): string {
	const slug = name
		.normalize('NFKD')
		.replace(/[^\w-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase()
		.slice(0, 40);
	return `${slug || 'open-auri'}.${extension}`;
}
