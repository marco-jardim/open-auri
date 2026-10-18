/**
 * Functional names for the ten filter sections (bank modules and scope handles): what each band
 * does to the curve, read from its kind, frequency and gain. Pure: the copy arrives as `BandWords`
 * (built from the messages in `band-labels.svelte.ts`), so this module never reads a locale.
 *
 * Rules
 * - Region of the band's frequency (Hz), lower bound inclusive:
 *   Sub < 60 ≤ Grave < 250 ≤ Corpo < 800 ≤ Médio < 2500 ≤ Presença < 6000 ≤ Brilho < 12000 ≤ Ar.
 * - PK: region and "+" (boost) or "−" (cut). LS, HS: region of the corner and "↑" or "↓".
 *   A gain within ±0.05 dB is flat: the region alone.
 * - HP, LP: "Corte {freq}" ("Corte 30 Hz", "Corte 12k"); the detail says which side is cut
 *   ("Corte de graves (HP)", "Corte de agudos (LP)").
 * - OFF: "Livre", never suffixed.
 * - Two or more equal automatic names get " a", " b", " c"… in slot order.
 * - A custom label (trimmed, inner spaces collapsed, at most 16 characters) replaces the
 *   automatic name; it takes no part in the suffixes.
 * - Badge: the slot letter, A to J. Slot order is the processing order ("estágio N").
 * Automatic names stay within 12 characters (14 with a suffix) in both locales.
 */
import { formatNumber } from './format.ts';
import type { Band, BandKind } from './model.ts';

/** Longest custom label (characters, not UTF-16 units). */
export const LABEL_MAX = 16;
/** A gain this close to 0 dB is drawn and named as flat. */
const FLAT_DB = 0.05;

export const REGIONS = ['sub', 'bass', 'body', 'mids', 'presence', 'brilliance', 'air'] as const;
export type Region = (typeof REGIONS)[number];
/** Upper bound (exclusive) of every region but the last. */
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
	return 'air';
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

/**
 * A custom label as stored: inner whitespace collapsed, trimmed, cut to `LABEL_MAX` characters;
 * empty means "back to the automatic name" (null).
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
