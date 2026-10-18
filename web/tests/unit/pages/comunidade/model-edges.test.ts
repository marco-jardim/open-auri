import { afterEach, expect, test, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { SocialApiError } from '#lib/social/index.ts';
import {
	absoluteUrl,
	avatarHue,
	bandRows,
	bandText,
	browserStorage,
	buildEnvelope,
	channelOf,
	curveCodesOf,
	encodeCurve,
	envelopeIssueText,
	formatDb,
	formatHz,
	formatSignedDb,
	errorText,
	gateReasonsOf,
	isUnreachable,
	knobAngle,
	knobSummary,
	licenseShort,
	profileHref,
	readReceipts,
	responseDelta,
	s4,
	writeReceipts,
	type DecodedCurve,
	type FeedItem
} from '#lib/components/pages/comunidade/model.ts';
import { NEUTRAL, S1_NEUTRAL, feedItem } from './fixtures.ts';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test('missing author and an unknown license retain a usable, safely linked channel', () => {
	const channel = channelOf(feedItem({ author: null, license: 'unknown' }) as unknown as FeedItem);
	expect(channel.author).toBeNull();
	expect(channel.license).toBe('CC-BY-4.0');
	expect(licenseShort(channel.license)).toBe('CC-BY 4.0');
	expect(licenseShort('CC0-1.0')).toBe('CC0');
	expect(profileHref({ username: 'a/b ?#', displayUsername: 'ignored' })).toBe('/u/a%2Fb%20%3F%23');
	expect(avatarHue('')).toBe(0x811c9dc5 % 360);
});

test('encoding rejects invalid shapes rather than exposing an unusable share code', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	expect(encodeCurve(NEUTRAL)).toBe(S1_NEUTRAL);
	expect(encodeCurve({ preampDb: NaN, bands: [] })).toBeNull();
	expect(warn).toHaveBeenCalledWith(expect.stringContaining('comunidade.encode_failed'));
});

test('knobs clamp their endpoints and a flat curve reads its preamp as the output level', () => {
	expect([-100, -12, 0, 12, 100].map(knobAngle)).toEqual([-135, -135, 0, 135, 135]);
	// knobSummary is the OUTPUT level at 100 Hz / 8 kHz (model.ts:178), so the preamp counts:
	// Neutro is flat at −0.5 dB, and only a 0 dB preamp reads exactly zero.
	const neutral = knobSummary(NEUTRAL);
	expect(neutral.bass).toBeCloseTo(NEUTRAL.preampDb, 6);
	expect(neutral.treble).toBeCloseTo(NEUTRAL.preampDb, 6);
	const unity = knobSummary({ ...NEUTRAL, preampDb: 0 });
	expect(unity.bass).toBeCloseTo(0, 6);
	expect(unity.treble).toBeCloseTo(0, 6);
	expect(formatHz(999)).toContain('999 Hz');
	expect(formatHz(1000)).toMatch(/^1[,.]00 kHz$/);
	expect(formatDb(0)).toMatch(/^0[,.]00 dB$/);
	expect(formatSignedDb(3)).toMatch(/^\+3[,.]0 dB$/);
});

test('band comparisons include added and removed bands, including empty curves', () => {
	const off = { kind: 'OFF' as const };
	const short: DecodedCurve = { preampDb: 0, bands: [] };
	const long: DecodedCurve = { preampDb: 0, bands: [off] };
	expect(bandRows(short, short)).toEqual([]);
	expect(bandRows(short, long)).toEqual([{ index: 0, a: null, b: off, changed: true }]);
	expect(bandRows(long, short)).toEqual([{ index: 0, a: off, b: null, changed: true }]);
	expect(bandText(null)).toBe('OFF');
	expect(bandText(off)).toBe('OFF');
	expect(bandText({ kind: 'LP', freqHz: 1000, qFactor: 0.7 })).toMatch(/^LP .* Hz Q 0[,.]70$/);
	expect(bandText({ kind: 'HP', freqHz: 20, qFactor: 1 })).toMatch(/^HP 20 Hz Q 1[,.]00$/);
	expect(bandText({ kind: 'PK', freqHz: 100, qFactor: 1, gainDb: -3 })).toMatch(/−3[,.]0 dB/);
});

test('level matching removes a constant offset, but an exact restore diff keeps it', () => {
	const a = { preampDb: 0, bands: NEUTRAL.bands };
	const b = { preampDb: -6, bands: NEUTRAL.bands };
	expect(s4(a, b)?.rmsDb).toBeCloseTo(0, 8);
	expect(responseDelta(a, b)?.rmsDb).toBeCloseTo(6, 8);
});

test.each([new TypeError('unavailable curve'), 'unavailable curve'])(
	'failed DSP readings degrade to null (%s)',
	(error) => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const broken: DecodedCurve = {
			preampDb: 0,
			get bands(): DecodedCurve['bands'] {
				throw error;
			}
		};
		expect(s4(broken, NEUTRAL)).toBeNull();
		expect(responseDelta(NEUTRAL, broken)).toBeNull();
		expect(encodeCurve(broken)).toBeNull();
		expect(warn.mock.calls.map(([message]) => JSON.parse(String(message)).event)).toEqual([
			'comunidade.s4_failed',
			'comunidade.delta_failed',
			'comunidade.encode_failed'
		]);
	}
);

test.each([
	['env:url', m.comunidade_env_url],
	['env:url-like', m.comunidade_env_url],
	['env:length', m.comunidade_env_length],
	['env:required', m.comunidade_env_length],
	['s1:unknown', m.comunidade_env_invalid]
] as const)('envelope issue %s is localized', (code, message) => {
	expect(envelopeIssueText(code)).toBe(message());
});

test('envelope validation accepts the S5 boundary lengths and ignores non-object recipes', () => {
	// S5 limits come from the core (src/share/envelope.mjs:403-404 and :205): name 1–48 code
	// points, description 0–280 code points in at most five lines.
	const draft = {
		name: 'N'.repeat(48),
		description: 'D'.repeat(280),
		license: 'CC0-1.0' as const,
		lang: 'en-US' as const,
		s1: S1_NEUTRAL,
		now: Date.UTC(2026, 9, 17)
	};
	for (const recipe of [undefined, null, [], 'not a recipe']) {
		const result = buildEnvelope({ ...draft, recipe });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.codes.join(','));
		expect(result.envelope).not.toHaveProperty('recipe');
		expect(result.envelope.name).toHaveLength(48);
		expect(result.envelope.description).toHaveLength(280);
	}
	expect(buildEnvelope({ ...draft, description: 'a\nb\nc\nd\ne' }).ok).toBe(true);
	// One past each boundary (and the empty name) is a length issue, reported once.
	for (const over of [
		{ name: 'N'.repeat(49) },
		{ name: '' },
		{ description: 'D'.repeat(281) },
		{ description: 'a\nb\nc\nd\ne\nf' },
		{ name: '', description: 'D'.repeat(281) }
	]) {
		expect(buildEnvelope({ ...draft, ...over })).toEqual({ ok: false, codes: ['env:length'] });
	}
});

test.each([
	['NETWORK', m.comunidade_offline],
	['AUTH_REQUIRED', m.comunidade_login_prompt],
	['EMAIL_NOT_VERIFIED', m.comunidade_verify_prompt],
	['BANNED', m.comunidade_error_banned],
	['FORBIDDEN', m.comunidade_error_not_found],
	['NOT_FOUND', m.comunidade_error_not_found],
	['GONE', m.comunidade_error_not_found],
	['RATE_LIMITED', m.comunidade_error_rate],
	['QUOTA_EXCEEDED', m.comunidade_error_rate],
	['RATE_LIMIT_UNAVAILABLE', m.comunidade_error_rate],
	['TURNSTILE_FAILED', m.comunidade_error_turnstile],
	['HEAD_MOVED', m.comunidade_recall_head_moved],
	['INVALID_CURVE', m.comunidade_env_invalid],
	['CONSENT_REQUIRED', m.comunidade_s6_consent_required],
	['ALREADY_ACTIVE', m.comunidade_s7_already_active],
	['DUPLICATE', m.comunidade_error_duplicate],
	['INTERNAL', m.comunidade_error_generic]
] as const)(
	'API code %s exposes a safe localized message, not private details',
	(code, message) => {
		expect(errorText(new SocialApiError(400, code, { private: 'do not show' }))).toBe(message());
	}
);

test('error details must be plain objects with arrays of strings', () => {
	for (const details of [undefined, null, [], 'x', { reasons: 'g:preamp' }]) {
		expect(gateReasonsOf(new SocialApiError(422, 'GATE_REJECTED', details))).toEqual([]);
	}
	expect(
		curveCodesOf(new SocialApiError(422, 'INVALID_CURVE', { codes: [false, 'env:length', null] }))
	).toEqual(['env:length']);
	expect(isUnreachable(new Error('network'))).toBe(false);
	expect(isUnreachable(new SocialApiError(0, 'NETWORK'))).toBe(true);
	expect(isUnreachable(new SocialApiError(403, 'FORBIDDEN'))).toBe(false);
});

test('receipt parsing rejects missing and wrongly typed fields but preserves zero values', () => {
	const receipt = 'a'.repeat(43);
	const getItem = vi.fn(() =>
		JSON.stringify([
			null,
			[],
			0,
			{},
			{ receipt: 5 },
			{ receipt, at: '0', pairs: 0 },
			{ receipt, at: null, pairs: 0 },
			{ receipt, at: 0, pairs: '0' },
			{ receipt, at: 0, pairs: 1.5 },
			{ receipt, at: 0, pairs: 0 }
		])
	);
	expect(readReceipts({ getItem, setItem: vi.fn() })).toEqual([{ receipt, at: 0, pairs: 0 }]);
	expect(readReceipts({ getItem: () => '{}', setItem: vi.fn() })).toEqual([]);
	expect(readReceipts({ getItem: () => null, setItem: vi.fn() })).toEqual([]);
	expect(writeReceipts(null, [])).toBe(false);
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	for (const error of [new Error('quota'), 'blocked']) {
		expect(
			writeReceipts(
				{
					getItem,
					setItem: () => {
						throw error;
					}
				},
				[]
			)
		).toBe(false);
	}
});

test('browser-only helpers degrade without globals and use the available origin and storage', () => {
	vi.stubGlobal('localStorage', undefined);
	vi.stubGlobal('location', undefined);
	expect(browserStorage()).toBeNull();
	expect(absoluteUrl('/c/example')).toBe('/c/example');
	const storage = { getItem: vi.fn(), setItem: vi.fn() };
	vi.stubGlobal('localStorage', storage);
	vi.stubGlobal('location', { origin: 'https://example.test' });
	expect(browserStorage()).toBe(storage);
	expect(absoluteUrl('/c/example')).toBe('https://example.test/c/example');
});
