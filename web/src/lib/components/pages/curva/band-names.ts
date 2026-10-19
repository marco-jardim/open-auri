/**
 * Functional names for the ten filter sections (bank modules and scope handles): what each band
 * does to the curve, read from its kind, frequency and gain. Pure: the copy arrives as `BandWords`
 * (built from the messages in `band-labels.svelte.ts`), so this module never reads a locale.
 *
 * Rules
 * - Region of the band's frequency (Hz), lower bound inclusive:
 *   Sub < 60 ≤ Grave < 250 ≤ Corpo < 800 ≤ Médio < 2500 ≤ Presença < 6000 ≤ Brilho < 12000 ≤ Ar
 *   ≤ 20000 < Ultra (above the audible band, Engenharia and Modo YOLO only; "Ultra" in both
 *   locales).
 * - PK: region and "+" (boost) or "−" (cut). LS, HS: region of the corner and "↑" or "↓".
 *   A gain within ±0.05 dB is flat: the region alone.
 * - HP, LP: "Corte {freq}" ("Corte 30 Hz", "Corte 12k", "Corte 25k"); the detail says which side
 *   is cut ("Corte de graves (HP)", "Corte de agudos (LP)").
 * - OFF: "Livre", never suffixed.
 * - Two or more equal automatic names get " a", " b", " c"… in slot order.
 * - A custom label (the S5 `@2` label rules of core `normalizeLabels`: at most `LABEL_MAX`, 24,
 *   code points) replaces the automatic name; it takes no part in the suffixes. A rename is
 *   checked strictly (`checkLabel`): a refused name is reported, never stored or cut. Narrow
 *   strips show a long label shortened by an ellipsis (CSS); the stored label is whole.
 * - Badge: the slot letter, A to J. Slot order is the processing order ("estágio N").
 * Automatic names stay within 12 characters (14 with a suffix) in both locales.
 */
import { AUDIBLE_MAX_HZ } from 'open-auri/safety';
import {
	EnvelopeError,
	LABEL_COUNT,
	LABEL_MAX as CORE_LABEL_MAX,
	normalizeLabels
} from 'open-auri/share';
import { formatNumber } from './format.ts';
import type { Band, BandKind } from './model.ts';

/**
 * Longest custom label, in code points (not UTF-16 units): the core S5 `@2` limit, the one limit
 * of the rename field, the stored labels, imports and exports.
 */
export const LABEL_MAX = CORE_LABEL_MAX;
/** A gain this close to 0 dB is drawn and named as flat. */
const FLAT_DB = 0.05;

export const REGIONS = [
	'sub',
	'bass',
	'body',
	'mids',
	'presence',
	'brilliance',
	'air',
	'ultra'
] as const;
export type Region = (typeof REGIONS)[number];
/** Top (inclusive) of Ar: above it a band is `ultra` (core `AUDIBLE_MAX_HZ`). */
const AIR_MAX_HZ = AUDIBLE_MAX_HZ;
/** Upper bound (exclusive) of every region below Ar. */
const REGION_TOP: readonly [Region, number][] = [
	['sub', 60],
	['bass', 250],
	['body', 800],
	['mids', 2500],
	['presence', 6000],
	['brilliance', 12000]
];

export interface BandWords {
	readonly locale: string;
	readonly regions: Readonly<Record<Region, string>>;
	/** OFF ("Livre"). */
	readonly free: string;
	/** Short HP/LP name around the cutoff ("Corte {freq}"). */
	readonly cut: (freq: string) => string;
	/** HP detail ("Corte de graves"). */
	readonly lowCut: string;
	/** LP detail ("Corte de agudos"). */
	readonly highCut: string;
}

export interface BandName {
	/** Slot letter, A to J. */
	readonly badge: string;
	/** Automatic short name, with its collision suffix. */
	readonly auto: string;
	/** What the UI shows: the custom label, else `auto`. */
	readonly label: string;
	readonly custom: boolean;
	/** The automatic name with the band's shape, e.g. "Grave ↑ (LS)", "Corte de agudos (LP)". */
	readonly detail: string;
}

export function badgeOf(index: number): string {
	return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

export function regionOf(freqHz: number): Region {
	for (const [region, top] of REGION_TOP) if (freqHz < top) return region;
	return freqHz > AIR_MAX_HZ ? 'ultra' : 'air';
}

/** "30 Hz", "999 Hz", "1k", "2,2k" (pt-BR) or "2.2k" (en-US), "12k". */
export function shortHz(freqHz: number, locale: string): string {
	const hz = Math.round(freqHz);
	if (hz < 1000) return `${hz} Hz`;
	const tenths = Math.round(hz / 100);
	const digits = tenths < 100 && tenths % 10 !== 0 ? 1 : 0;
	return `${formatNumber(digits ? tenths / 10 : Math.round(hz / 1000), locale, digits)}k`;
}

function signed(kind: BandKind, gainDb: number): string {
	if (Math.abs(gainDb) < FLAT_DB) return '';
	if (kind === 'PK') return gainDb > 0 ? ' +' : ' \u2212';
	return gainDb > 0 ? ' \u2191' : ' \u2193';
}

/** Automatic name before suffixes, and its detail line. */
function baseName(band: Band, words: BandWords): { name: string; detail: string } {
	switch (band.kind) {
		case 'OFF':
			return { name: words.free, detail: words.free };
		case 'HP':
		case 'LP':
			return {
				name: words.cut(shortHz(band.freqHz, words.locale)),
				detail: `${band.kind === 'HP' ? words.lowCut : words.highCut} (${band.kind})`
			};
		case 'PK':
		case 'LS':
		case 'HS': {
			const name = `${words.regions[regionOf(band.freqHz)]}${signed(band.kind, band.gainDb)}`;
			return { name, detail: name };
		}
	}
}

/** Envelope codes a refused label can have (core `normalizeLabels`, strict). */
export type LabelIssue = 'env:url' | 'env:url-like' | 'env:length' | 'env:pattern';
export type LabelCheck =
	| { readonly ok: true; readonly label: string | null }
	| { readonly ok: false; readonly issues: readonly LabelIssue[] };

function labelIssue(code: string): LabelIssue {
	return code === 'env:url' || code === 'env:url-like' || code === 'env:length'
		? code
		: 'env:pattern';
}

/**
 * One label through the strict S5 `@2` rules (core `normalizeLabels`): NFKC, invisibles stripped,
 * whitespace collapsed; links (`env:url`), domain-like text (`env:url-like`), controls or text that
 * is not well-formed (`env:pattern`) and more than `LABEL_MAX` code points (`env:length`) are
 * refused with their envelope codes, in that order and once each. Empty means the automatic
 * name (null). Nothing is ever cut.
 */
export function checkLabel(raw: string | null | undefined): LabelCheck {
	const list = Array.from({ length: LABEL_COUNT }, (_, index) =>
		index === 0 ? (raw ?? '') : null
	);
	try {
		return { ok: true, label: normalizeLabels(list)?.[0] ?? null };
	} catch (error) {
		if (!(error instanceof EnvelopeError)) throw error;
		const issues = [...new Set(error.errors.map((issue) => labelIssue(issue.code)))];
		return { ok: false, issues: issues.length ? issues : ['env:pattern'] };
	}
}

/**
 * A custom label for display: inner whitespace collapsed, trimmed, at most `LABEL_MAX` code
 * points (stored labels already are: core `normalizeLabels`); empty means "back to the automatic
 * name" (null). Renames go through `checkLabel` first, so this never cuts a stored label.
 */
export function normalizeLabel(raw: string | null | undefined): string | null {
	const text = Array.from((raw ?? '').replace(/\s+/g, ' ').trim())
		.slice(0, LABEL_MAX)
		.join('')
		.trim();
	return text === '' ? null : text;
}

/** `labels` with slot `index` set to `name` (normalized); the input is never changed. */
export function withLabel(
	labels: readonly (string | null)[],
	index: number,
	name: string | null
): (string | null)[] {
	const length = Math.max(labels.length, index + 1);
	return Array.from({ length }, (_, i) =>
		i === index ? normalizeLabel(name) : (labels[i] ?? null)
	);
}

/** Names for every slot of `bands`, in slot order. */
export function bandNames(
	bands: readonly Band[],
	words: BandWords,
	labels: readonly (string | null)[] = []
): BandName[] {
	const custom = bands.map((_, index) => normalizeLabel(labels[index]));
	const bases = bands.map((band) => baseName(band, words));
	// Collisions among the automatic names that are shown (OFF and custom slots excluded).
	const counts = new Map<string, number>();
	bands.forEach((band, index) => {
		if (band.kind === 'OFF' || custom[index] !== null) return;
		const name = bases[index]?.name ?? '';
		counts.set(name, (counts.get(name) ?? 0) + 1);
	});
	const seen = new Map<string, number>();
	return bands.map((band, index) => {
		const base = bases[index] ?? { name: '', detail: '' };
		let auto = base.name;
		let detail = base.detail;
		if (band.kind !== 'OFF' && custom[index] === null && (counts.get(base.name) ?? 0) > 1) {
			const order = seen.get(base.name) ?? 0;
			seen.set(base.name, order + 1);
			const suffix = ` ${String.fromCharCode(97 + (order % 26))}`;
			auto = `${base.name}${suffix}`;
			if (band.kind !== 'HP' && band.kind !== 'LP') detail = `${base.detail}${suffix}`;
		}
		if (band.kind === 'PK' || band.kind === 'LS' || band.kind === 'HS') {
			detail = `${detail} (${band.kind})`;
		}
		const label = custom[index];
		return {
			badge: badgeOf(index),
			auto,
			label: label ?? auto,
			custom: label !== null,
			detail
		};
	});
}
