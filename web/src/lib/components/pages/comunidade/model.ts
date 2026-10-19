// Pure helpers of the Comunidade page (T4.13): feed items → channels, the S8 curve avatar, S4
// readouts, the Total Recall band diff, S5 envelopes, gate reasons and API error messages. All
// response math comes from the core (`open-auri/dsp`, `open-auri/share`); nothing here touches the
// DOM, the audio engine or the cable.
import { curveResponseDb, distance, GRID } from 'open-auri/dsp';
import {
	decodeS1,
	encodeS1,
	envelopeFormat,
	normalizeLabels,
	validateEnvelope
} from 'open-auri/share';
import { yoloPublishBlock, yoloPublishText } from '#lib/components/yolo/yolo-curve.ts';
import { curveClassification } from '#lib/gate-verdicts.ts';
import { REASON_MESSAGE_KEYS } from '#lib/cable/checklist.ts';
import type { ReasonCode } from '#lib/cable/types.ts';
import { responseGeometry } from '#lib/charts/response.ts';
import { dbScale, linePath, logScale, type PlotBox } from '#lib/charts/scales.ts';
import { describeReason, formatNumber } from '#lib/components/cable/i18n.ts';
import { m } from '#lib/paraglide/messages.js';
import { isSocialApiError, type FeedPage } from '#lib/social/index.ts';
import type { ReportReason } from '#lib/server/social/types.ts';

export type FeedItem = FeedPage['items'][number];
export type License = 'CC0-1.0' | 'CC-BY-4.0';
export type Visibility = 'private' | 'unlisted' | 'public';
export type Lang = 'pt-BR' | 'en-US';
export type FeedSortKey = 'new' | 'favorites' | 'installs';
export type FeedWindowKey = '7d' | '30d' | 'all';

type Decoded = ReturnType<typeof decodeS1>;
export type Band = Decoded['bands'][number];

/** A decoded curve: what the charts, the S4 distance and the audio chains take. */
export interface DecodedCurve {
	preampDb: number;
	/** Read-only: editor curves (frozen snapshots) and decoded S1 curves both fit. */
	bands: readonly Readonly<Band>[];
}

export interface Author {
	username: string;
	displayUsername: string;
}

/** One channel strip of the console: a published lineage at its head version. */
export interface Channel {
	lineageId: string;
	versionId: string;
	curveId: string;
	s1: string;
	name: string;
	description: string;
	license: License;
	lang: string;
	author: Author | null;
	rank: number | null;
	score: number | null;
	/** Null when the S1 does not decode (the strip stays listed, without audio or chart). */
	curve: DecodedCurve | null;
	/** The head is a YOLO curve (server class; only in the `yolo=only` list): shows the badge. */
	yolo?: boolean;
}

/**
 * Whether a channel's curve is a YOLO curve: its class, derived from its own bands (core
 * `classifyCurve` rules, cached, gate-verdicts.ts), never a stored marker. Writing it to the cable
 * needs the YOLO checklist (`requestWrite(curve, { profile: 'yolo' })`).
 */
export function channelIsYolo(curve: DecodedCurve): boolean {
	return curveClassification(curve.bands, curve.preampDb).class === 'yolo';
}

/**
 * "Ativar Modo YOLO": the channel's curve in the editor's Engenharia layer (`?camada=engenharia`),
 * with its origin (`l`/`v`, checked against the S1 there), where Modo YOLO can be turned on.
 */
export function yoloHref(channel: Pick<Channel, 'lineageId' | 'versionId' | 's1'>): string {
	return `/?camada=engenharia&l=${encodeURIComponent(channel.lineageId)}&v=${encodeURIComponent(channel.versionId)}#p=${channel.s1}`;
}

/** What the page needs from the social session (`createSocialSession`). */
export interface SessionView {
	readonly known: boolean;
	readonly signedIn: boolean;
	readonly verified: boolean;
	readonly nickname: string | null;
}

/** Consent text version accepted by `POST /api/v1/s6/batches` (server `S6_CONSENT_VERSION`). */
export const S6_CONSENT_VERSION = 's6-consent-v1';
/** Turnstile widget actions checked by the server (`TURNSTILE_ACTIONS`). */
export const TURNSTILE_REPORT_ACTION = 'report';
export const TURNSTILE_S6_ACTION = 's6-submit';
export const REPORT_REASONS: readonly ReportReason[] = [
	'dangerous',
	'spam',
	'offensive',
	'copyright',
	'impersonation',
	'other'
];
export const FEED_SORTS: readonly FeedSortKey[] = ['new', 'favorites', 'installs'];
export const FEED_WINDOWS: readonly FeedWindowKey[] = ['7d', '30d', 'all'];
export const FEED_PAGE_SIZE = 24;
/** Pack text limits (server `NAME_MAX`/`DESCRIPTION_MAX`, `#lib/server/social/types.ts`). */
export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 1000;
// S5 envelope limits in code points (src/share/envelope.mjs:403-404, `validateEnvelope`; the core
// does not export them): a longer published name or description is always refused.
export const S5_NAME_MAX = 48;
export const S5_DESCRIPTION_MAX = 280;
export const NOTE_MAX = 500;
/** Local copies of the S6 receipts (the only way to withdraw an anonymous batch). */
export const S6_RECEIPTS_KEY = 'oa.social.s6.receipts';

// ---- Curves -------------------------------------------------------------------------------------

export function decodeCurve(s1: string): DecodedCurve | null {
	try {
		const decoded = decodeS1(s1);
		return { preampDb: decoded.preampDb, bands: decoded.bands };
	} catch (error) {
		console.warn(
			JSON.stringify({
				event: 'comunidade.decode_failed',
				error: error instanceof Error ? error.name : 'unknown'
			})
		);
		return null;
	}
}

/** The S1 of the editor curve, or null when it cannot be encoded. */
export function encodeCurve(curve: DecodedCurve): string | null {
	try {
		return encodeS1({ preampDb: curve.preampDb, bands: curve.bands });
	} catch (error) {
		console.warn(
			JSON.stringify({
				event: 'comunidade.encode_failed',
				error: error instanceof Error ? error.name : 'unknown'
			})
		);
		return null;
	}
}

function isLicense(value: string): value is License {
	return value === 'CC0-1.0' || value === 'CC-BY-4.0';
}

export function channelOf(item: FeedItem): Channel {
	const { lineage } = item;
	return {
		lineageId: lineage.id,
		versionId: lineage.head.id,
		curveId: lineage.curve.id,
		s1: lineage.curve.s1,
		name: lineage.head.name,
		description: lineage.head.description,
		license: isLicense(lineage.head.license) ? lineage.head.license : 'CC-BY-4.0',
		lang: lineage.head.lang,
		author: lineage.author
			? { username: lineage.author.username, displayUsername: lineage.author.displayUsername }
			: null,
		rank: item.rank,
		score: item.score,
		curve: decodeCurve(lineage.curve.s1),
		yolo: lineage.curve.yolo === true
	};
}

export function licenseShort(license: License): string {
	return license === 'CC0-1.0' ? 'CC0' : 'CC-BY 4.0';
}

export function profileHref(author: Author): string {
	return `/u/${encodeURIComponent(author.username)}`;
}

// ---- S8 avatar ----------------------------------------------------------------------------------

/** FNV-1a 32-bit of the S1 text: the avatar hue, identical for identical bytes. */
export function avatarHue(s1: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < s1.length; i++) {
		hash ^= s1.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % 360;
}

/**
 * Closed polar path of the response (0 dB on radius `r0`, clockwise from the top, 20 Hz → 20 kHz):
 * the curve itself as its identity (S8). Values are clamped to −15…+10 dB.
 */
export function avatarPath(curve: DecodedCurve, points = 96, r0 = 17, k = 0.95): string {
	const response = curveResponseDb(curve, GRID);
	const last = response.length - 1;
	let path = '';
	for (let j = 0; j <= points; j++) {
		const value = response[Math.round((j / points) * last)] ?? 0;
		const angle = -Math.PI / 2 + (j / points) * 2 * Math.PI;
		const radius = r0 + Math.max(-15, Math.min(10, value)) * k;
		path += `${j === 0 ? 'M' : 'L'}${(Math.cos(angle) * radius).toFixed(2)} ${(Math.sin(angle) * radius).toFixed(2)}`;
	}
	return `${path}Z`;
}

/** Read-only knob summary: output level at 100 Hz (bass) and 8 kHz (treble), in dB. */
export function knobSummary(curve: DecodedCurve): { bass: number; treble: number } {
	const [bass = 0, treble = 0] = curveResponseDb(curve, [100, 8000]);
	return { bass, treble };
}

/** Knob cap angle (−135°…+135°) for a value in −12…+12 dB. */
export function knobAngle(db: number): number {
	return Math.max(-1, Math.min(1, db / 12)) * 135;
}

// ---- S4 and the master scope --------------------------------------------------------------------

export interface S4Reading {
	rmsDb: number;
	maxDb: number;
	maxFreqHz: number;
}

/** S4 distance (level matched in 300 Hz–3 kHz, core `distance`). */
export function s4(a: DecodedCurve, b: DecodedCurve): S4Reading | null {
	try {
		const result = distance(a, b);
		return { rmsDb: result.rmsDb, maxDb: result.maxDb, maxFreqHz: result.maxFreqHz };
	} catch (error) {
		console.warn(
			JSON.stringify({
				event: 'comunidade.s4_failed',
				error: error instanceof Error ? error.name : 'unknown'
			})
		);
		return null;
	}
}

export const SCOPE_BOX: PlotBox = { left: 40, top: 12, width: 706, height: 260 };

export function scopePath(curve: DecodedCurve, minDb: number, maxDb: number): string {
	return responseGeometry(curve, SCOPE_BOX, minDb, maxDb).outputPath;
}

export function scopeScales(minDb: number, maxDb: number) {
	return {
		x: logScale(20, 20000, SCOPE_BOX.left, SCOPE_BOX.left + SCOPE_BOX.width),
		y: dbScale(minDb, maxDb, SCOPE_BOX.top + SCOPE_BOX.height, SCOPE_BOX.top)
	};
}

// ---- Total Recall -------------------------------------------------------------------------------

export interface BandRow {
	index: number;
	a: Band | null;
	b: Band | null;
	changed: boolean;
}

function sameBand(a: Band | null, b: Band | null): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function bandRows(a: DecodedCurve, b: DecodedCurve): BandRow[] {
	const size = Math.max(a.bands.length, b.bands.length);
	const rows: BandRow[] = [];
	for (let index = 0; index < size; index++) {
		const left = a.bands[index] ?? null;
		const right = b.bands[index] ?? null;
		rows.push({ index, a: left, b: right, changed: !sameBand(left, right) });
	}
	return rows;
}

/** "PK 1 000 Hz +3,0 dB Q 1,41" with the locale's decimal separator. */
export function bandText(band: Band | null): string {
	if (band === null || band.kind === 'OFF') return 'OFF';
	const freq = formatNumber(band.freqHz, 0);
	const q = formatNumber(band.qFactor, 2);
	const gain = band.gainDb;
	if (band.kind === 'LP' || band.kind === 'HP' || typeof gain !== 'number') {
		return `${band.kind} ${freq} Hz Q ${q}`;
	}
	return `${band.kind} ${freq} Hz ${formatNumber(gain, 1, true)} dB Q ${q}`;
}

/** Response difference b − a (no level matching: a restore is an exact copy). */
export function responseDelta(a: DecodedCurve, b: DecodedCurve): S4Reading | null {
	try {
		const result = distance(b, a, { levelMatch: false });
		return { rmsDb: result.rmsDb, maxDb: result.maxDb, maxFreqHz: result.maxFreqHz };
	} catch (error) {
		console.warn(
			JSON.stringify({
				event: 'comunidade.delta_failed',
				error: error instanceof Error ? error.name : 'unknown'
			})
		);
		return null;
	}
}

export function deltaPath(
	a: DecodedCurve,
	b: DecodedCurve,
	width = 420,
	height = 110,
	rangeDb = 6
): string {
	const left = curveResponseDb(a, GRID);
	const right = curveResponseDb(b, GRID);
	const x = logScale(20, 20000, 4, width - 4);
	const y = dbScale(-rangeDb, rangeDb, height - 6, 6);
	return linePath(
		GRID.map((freq, i) => {
			const diff = (right[i] ?? 0) - (left[i] ?? 0);
			return { x: x(freq), y: y(Math.max(-rangeDb, Math.min(rangeDb, diff))) };
		})
	);
}

// ---- S5 envelope --------------------------------------------------------------------------------

export interface EnvelopeDraft {
	name: string;
	description: string;
	license: License;
	lang: Lang;
	s1: string;
	recipe?: unknown;
	/** Filter labels by wire index of `s1`: any set label makes the envelope preset@2. */
	labels?: readonly (string | null)[] | null;
	now: number;
}

export type EnvelopeCheck =
	{ ok: true; envelope: Record<string, unknown>; json: string } | { ok: false; codes: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The S5 envelope of a curve, validated by the core: open-auri/preset@2 with its filter labels
 * when it has any, open-auri/preset@1 otherwise. The bands and preamp are the decoded S1, so
 * `code` and `bands` always agree (same rule as the server's fork path).
 */
export function buildEnvelope(draft: EnvelopeDraft): EnvelopeCheck {
	let decoded: Decoded;
	try {
		decoded = decodeS1(draft.s1);
	} catch {
		return { ok: false, codes: ['env:s1'] };
	}
	const labels = normalizeLabels(draft.labels ?? null, { lenient: true });
	const raw: Record<string, unknown> = {
		// preset@2 with filter labels or a band above 20 kHz (an S1 v2 curve); @1 otherwise.
		format: envelopeFormat({ bands: decoded.bands, labels }),
		name: draft.name,
		description: draft.description,
		source: 'custom',
		license: draft.license,
		code: draft.s1,
		preampDb: decoded.preampDb,
		bands: decoded.bands,
		...(labels ? { labels } : {}),
		lang: draft.lang,
		createdAt: new Date(draft.now).toISOString()
	};
	if (isPlainObject(draft.recipe)) raw.recipe = draft.recipe;
	const checked = validateEnvelope(raw);
	if (!checked.ok) return { ok: false, codes: [...new Set(checked.errors.map((e) => e.code))] };
	const envelope: Record<string, unknown> = { ...checked.value };
	return { ok: true, envelope, json: JSON.stringify(envelope, null, 2) };
}

/** Localized message of a core envelope issue code (`env:*`, `s1:*`). */
export function envelopeIssueText(code: string): string {
	switch (code) {
		case 'env:url':
		case 'env:url-like':
			return m.comunidade_env_url();
		case 'env:length':
		case 'env:required':
			return m.comunidade_env_length();
		default:
			return m.comunidade_env_invalid();
	}
}

// ---- Gate reasons and API errors ----------------------------------------------------------------

function isReasonCode(code: string): code is ReasonCode {
	return Object.hasOwn(REASON_MESSAGE_KEYS, code);
}

/** The same localized gate messages as the cable checklist. */
export function gateReasonText(code: string): string {
	if (!isReasonCode(code)) return m.cable_reason_unknown();
	return describeReason({
		code,
		messageKey: REASON_MESSAGE_KEYS[code],
		stage: null,
		value: null,
		limit: null
	});
}

function detailStrings(error: unknown, key: string): string[] {
	if (!isSocialApiError(error)) return [];
	const details: unknown = error.details;
	if (!isPlainObject(details)) return [];
	const list: unknown = details[key];
	return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

/** Gate reason codes of a `GATE_REJECTED` answer. */
export function gateReasonsOf(error: unknown): string[] {
	return detailStrings(error, 'reasons');
}

/** Core codes of an `INVALID_CURVE` answer. */
export function curveCodesOf(error: unknown): string[] {
	return detailStrings(error, 'codes');
}

export function isUnreachable(error: unknown): boolean {
	return isSocialApiError(error) && error.unreachable;
}

/** Localized message of any social failure, by code (never `details` verbatim). */
export function errorText(error: unknown): string {
	if (!isSocialApiError(error)) return m.comunidade_error_generic();
	// YOLO publication rules (migration 0013): the step, the kill switch, the account age.
	const yolo = yoloPublishBlock(error);
	if (yolo === 'ack') return m.yolopub_error_ack();
	if (yolo !== null) return yoloPublishText(yolo);
	switch (error.code) {
		case 'OFFLINE':
		case 'NETWORK':
			return m.comunidade_offline();
		case 'AUTH_REQUIRED':
			return m.comunidade_login_prompt();
		case 'EMAIL_NOT_VERIFIED':
			return m.comunidade_verify_prompt();
		case 'BANNED':
			return m.comunidade_error_banned();
		case 'FORBIDDEN':
		case 'NOT_FOUND':
		case 'GONE':
			return m.comunidade_error_not_found();
		case 'RATE_LIMITED':
		case 'QUOTA_EXCEEDED':
		case 'RATE_LIMIT_UNAVAILABLE':
			return m.comunidade_error_rate();
		case 'TURNSTILE_FAILED':
			return m.comunidade_error_turnstile();
		case 'HEAD_MOVED':
			return m.comunidade_recall_head_moved();
		case 'GATE_REJECTED':
			return m.comunidade_gate_rejected();
		case 'INVALID_CURVE':
			return m.comunidade_env_invalid();
		case 'CONSENT_REQUIRED':
			return m.comunidade_s6_consent_required();
		case 'ALREADY_ACTIVE':
			return m.comunidade_s7_already_active();
		case 'DUPLICATE':
			return m.comunidade_error_duplicate();
		default:
			return m.comunidade_error_generic();
	}
}

// ---- S6 receipts --------------------------------------------------------------------------------

/** 32 random bytes as unpadded base64url (43 characters): the bearer secret of a batch. */
export function newReceipt(
	random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) =>
		crypto.getRandomValues(bytes)
): string {
	const bytes = random(new Uint8Array(new ArrayBuffer(32)));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export interface StoredReceipt {
	receipt: string;
	/** Epoch ms of the send (local only). */
	at: number;
	pairs: number;
}

export interface ReceiptStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const RECEIPT = /^[A-Za-z0-9_-]{43}$/;

export function readReceipts(storage: ReceiptStorage | null): StoredReceipt[] {
	if (!storage) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(storage.getItem(S6_RECEIPTS_KEY) ?? '[]');
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: StoredReceipt[] = [];
	for (const item of parsed) {
		if (!isPlainObject(item)) continue;
		const { receipt, at, pairs } = item;
		if (typeof receipt !== 'string' || !RECEIPT.test(receipt)) continue;
		if (typeof at !== 'number' || !Number.isFinite(at)) continue;
		if (typeof pairs !== 'number' || !Number.isInteger(pairs)) continue;
		out.push({ receipt, at, pairs });
	}
	return out;
}

export function writeReceipts(storage: ReceiptStorage | null, receipts: StoredReceipt[]): boolean {
	if (!storage) return false;
	try {
		storage.setItem(S6_RECEIPTS_KEY, JSON.stringify(receipts));
		return true;
	} catch (error) {
		console.warn(
			JSON.stringify({
				event: 'comunidade.receipts_write',
				error: error instanceof Error ? error.name : 'unknown'
			})
		);
		return false;
	}
}

export function browserStorage(): ReceiptStorage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch (error) {
		console.warn(
			JSON.stringify({
				event: 'comunidade.storage',
				error: error instanceof Error ? error.name : 'unknown'
			})
		);
		return null;
	}
}

// ---- Formatting ---------------------------------------------------------------------------------

export function formatDate(ms: number, locale: string): string {
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
		new Date(ms)
	);
}

export function formatDb(value: number, digits = 2): string {
	return `${formatNumber(value, digits)} dB`;
}

export function formatSignedDb(value: number, digits = 1): string {
	return `${formatNumber(value, digits, true)} dB`;
}

export function formatHz(value: number): string {
	return value >= 1000 ? `${formatNumber(value / 1000, 2)} kHz` : `${formatNumber(value, 0)} Hz`;
}

/** Absolute URL of a server-relative path, in the browser only. */
export function absoluteUrl(path: string): string {
	const origin = typeof location === 'undefined' ? '' : location.origin;
	return `${origin}${path}`;
}
