import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { gateForWrite } from 'open-auri/safety';
import { getLocale, overwriteGetLocale, setLocale } from '#lib/paraglide/runtime.js';
import {
	bandOf,
	firstReasonText,
	REASON_CODES,
	REASON_MESSAGE_KEYS,
	reasonText,
	type Reason,
	type ReasonCode
} from '#lib/components/pages/curva/reasons.ts';
import { ioFailureText } from '#lib/components/pages/curva/io-text.ts';
import type { IoError } from '#lib/components/pages/curva/io.ts';
import type { Band } from '#lib/components/pages/curva/model.ts';
import pt from '../../../../messages/pt-BR.json';
import en from '../../../../messages/en-US.json';

const originalGetLocale = getLocale;

afterEach(() => {
	overwriteGetLocale(originalGetLocale);
	return setLocale('pt-BR', { reload: false });
});

const OFF: Band = { kind: 'OFF' };
/** Band 7 is a PK at 2.2 kHz; band 3 is OFF. */
const bands: Band[] = [
	{ kind: 'PK', freqHz: 100, gainDb: -2, qFactor: 1 },
	{ kind: 'LS', freqHz: 200, gainDb: -1, qFactor: 0.7 },
	OFF,
	{ kind: 'PK', freqHz: 500, gainDb: -3, qFactor: 1 },
	{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 },
	{ kind: 'PK', freqHz: 1500, gainDb: -3, qFactor: 1 },
	{ kind: 'PK', freqHz: 2200, gainDb: 3, qFactor: 2 },
	OFF,
	OFF,
	OFF
];

/** Reasons that point at one band (the gate gives a 1-based stage). */
const LOCATED = new Set<ReasonCode>([
	'a:b0',
	'a:b2',
	'a:-a1',
	'a:b1',
	'a:-a2',
	'b:pole-radius',
	'c:section-peak',
	'd:prefix-peak',
	'd:prefix-peak-full',
	'k:kind-not-allowed',
	'd7:pk-boost-above-16k',
	'd7:boost-q'
]);
const COEFFICIENT: Partial<Record<ReasonCode, string>> = {
	'a:b0': 'b0',
	'a:b2': 'b2',
	'a:-a1': '−a1',
	'a:b1': 'b1',
	'a:-a2': '−a2'
};

const fill = (text: string, values: Record<string, string>) =>
	text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);

for (const [locale, messages, freq] of [
	['pt-BR', pt, '2,2 kHz'],
	['en-US', en, '2.2 kHz']
] as const) {
	describe(`gate and IO explanations in ${locale}`, () => {
		beforeEach(async () => {
			await setLocale(locale, { reload: false });
			// Node has no browser locale strategies or request context. Use the runtime's
			// supported override so calls without an explicit locale exercise this language.
			overwriteGetLocale(() => locale);
			expect(getLocale()).toBe(locale);
		});

		test.each(REASON_CODES)('%s says what, where (band and frequency) and how to fix', (code) => {
			const reason: Reason = { code, stage: 7 };
			const where = fill(messages.curva_where_band, { index: '7', freq });
			const expected = fill(messages[REASON_MESSAGE_KEYS[code]], {
				where,
				coef: COEFFICIENT[code] ?? ''
			});
			const text = reasonText(reason, { bands });
			expect(text).toBe(expected);
			expect(firstReasonText([reason, { code: 'g:preamp' }], { bands })).toBe(expected);
			expect(text).not.toMatch(/[?{}—]/);
			if (LOCATED.has(code)) expect(text.startsWith(where)).toBe(true);
			else expect(text).not.toContain(where);
		});

		test.each([undefined, 0, 1.5, 11, NaN])(
			'a missing or invalid stage %s never shows a placeholder',
			(stage) => {
				const reason: Reason = {
					code: 'd:prefix-peak',
					...(stage === undefined ? {} : { stage })
				};
				expect(bandOf(reason)).toBeNull();
				const text = reasonText(reason, { bands });
				expect(text).toBe(
					fill(messages.curva_why_prefix_peak, { where: messages.curva_where_any })
				);
				expect(text).not.toMatch(/[?{}]/);
			}
		);

		test('without the curve, or on an OFF band, the band is named without a frequency', () => {
			const bare = fill(messages.curva_where_band_bare, { index: '3' });
			for (const context of [{}, { bands }]) {
				expect(reasonText({ code: 'c:section-peak', stage: 3 }, context)).toBe(
					fill(messages.curva_why_section_peak, { where: bare })
				);
			}
		});

		test('a real prefix refusal from the gate names the first band over the limit', () => {
			const counterexample: Band[] = [
				{ kind: 'PK', freqHz: 100, gainDb: -1, qFactor: 1 },
				{ kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 },
				{ kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 },
				...Array.from({ length: 7 }, () => OFF)
			];
			const verdict = gateForWrite(counterexample, -0.5);
			const text = firstReasonText(verdict.reasons, { bands: counterexample });
			expect(text).toBe(
				fill(messages.curva_why_prefix_peak, {
					where: fill(messages.curva_where_band, { index: '2', freq: '1 kHz' })
				})
			);
		});

		test('a gate with no reasons has an honest fallback', () => {
			expect(firstReasonText([])).toBe(messages.curva_reason_unknown);
			expect(ioFailureText({ ok: false, error: 'gate', reasons: [] })).toBe(
				messages.curva_reason_unknown
			);
			expect(ioFailureText({ ok: false, error: 'gate', reasons: [{ code: 'g:preamp' }] })).toBe(
				messages.curva_why_preamp
			);
			// A newer worker may send a code that this version of the UI does not recognise.
			expect(reasonText({ code: 'future:reason' } as unknown as Reason)).toBe(
				messages.curva_reason_unknown
			);
		});

		const failures = [
			['format', 'curva_io_error_format'],
			['too-many', 'curva_io_error_too_many'],
			['experimental-layer', 'curva_io_error_experimental'],
			['link', 'curva_io_error_link'],
			['envelope', 'curva_io_error_envelope'],
			['grid', 'curva_io_error_grid']
		] as const satisfies readonly (readonly [IoError, keyof typeof pt])[];
		test.each(failures)(
			'%s explains the failure without exposing raw parser detail',
			(error, key) => {
				expect(
					ioFailureText({ ok: false, error, reasons: [], detail: '<script>untrusted</script>' })
				).toBe(messages[key]);
			}
		);
	});
}
