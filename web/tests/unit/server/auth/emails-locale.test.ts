// FX3.1 (Q3-9): e-mail locale of the auth mails.
import { describe, expect, it } from 'vitest';
import {
	emailLocaleFromHeaders,
	emailLocaleFromRequest,
	withEmailLocale
} from '#lib/server/auth/emails.ts';

describe('e-mail locale', () => {
	it('ignores a malformed oa_lang cookie instead of throwing', () => {
		expect(emailLocaleFromHeaders(new Headers({ cookie: 'oa_lang=%' }))).toBe('pt-BR');
		expect(
			emailLocaleFromHeaders(new Headers({ cookie: 'oa_lang=%E0%A4%A', 'accept-language': 'en' }))
		).toBe('en-US');
		expect(emailLocaleFromHeaders(new Headers({ cookie: 'oa_lang=en-US' }))).toBe('en-US');
		expect(emailLocaleFromHeaders(null)).toBe('pt-BR');
	});

	it('uses the withEmailLocale scope for calls without a request, the request otherwise', async () => {
		expect(emailLocaleFromRequest(undefined)).toBe('pt-BR');
		const inside = await withEmailLocale('en-US', async () => {
			await Promise.resolve();
			return [
				emailLocaleFromRequest(undefined),
				emailLocaleFromRequest(
					new Request('https://auri.example/', { headers: { cookie: 'oa_lang=pt-BR' } })
				)
			];
		});
		expect(inside).toEqual(['en-US', 'pt-BR']);
		expect(emailLocaleFromRequest(undefined)).toBe('pt-BR');
	});
});
