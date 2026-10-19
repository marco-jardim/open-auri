// OG card (T4.7): a pure, deterministic 1200×630 SVG. Same input → byte-identical string.
// "Before" is the flat 0 dB reference (dashed), "after" is the curve's EQ response computed by the
// core (`curveResponseDb`, never re-implemented here). Every text is cleaned (bidi controls,
// characters XML 1.0 forbids), truncated by code points and XML-escaped. No external reference:
// no <image>, no href, no URL from user data. Colours: Biblioteca theme tokens
// (web/src/lib/styles/tokens.css and accents.css `[data-page='biblioteca']`).
//
// No author on the card (FX4.3): the PNG is stored in R2 and cached by browsers and CDNs, so a
// nickname baked into it would outlive a rename or an account deletion (LGPD). The card carries
// only the version name, its license, the curves and the open-auri mark. Any layout change must
// bump OG_CARD_VERSION in ./keys.ts so stored images of the old layout are replaced.
import { curveResponseDb, logGrid } from 'open-auri/dsp';
import { decodeS1 } from 'open-auri/share';
import type { Lang } from '#lib/server/social/types.ts';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Font families of the files in web/static/og-font/ (see render.ts). */
export const OG_SERIF = 'Instrument Serif';
export const OG_MONO = 'JetBrains Mono';

/** Biblioteca tokens: --ink, --ink-2, --text, --muted, accent of [data-page='biblioteca']. */
export const OG_COLORS = {
	ink: '#0f0f0e',
	ink2: '#171715',
	text: '#ece7dd',
	muted: '#8f8a80',
	accent: '#d9a441'
} as const;

export const NAME_MAX_CHARS = 36;

const PLOT = { x: 80, y: 262, w: 1040, h: 268 } as const;
const MIN_HZ = 20;
const MAX_HZ = 20_000;
/** Fixed plotting grid (log-spaced, 20 Hz–20 kHz); part of the determinism contract. */
const OG_GRID: readonly number[] = Object.freeze(logGrid(241, MIN_HZ, MAX_HZ));
const DB_STEP = 6;
const DB_MAX_RANGE = 24;

const LABELS = {
	'pt-BR': { before: 'antes', after: 'depois' },
	'en-US': { before: 'before', after: 'after' }
} as const;

export interface OgSvgInput {
	/** Version name (already normalized at publication; cleaned again here). */
	name: string;
	license: string;
	/** S1 string of the version's curve (v1 or v2: bands above 20 kHz fall off the 20 kHz plot). */
	s1: string;
	lang: Lang;
	/** The curve is YOLO (server class): the card shows a "YOLO" chip after the mark. */
	yolo?: boolean;
}

/** The "YOLO" chip of a YOLO curve: an outlined pill next to the open-auri mark. */
export const OG_YOLO_CHIP = { x: 250, y: 66, w: 104, h: 42, label: 'YOLO' } as const;

function yoloChip(): string {
	const { x, y, w, h, label } = OG_YOLO_CHIP;
	const { accent } = OG_COLORS;
	return (
		`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="none" ` +
		`stroke="${accent}" stroke-width="3"/>\n` +
		text(x + w / 2, y + 30, label, { family: OG_MONO, size: 24, fill: accent, anchor: 'middle' })
	);
}

// Bidi embeddings/overrides/isolates and marks: they could reorder the card's text.
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
// Anything outside the XML 1.0 Char production (C0 controls, lone surrogates, U+FFFE/U+FFFF).
const XML_FORBIDDEN = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

/** Drops bidi controls and XML-forbidden characters, collapses whitespace, trims. */
export function cleanText(text: string): string {
	return text.replace(BIDI_CONTROLS, '').replace(XML_FORBIDDEN, '').replace(/\s+/g, ' ').trim();
}

/** At most `max` code points; longer text ends with an ellipsis (counted in `max`). */
export function truncate(text: string, max: number): string {
	const points = Array.from(text);
	if (points.length <= max) return text;
	return `${points
		.slice(0, Math.max(0, max - 1))
		.join('')
		.trimEnd()}…`;
}

/** Escapes the five XML special characters (text nodes and attribute values). */
export function escapeXml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function safeText(text: string, max: number): string {
	return escapeXml(truncate(cleanText(text), max));
}

/** Fixed one-decimal formatting without `-0.0`. */
function num(value: number): string {
	const text = (Math.round(value * 10) / 10).toFixed(1);
	return text === '-0.0' ? '0.0' : text;
}

function xOf(hz: number): number {
	return PLOT.x + (PLOT.w * Math.log(hz / MIN_HZ)) / Math.log(MAX_HZ / MIN_HZ);
}

/** EQ response of the curve on the OG grid (bands only: the preamp is headroom, not shape). */
export function ogResponseDb(s1: string): number[] {
	const { bands } = decodeS1(s1);
	return curveResponseDb({ bands, preampDb: 0 }, OG_GRID);
}

/** Symmetric dB range: the peak rounded up to 6 dB steps, between 6 and 24 dB. */
export function dbRange(response: readonly number[]): number {
	let peak = 0;
	for (const db of response) if (Number.isFinite(db)) peak = Math.max(peak, Math.abs(db));
	return Math.min(DB_MAX_RANGE, Math.max(DB_STEP, Math.ceil(peak / DB_STEP) * DB_STEP));
}

function curvePoints(response: readonly number[], range: number): string {
	const mid = PLOT.y + PLOT.h / 2;
	return response
		.map((db, i) => {
			const clamped = Number.isFinite(db) ? Math.max(-range, Math.min(range, db)) : 0;
			const x = xOf(OG_GRID[i] ?? MAX_HZ);
			const y = mid - (clamped / range) * (PLOT.h / 2);
			return `${num(x)},${num(y)}`;
		})
		.join(' ');
}

function text(
	x: number,
	y: number,
	content: string,
	attrs: { family: string; size: number; fill: string; anchor?: 'start' | 'middle' | 'end' }
): string {
	const anchor = attrs.anchor ?? 'start';
	return (
		`<text x="${num(x)}" y="${num(y)}" font-family="${attrs.family}" font-size="${attrs.size}" ` +
		`fill="${attrs.fill}" text-anchor="${anchor}">${content}</text>`
	);
}

/** The OG card. Throws the core's S1Error when `s1` does not decode (stored curves always do). */
export function ogSvg(input: OgSvgInput): string {
	const labels = LABELS[input.lang];
	const response = ogResponseDb(input.s1);
	const range = dbRange(response);
	const name = safeText(input.name, NAME_MAX_CHARS);
	const license = safeText(input.license, 16);
	const { ink, ink2, text: fg, muted, accent } = OG_COLORS;
	const top = PLOT.y;
	const mid = PLOT.y + PLOT.h / 2;
	const bottom = PLOT.y + PLOT.h;
	const right = PLOT.x + PLOT.w;
	const mono = { family: OG_MONO, size: 20, fill: muted };

	const parts: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">`,
		`<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="${ink}"/>`,
		`<rect x="40" y="40" width="1120" height="550" rx="6" fill="${ink2}" stroke="${muted}" stroke-opacity="0.35"/>`,
		text(80, 98, 'open-auri', { family: OG_MONO, size: 28, fill: accent }),
		...(input.yolo === true ? [yoloChip()] : []),
		text(1120, 98, license, { family: OG_MONO, size: 22, fill: muted, anchor: 'end' }),
		text(80, 182, name, { family: OG_SERIF, size: 64, fill: fg })
	];

	// Frequency grid: decades with labels.
	for (const [hz, label] of [
		[100, '100'],
		[1000, '1k'],
		[10_000, '10k']
	] as const) {
		const x = num(xOf(hz));
		parts.push(
			`<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${muted}" stroke-opacity="0.25" stroke-width="1"/>`,
			text(xOf(hz), bottom + 28, label, { ...mono, anchor: 'middle' })
		);
	}
	parts.push(
		`<rect x="${PLOT.x}" y="${top}" width="${PLOT.w}" height="${PLOT.h}" fill="none" stroke="${muted}" stroke-opacity="0.35"/>`,
		text(PLOT.x, bottom + 28, '20 Hz', mono),
		text(right, bottom + 28, '20 kHz', { ...mono, anchor: 'end' }),
		text(right - 8, top + 24, `+${range} dB`, { ...mono, anchor: 'end' }),
		text(right - 8, bottom - 10, `\u2212${range} dB`, { ...mono, anchor: 'end' }),
		// Before: flat 0 dB reference.
		`<line x1="${PLOT.x}" y1="${num(mid)}" x2="${right}" y2="${num(mid)}" stroke="${muted}" stroke-width="2" stroke-dasharray="10 8"/>`,
		// After: the curve.
		`<polyline points="${curvePoints(response, range)}" fill="none" stroke="${accent}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`,
		// Legend.
		`<line x1="760" y1="${top - 22}" x2="800" y2="${top - 22}" stroke="${muted}" stroke-width="2" stroke-dasharray="10 8"/>`,
		text(810, top - 15, escapeXml(labels.before), mono),
		`<line x1="930" y1="${top - 22}" x2="970" y2="${top - 22}" stroke="${accent}" stroke-width="4" stroke-linecap="round"/>`,
		text(980, top - 15, escapeXml(labels.after), mono),
		'</svg>'
	);
	return parts.join('\n');
}
