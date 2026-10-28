import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { getLocale, overwriteServerAsyncLocalStorage } from '#lib/paraglide/runtime.js';
import {
	describeOutcome,
	describeReason,
	formatCheckedAt,
	formatCrc,
	formatNumber,
	lampLabel,
	lampState,
	lastGoodNotice,
	queueStatus,
	refusalText
} from '#lib/components/cable/i18n.ts';
import type { ReasonMessageKey, ReasonView } from '#lib/cable/types.ts';
import { writtenOutcome } from './outcomes.ts';

// Unit tests run in Node: cookie/localStorage setLocale strategies cannot select an SSR locale.
// Use the same request-scoped locale boundary as the server, without mocking the formatter.
const requestLocale = new AsyncLocalStorage<{ locale?: 'pt-BR' | 'en-US' }>();

beforeEach(() => {
	overwriteServerAsyncLocalStorage(requestLocale);
});

afterEach(() => {
	overwriteServerAsyncLocalStorage(undefined);
});

test.each([
	['pt-BR', '−1,25', '+1,3', '0,0'],
	['en-US', '−1.25', '+1.3', '0.0']
] as const)(
	'formats signed decimals in the server request locale %s',
	(locale, negative, positive, zero) =>
		requestLocale.run({ locale }, () => {
			expect(getLocale()).toBe(locale);
			expect(formatNumber(-1.25, 2)).toBe(negative);
			expect(formatNumber(1.25, 1, true)).toBe(positive);
			expect(formatNumber(0, 1, true)).toBe(zero);
			expect(formatNumber(2)).toBe(locale === 'pt-BR' ? '2,0' : '2.0');
			expect(formatCrc(0)).toBe('0x0000');
			expect(formatCrc(0xabcd)).toBe('0xABCD');
		})
);

test.each(['pt-BR', 'en-US'] as const)(
	'all cable status and refusal lookups have localized copy in %s',
	(locale) =>
		requestLocale.run({ locale }, () => {
			for (const key of ['cable_connect_hint', 'cable_connect_no_selection'] as const) {
				expect(m[key]().trim().length).toBeGreaterThan(0);
				expect(m[key]()).not.toBe(key);
			}
			for (const [lookup, prefix] of [
				[lampLabel, ''],
				[lampState, 'cable_lamp_state_'],
				[queueStatus, 'cable_queue_status_'],
				[refusalText, 'cable_refused_']
			] as const) {
				for (const [key, text] of Object.entries(lookup)) {
					const messageKey = `${prefix}${key.replaceAll('-', '_')}`;
					const translated = text();
					expect(translated.trim().length, messageKey).toBeGreaterThan(0);
					// English copy can equal its enum value (e.g. 'writing', 'sent', 'simulated').
					// A missing translation instead falls back to the full Paraglide message key.
					expect(translated, messageKey).not.toBe(messageKey);
				}
			}
			for (const reason of Object.keys(refusalText) as (keyof typeof refusalText)[]) {
				expect(describeOutcome({ status: 'refused', reason })).toBe(refusalText[reason]());
			}
			const items = (Object.keys(queueStatus) as (keyof typeof queueStatus)[]).map((status) => ({
				deviceLabel: `Cable ${status}`,
				status,
				entry: null
			}));
			expect(describeOutcome({ status: 'done', simulated: false, items })).toBe(
				items.map((item) => `${item.deviceLabel}: ${queueStatus[item.status]()}`).join('; ')
			);
			expect(describeOutcome({ status: 'done', simulated: true, items: [] })).toBe('');
		})
);

const reasonKeys: ReasonMessageKey[] = [
	'cable_reason_a_b0',
	'cable_reason_a_b2',
	'cable_reason_a_neg_a1',
	'cable_reason_a_b1',
	'cable_reason_a_neg_a2',
	'cable_reason_b_pole_radius',
	'cable_reason_c_section_peak',
	'cable_reason_d_prefix_peak',
	'cable_reason_d_prefix_peak_extended',
	'cable_reason_e_output_audible',
	'cable_reason_e_output_extended',
	'cable_reason_e_output_full',
	'cable_reason_f_codec',
	'cable_reason_g_preamp',
	'cable_reason_k_kind_not_allowed',
	'cable_reason_d7_pk_boost_above_16k',
	'cable_reason_d7_boost_q',
	'cable_reason_d7_boost_above_20k',
	'cable_reason_unknown'
];

test.each(['pt-BR', 'en-US'] as const)(
	'written outcomes distinguish real, simulated and interrupted writes in %s',
	(locale) =>
		requestLocale.run({ locale }, () => {
			expect(describeOutcome(writtenOutcome('ok'))).toBe(m.cable_result_ok({ crc: '0x4FFF' }));
			expect(describeOutcome(writtenOutcome('simulated'))).toBe(
				m.cable_result_simulated({ crc: '0x4FFF' })
			);
			expect(describeOutcome(writtenOutcome('interrupted'))).toBe(m.cable_result_interrupted());
		})
);

test.each([
	['pt-BR', 'Servidor indisponível: usando a última confirmação desta versão ('],
	['en-US', "Server unavailable: using this version's last confirmation ("]
] as const)(
	'a native write on the last-good confirmation adds a neutral, dated notice in %s',
	(locale, prefix) =>
		requestLocale.run({ locale }, () => {
			const checkedAt = Date.UTC(2026, 9, 1, 12, 0, 0);
			const date = new Intl.DateTimeFormat(locale, {
				dateStyle: 'short',
				timeStyle: 'short'
			}).format(checkedAt);
			expect(formatCheckedAt(checkedAt)).toBe(date);
			const notice = m.cable_native_last_good_dated({ date });
			expect(notice.startsWith(prefix)).toBe(true);
			expect(notice).toContain(date);
			// It no longer claims there is no connection: a server error or a timeout shows it too.
			expect(notice).not.toMatch(/conexão|connection/i);
			const offline = { basis: 'last-good' as const, checkedAt };
			const written = { ...writtenOutcome('ok'), freshness: offline };
			expect(lastGoodNotice(written)).toBe(notice);
			expect(describeOutcome(written)).toBe(`${m.cable_result_ok({ crc: '0x4FFF' })} ${notice}`);
			const items = [{ deviceLabel: 'Cable 1', status: 'ok' as const, entry: null }];
			const queue = { status: 'done' as const, simulated: false, items, freshness: offline };
			expect(describeOutcome(queue)).toBe(`Cable 1: ${queueStatus.ok()} ${notice}`);
			// A live check, a desktop write or a refusal shows no notice.
			const live = { ...writtenOutcome('ok'), freshness: { basis: 'live' as const, checkedAt } };
			expect(lastGoodNotice(live)).toBeNull();
			expect(describeOutcome(live)).toBe(m.cable_result_ok({ crc: '0x4FFF' }));
			expect(lastGoodNotice(writtenOutcome('ok'))).toBeNull();
			expect(lastGoodNotice({ status: 'refused', reason: 'error' })).toBeNull();
		})
);

test.each(['pt-BR', 'en-US'] as const)(
	'the last-good notice never throws on a date Intl cannot format in %s',
	(locale) =>
		requestLocale.run({ locale }, () => {
			// Intl fails: the ISO form is shown instead.
			const iso = new Date(Date.UTC(2026, 9, 1, 12, 0, 0));
			const format = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
				throw new RangeError('Incorrect locale information provided');
			});
			try {
				expect(formatCheckedAt(iso.getTime())).toBe(iso.toISOString());
				const written = {
					...writtenOutcome('ok'),
					freshness: { basis: 'last-good' as const, checkedAt: iso.getTime() }
				};
				expect(lastGoodNotice(written)).toBe(
					m.cable_native_last_good_dated({ date: iso.toISOString() })
				);
			} finally {
				format.mockRestore();
			}
			// No date at all (past the last valid Date, or not a number): the notice omits it.
			for (const checkedAt of [8.64e15 + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
				expect(formatCheckedAt(checkedAt)).toBeNull();
				const written = {
					...writtenOutcome('ok'),
					freshness: { basis: 'last-good' as const, checkedAt }
				};
				expect(() => describeOutcome(written)).not.toThrow();
				expect(lastGoodNotice(written)).toBe(m.cable_native_last_good_undated());
				expect(describeOutcome(written)).toBe(
					`${m.cable_result_ok({ crc: '0x4FFF' })} ${m.cable_native_last_good_undated()}`
				);
			}
		})
);

test.each(['pt-BR', 'en-US'] as const)(
	'reason descriptions include only available diagnostic details in %s',
	(locale) =>
		requestLocale.run({ locale }, () => {
			for (const messageKey of reasonKeys) {
				const reason: ReasonView = {
					code: 'a:b0',
					messageKey,
					stage: null,
					value: null,
					limit: null
				};
				const plain = describeReason(reason);
				expect(plain.length).toBeGreaterThan(0);
				expect(plain).not.toContain('cable_reason_');
				expect(describeReason({ ...reason, stage: 0, value: -1.25, limit: 0 })).toBe(
					`${m.cable_reason_stage({ stage: '0' })}: ${plain} (${m.cable_reason_value_limit({
						value: formatNumber(-1.25, 2),
						limit: formatNumber(0, 2)
					})})`
				);
				expect(describeReason({ ...reason, value: 1 })).toBe(plain);
				expect(describeReason({ ...reason, limit: 1 })).toBe(plain);
			}
		})
);

test('concurrent SSR requests keep their decimal locale across asynchronous work', async () => {
	const formatted = await Promise.all(
		(['pt-BR', 'en-US'] as const).map((locale) =>
			requestLocale.run({ locale }, async () => {
				await Promise.resolve();
				return { locale: getLocale(), decimal: formatNumber(-1.25, 2) };
			})
		)
	);
	expect(formatted).toEqual([
		{ locale: 'pt-BR', decimal: '−1,25' },
		{ locale: 'en-US', decimal: '−1.25' }
	]);
});
