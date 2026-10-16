// T4.13: pure helpers of the Comunidade page (node).
import { describe, expect, test } from 'vitest';
import { decodeS1 } from 'open-auri/share';
import {
	avatarHue,
	avatarPath,
	bandRows,
	buildEnvelope,
	channelOf,
	decodeCurve,
	errorText,
	gateReasonText,
	gateReasonsOf,
	newReceipt,
	readReceipts,
	writeReceipts,
	S6_RECEIPTS_KEY,
	type FeedItem
} from '#lib/components/pages/comunidade/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { SocialApiError } from '#lib/social/index.ts';
import { S1_BOOST, S1_NEUTRAL, feedItem } from './fixtures.ts';

describe('channels and the S8 avatar', () => {
	test('a feed item becomes a channel with its decoded curve', () => {
		const channel = channelOf(feedItem({ s1: S1_BOOST }) as unknown as FeedItem);
		expect(channel.lineageId).toBe('lin-aaaaaaaaaaaa');
		expect(channel.versionId).toBe('ver-lin-aaaaaaaaaaaa');
		expect(channel.curve?.preampDb).toBe(decodeS1(S1_BOOST).preampDb);
	});

	test('an undecodable S1 keeps the channel without a curve', () => {
		const channel = channelOf(feedItem({ s1: 'nope' }) as unknown as FeedItem);
		expect(channel.curve).toBeNull();
	});

	test('the avatar is a pure function of the S1', () => {
		const a = decodeCurve(S1_NEUTRAL);
		const b = decodeCurve(S1_BOOST);
		expect(a && b).toBeTruthy();
		if (!a || !b) return;
		expect(avatarHue(S1_NEUTRAL)).toBe(avatarHue(S1_NEUTRAL));
		expect(avatarHue(S1_NEUTRAL)).not.toBe(avatarHue(S1_BOOST));
		expect(avatarPath(a)).toBe(avatarPath(a));
		expect(avatarPath(a)).not.toBe(avatarPath(b));
		expect(avatarPath(a)).toMatch(/^M.*Z$/);
	});

	test('bandRows marks only the bands that changed', () => {
		const a = decodeCurve(S1_NEUTRAL);
		const b = decodeCurve(S1_BOOST);
		if (!a || !b) throw new Error('fixture');
		const rows = bandRows(a, b);
		expect(rows.filter((row) => row.changed).map((row) => row.index)).toEqual([0]);
	});
});

describe('S5 envelope', () => {
	test('builds a valid envelope whose bands are the decoded S1', () => {
		const result = buildEnvelope({
			name: 'Minha curva',
			description: '',
			license: 'CC0-1.0',
			lang: 'pt-BR',
			s1: S1_BOOST,
			now: Date.UTC(2026, 9, 16)
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.envelope).toMatchObject({
			format: 'open-auri/preset@1',
			code: S1_BOOST,
			license: 'CC0-1.0'
		});
		expect(String(result.envelope.createdAt)).toMatch(/^2026-10-16T00:00:00/);
		expect(JSON.parse(result.json)).toEqual(result.envelope);
	});

	test('refuses links in the name and an empty name', () => {
		const base = { description: '', license: 'CC-BY-4.0' as const, lang: 'pt-BR' as const };
		const url = buildEnvelope({ ...base, name: 'veja https://x.example', s1: S1_NEUTRAL, now: 0 });
		expect(url.ok).toBe(false);
		const bad = buildEnvelope({ ...base, name: 'ok', s1: 'not-s1', now: 0 });
		expect(bad).toEqual({ ok: false, codes: ['env:s1'] });
	});
});

describe('gate reasons and errors', () => {
	test('reason codes use the checklist messages; unknown codes say so', () => {
		expect(gateReasonText('g:preamp')).toBe(m.cable_reason_g_preamp());
		expect(gateReasonText('nope')).toBe(m.cable_reason_unknown());
	});

	test('GATE_REJECTED reasons are read from details; other data is ignored', () => {
		const error = new SocialApiError(422, 'GATE_REJECTED', { reasons: ['c:section-peak', 3] });
		expect(gateReasonsOf(error)).toEqual(['c:section-peak']);
		expect(gateReasonsOf(new Error('x'))).toEqual([]);
		expect(errorText(error)).toBe(m.comunidade_gate_rejected());
		expect(errorText(new SocialApiError(0, 'OFFLINE'))).toBe(m.comunidade_offline());
		expect(errorText(new TypeError('x'))).toBe(m.comunidade_error_generic());
	});
});

describe('S6 receipts', () => {
	test('a receipt is 32 random bytes in unpadded base64url', () => {
		const receipt = newReceipt((bytes) => bytes.fill(255));
		expect(receipt).toHaveLength(43);
		expect(receipt).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
		expect(newReceipt()).not.toBe(newReceipt());
	});

	test('stored receipts round-trip and garbage is dropped', () => {
		const data = new Map<string, string>();
		const storage = {
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => void data.set(key, value)
		};
		const receipt = newReceipt();
		expect(writeReceipts(storage, [{ receipt, at: 5, pairs: 2 }])).toBe(true);
		expect(readReceipts(storage)).toEqual([{ receipt, at: 5, pairs: 2 }]);
		data.set(S6_RECEIPTS_KEY, JSON.stringify([{ receipt: 'short', at: 1, pairs: 1 }, 'x']));
		expect(readReceipts(storage)).toEqual([]);
		data.set(S6_RECEIPTS_KEY, '{not json');
		expect(readReceipts(storage)).toEqual([]);
		expect(readReceipts(null)).toEqual([]);
	});
});
