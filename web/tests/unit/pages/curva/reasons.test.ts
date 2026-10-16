import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getLocale, overwriteGetLocale, setLocale } from '#lib/paraglide/runtime.js';
import {
	firstReasonText,
	REASON_CODES,
	REASON_MESSAGE_KEYS,
	reasonText,
	type Reason
} from '#lib/components/pages/curva/reasons.ts';
import { ioFailureText } from '#lib/components/pages/curva/io-text.ts';
import type { IoError } from '#lib/components/pages/curva/io.ts';
import pt from '../../../../messages/pt-BR.json';
import en from '../../../../messages/en-US.json';

const originalGetLocale = getLocale;

afterEach(() => {
	overwriteGetLocale(originalGetLocale);
	return setLocale('pt-BR', { reload: false });
});

for (const [locale, messages] of [
	['pt-BR', pt],
	['en-US', en]
] as const) {
	describe(`gate and IO explanations in ${locale}`, () => {
		beforeEach(async () => {
			await setLocale(locale, { reload: false });
			// Node has no browser locale strategies or request context. Use the runtime's
			// supported override so calls without an explicit locale exercise this language.
			overwriteGetLocale(() => locale);
			expect(getLocale()).toBe(locale);
		});

		test.each(REASON_CODES)('%s has its own explanation and uses a 1-based stage', (code) => {
			const reason: Reason = { code, stage: 7 };
			const expected = messages[REASON_MESSAGE_KEYS[code]].replaceAll('{stage}', '7');
			expect(reasonText(reason)).toBe(expected);
			expect(firstReasonText([reason, { code: 'g:preamp' }])).toBe(expected);
		});

		test.each([undefined, 1.5, NaN])('missing/noninteger stage %s is not invented', (stage) => {
			expect(reasonText({ code: 'a:b0', ...(stage === undefined ? {} : { stage }) })).toBe(
				messages.curva_reason_a_b0.replace('{stage}', '?')
			);
		});

		test('a gate with no reasons has an honest fallback', () => {
			expect(firstReasonText([])).toBe(messages.curva_reason_unknown);
			expect(ioFailureText({ ok: false, error: 'gate', reasons: [] })).toBe(
				messages.curva_reason_unknown
			);
			expect(ioFailureText({ ok: false, error: 'gate', reasons: [{ code: 'g:preamp' }] })).toBe(
				messages.curva_reason_g_preamp
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
