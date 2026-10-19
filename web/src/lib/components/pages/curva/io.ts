/**
 * Import and export of the editor curve. All parsing/serialisation is core (`open-auri/io`,
 * `open-auri/share`, `open-auri/dsp`); this module only adds the page rules:
 * - HS/LP/HP travel in `.txt`, S5 and links only in Engenharia (experimental), and so does a
 *   band above 20 kHz (`ultrasonic-layer`);
 * - every imported curve is classified (core `classifyCurve`, see curva/yolo.ts): a standard or
 *   YOLO curve may reach the editor (YOLO with its mark, `ImportResult.yolo`), a rejected one
 *   never;
 * - every export (`.txt`, S5, `.bin`) and `#p=` link carries a standard or YOLO curve, never a
 *   rejected one. A YOLO export is marked: `-yolo` in the file name (`fileName`) and a header
 *   comment in `.txt` (the EqualizerAPO parser drops `#` comments). S1 and S5 carry no marker:
 *   the class is always derived from the curve;
 * - imported names are untrusted: normalised by core `normalizeText`, length-capped and always
 *   rendered as text by the components (never as HTML).
 */
import { EqualizerApoError, parseEqualizerApo, serializeEqualizerApo } from 'open-auri/io';
import {
	decodeS1,
	encodeS1,
	EnvelopeError,
	envelopeFormat,
	normalizeLabels,
	normalizeText,
	parseEnvelope,
	S1Error,
	serializeEnvelope
} from 'open-auri/share';
import { m } from '#lib/paraglide/messages.js';
import type { Layer, UrlLike } from './layers.ts';
import { hasExperimental, verdictFor, type Band, type Curve } from './model.ts';
import type { Reason } from './reasons.ts';
import { classOf, exitRefusal } from './yolo.ts';

export const NAME_MAX = 48;
export const LINK_PREFIX = '#p=';
export const S5_FORMAT = 'open-auri/preset@1';
/** Emitted when the curve has a filter label or a band above 20 kHz; `@1` otherwise. */
export const S5_FORMAT_LABELS = 'open-auri/preset@2';
/** Highest frequency outside Engenharia (and the S1 v1 range). */
export const AUDIBLE_MAX_HZ = 20000;

/**
 * The S5 format and `labels` field for a curve: `@2` with the normalized labels when at least
 * one is set, or when a band is above 20 kHz (core `envelopeFormat`: an S1 v2 curve), else `@1`
 * without the key (byte-identical to an `@1` export). Labels refused by the core rules are
 * dropped here (entry by entry), never published.
 */
export function s5Labels(
	labels: unknown,
	bands?: readonly Band[]
): {
	format: typeof S5_FORMAT | typeof S5_FORMAT_LABELS;
	labels?: (string | null)[];
} {
	const normalized = normalizeLabels(labels, { lenient: true });
	const format =
		envelopeFormat({ bands, labels: normalized }) === S5_FORMAT_LABELS
			? S5_FORMAT_LABELS
			: S5_FORMAT;
	return normalized ? { format, labels: normalized } : { format };
}

/** Whether a band (not OFF) sits above 20 kHz: Engenharia only. */
export function hasUltrasonic(bands: readonly Band[]): boolean {
	return bands.some((band) => band.kind !== 'OFF' && band.freqHz > AUDIBLE_MAX_HZ);
}

export type IoError =
	| 'format'
	| 'too-many'
	| 'experimental-layer'
	| 'ultrasonic-layer'
	| 'gate'
	| 'link'
	| 'envelope'
	| 'grid';

export type IoFailure = { ok: false; error: IoError; reasons: Reason[]; detail?: string };
export interface ImportedCurve extends Curve {
	readonly name: string | null;
	readonly bands: Band[];
	/** Filter labels of an `open-auri/preset@2` file; never from `.txt` or `#p=` links. */
	readonly labels?: (string | null)[] | null;
}
/** A YOLO curve's mark: the codes the YOLO profile waived. */
export interface YoloMark {
	readonly waived: readonly string[];
}
export type ImportResult =
	| {
			ok: true;
			curve: ImportedCurve;
			warnings: number;
			/** Set when the curve is YOLO (loaded with the notice, protected while YOLO is off). */
			yolo?: YoloMark | null;
	  }
	| IoFailure;
/** `yolo`: the curve left as a YOLO curve (mark the file name; `.txt` has the header). */
export type ExportResult<T> = { ok: true; value: T; yolo: boolean } | IoFailure;
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

/** A rejected curve about to leave the editor (class 1, or a preamp below −25,5 dB). */
function refusedByGate(curve: Curve): IoFailure | null {
	const refused = exitRefusal(curve);
	return refused === null ? null : fail('gate', [...refused.reasons]);
}

/** Engenharia-only content (HS/LP/HP, a band above 20 kHz) outside Engenharia, or null. */
function layerRefusal(bands: readonly Band[], layer: Layer): IoFailure | null {
	if (layer === 'engenharia') return null;
	if (hasExperimental(bands)) return fail('experimental-layer');
	if (hasUltrasonic(bands)) return fail('ultrasonic-layer');
	return null;
}

/**
 * Layer rules and class for anything coming from outside the editor: a standard curve is
 * admitted, a YOLO curve too with its mark (`yolo`), a rejected curve never.
 */
export function admit(curve: ImportedCurve, layer: Layer): ImportResult {
	const layered = layerRefusal(curve.bands, layer);
	if (layered) return layered;
	const refused = refusedByGate(curve);
	if (refused) return refused;
	const classification = classOf(curve);
	return {
		ok: true,
		curve,
		warnings: 0,
		yolo: classification.class === 'yolo' ? { waived: classification.waived } : null
	};
}

/**
 * The `.txt` header of a YOLO curve: two `#` comment lines (EqualizerAPO ignores them, so does
 * the core parser) naming the waived codes.
 */
export function yoloTxtHeader(waived: readonly string[], lang: 'pt-BR' | 'en-US'): string {
	const codes = waived.length > 0 ? waived.join(', ') : '-';
	return [
		`# ${m.yolopub_txt_header_class({ codes }, { locale: lang })}`,
		`# ${m.yolopub_txt_header_unchecked({}, { locale: lang })}`,
		''
	].join('\n');
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

export function exportTxt(
	curve: Curve,
	layer: Layer,
	lang: 'pt-BR' | 'en-US' = 'pt-BR'
): ExportResult<string> {
	const layered = layerRefusal(curve.bands, layer);
	if (layered) return layered;
	let value: string;
	try {
		value = serializeEqualizerApo(curve);
	} catch (cause) {
		if (cause instanceof EqualizerApoError) return fail('format', [], cause.code);
		throw cause;
	}
	const refused = refusedByGate(curve);
	if (refused) return refused;
	const classification = classOf(curve);
	if (classification.class !== 'yolo') return { ok: true, value, yolo: false };
	return { ok: true, value: yoloTxtHeader(classification.waived, lang) + value, yolo: true };
}

function s1Of(curve: Curve): { ok: true; value: string } | IoFailure {
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
	const layered = layerRefusal(curve.bands, layer);
	if (layered) return layered;
	const code = s1Of(curve);
	if (!code.ok) return code;
	const refused = refusedByGate(curve);
	if (refused) return refused;
	const { format, labels } = s5Labels(meta.labels, curve.bands);
	try {
		return {
			ok: true,
			yolo: classOf(curve).class === 'yolo',
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

/**
 * The exact 220-byte payload a write would send, taken from the gate's own snapshot: the
 * standard verdict's for a standard curve, the YOLO verdict's for a YOLO curve (same codec).
 */
export function exportBin(curve: Curve): ExportResult<Uint8Array<ArrayBuffer>> {
	const refused = refusedByGate(curve);
	if (refused) return refused;
	const yolo = classOf(curve).class === 'yolo';
	const verdict = verdictFor(curve, yolo ? 'yolo' : 'standard');
	const payload = verdict.metrics.payload;
	if (!verdict.ok || !payload) return fail('gate', verdict.reasons);
	return { ok: true, value: Uint8Array.from(payload), yolo };
}

export function linkHash(curve: Curve, layer: Layer): ExportResult<string> {
	const layered = layerRefusal(curve.bands, layer);
	if (layered) return layered;
	const code = s1Of(curve);
	if (!code.ok) return code;
	const refused = refusedByGate(curve);
	if (refused) return refused;
	return { ok: true, value: `${LINK_PREFIX}${code.value}`, yolo: classOf(curve).class === 'yolo' };
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

/**
 * File names carry only a safe ASCII slug of the (untrusted) curve name; a YOLO curve's file
 * ends in `-yolo` before the extension.
 */
export function fileName(name: string, extension: 'txt' | 'json' | 'bin', yolo = false): string {
	const slug = name
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.replace(/[^\w-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase()
		.slice(0, 40);
	return `${slug || 'open-auri'}${yolo ? '-yolo' : ''}.${extension}`;
}
