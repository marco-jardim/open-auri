// Contract of the e-mail templates and helpers inside workerd (the unit suite snapshots the
// rendered output under Node; here the rules are asserted directly): every template in both
// locales, link and lifetime validation, text cleaning, message metadata and byte helpers.
import { describe, expect, it } from 'vitest';
import { fromBase64, timingSafeEqual, toBase64, toHex, utf8 } from '#lib/server/email/bytes.ts';
import {
	assertMessageMetadata,
	buildIdempotencyKey,
	EmailError,
	isEmailError,
	queueEmail,
	type EmailMessage
} from '#lib/server/email/index.ts';
import { deriveSuppressionKey } from '#lib/server/email/suppression.ts';
import {
	cleanText,
	escapeHtml,
	MAX_NAME_LENGTH,
	safeUrl
} from '#lib/server/email/templates/escape.ts';
import {
	renderTemplate,
	TEMPLATE_IDS,
	templates,
	type TemplateId
} from '#lib/server/email/templates/index.ts';
import { EMAIL_LOCALES, resolveEmailLocale } from '#lib/server/email/templates/layout.ts';

const ORIGIN = 'https://example.org';
const URL_OK = 'https://example.org/api/auth/verify-email?token=abc';

function dataFor(id: TemplateId) {
	const base = { origin: ORIGIN, name: 'Ana' };
	if (id === 'account-deleted') return base;
	if (id === 'email-change-notice' || id === 'password-changed') {
		return { ...base, url: `${ORIGIN}/esqueci-senha` };
	}
	return { ...base, url: URL_OK, expiresInMinutes: 60 };
}

function caught(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return null;
}

describe('templates', () => {
	it('render every template in both locales with subject, html, text and the action link', () => {
		const subjects = new Set<string>();
		for (const id of TEMPLATE_IDS) {
			for (const locale of EMAIL_LOCALES) {
				const rendered = renderTemplate(id, locale, dataFor(id) as never);
				expect(rendered.subject.length, `${id} ${locale}`).toBeGreaterThan(0);
				expect(rendered.html).toContain('<');
				expect(rendered.text).not.toContain('<p>');
				const data = dataFor(id) as { url?: string };
				if (data.url) expect(rendered.text).toContain(data.url);
				subjects.add(`${id}:${rendered.subject}`);
				expect(templates[id]).toBeTypeOf('function');
			}
		}
		expect(subjects.size).toBe(TEMPLATE_IDS.length * EMAIL_LOCALES.length);
	});

	it('formats link lifetimes in days, hours or minutes and rejects impossible ones', () => {
		const render = (minutes: number) =>
			renderTemplate('verify-email', 'en-US', {
				origin: ORIGIN,
				url: URL_OK,
				expiresInMinutes: minutes
			}).text;
		const day = render(24 * 60);
		const hours = render(120);
		const minutes = render(45);
		expect(new Set([day, hours, minutes]).size).toBe(3);
		expect(minutes).toContain('45');
		for (const bad of [0, -5, 1.5, 30 * 24 * 60 + 1, Number.NaN]) {
			const error = caught(() => render(bad));
			expect(isEmailError(error) && error.kind, String(bad)).toBe('invalid');
		}
	});

	it('refuses missing or unsafe links and escapes the name', () => {
		expect(
			isEmailError(
				caught(() => renderTemplate('reset-password', 'pt-BR', { origin: ORIGIN } as never))
			)
		).toBe(true);
		const named = renderTemplate('password-changed', 'en-US', {
			origin: ORIGIN,
			url: `${ORIGIN}/esqueci-senha`,
			name: '<script>alert(1)</script>'
		});
		expect(named.html).not.toContain('<script>');
		expect(named.html).toContain('&lt;script&gt;');
		expect(resolveEmailLocale('en')).toBe('en-US');
		expect(resolveEmailLocale('fr-FR')).toBe('pt-BR');
		expect(resolveEmailLocale(null)).toBe('pt-BR');
	});
});

describe('escape helpers', () => {
	it('safeUrl: absolute https, or http only on a local configured origin', () => {
		expect(safeUrl('https://example.org/a b', ORIGIN)).toBe('https://example.org/a%20b');
		expect(safeUrl('http://localhost:4173/x', 'http://localhost:4173')).toBe(
			'http://localhost:4173/x'
		);
		for (const [value, origin] of [
			['/relative', ORIGIN],
			['not a url', ORIGIN],
			['javascript:alert(1)', ORIGIN],
			['data:text/html,x', ORIGIN],
			['https://user:pass@example.org/', ORIGIN],
			['https://user@example.org/', ORIGIN],
			['http://example.org/x', 'http://example.org'],
			['http://localhost:4173/x', 'http://localhost:9999']
		] as const) {
			const error = caught(() => safeUrl(value, origin));
			expect(error, value).toBeInstanceOf(EmailError);
			expect(String((error as Error).message)).not.toContain(value);
		}
	});

	it('cleanText flattens, trims and caps; escapeHtml covers the five characters', () => {
		expect(cleanText(null)).toBeNull();
		expect(cleanText(undefined)).toBeNull();
		expect(cleanText(' \u0000\u200b\n ')).toBeNull();
		expect(cleanText('  Ana\n\tMaria\u2028 ')).toBe('Ana Maria');
		const long = cleanText('x'.repeat(MAX_NAME_LENGTH + 10));
		expect(long).toHaveLength(MAX_NAME_LENGTH);
		expect(long?.endsWith('…')).toBe(true);
		expect(cleanText('abc', 2)).toBe('a…');
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
			'&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'
		);
	});
});

describe('message metadata and idempotency keys', () => {
	const message: EmailMessage = {
		to: 'a@example.test',
		subject: 's',
		html: '<p>h</p>',
		text: 't',
		idempotencyKey: 'verify-email:abc',
		tags: [{ name: 'template', value: 'verify-email' }]
	};

	it('refuses bad keys, tags and recipients', () => {
		expect(() => assertMessageMetadata(message)).not.toThrow();
		const bad: Partial<EmailMessage>[] = [
			{ idempotencyKey: '' },
			{ idempotencyKey: 'has space' },
			{ idempotencyKey: 'x'.repeat(257) },
			{ tags: [{ name: 'bad name', value: 'v' }] },
			{ tags: [{ name: 'n', value: '' }] },
			{ to: '  ' },
			{ to: 'a@example.test\r\nBcc: b@example.test' }
		];
		for (const override of bad) {
			const error = caught(() => assertMessageMetadata({ ...message, ...override }));
			expect(isEmailError(error) && error.kind, JSON.stringify(override)).toBe('invalid');
		}
	});

	it('keys are scoped, stable and reveal nothing; bad scopes are refused', async () => {
		const key = await buildIdempotencyKey('verify-email', 'user-1', 'token-1');
		expect(key).toMatch(/^verify-email:[0-9a-f]{64}$/);
		expect(await buildIdempotencyKey('verify-email', 'user-1', 'token-1')).toBe(key);
		expect(await buildIdempotencyKey('verify-email', 'user-1', 'token-2')).not.toBe(key);
		for (const scope of ['', 'Upper', '-lead', 'has space', 'x'.repeat(65)]) {
			await expect(buildIdempotencyKey(scope, 'a'), scope).rejects.toBeInstanceOf(EmailError);
		}
	});

	it('EmailError keeps only safe vendor codes and a status', () => {
		const error = new EmailError('rejected', 'fixed reason', {
			status: 403,
			code: 'invalid_api_key'
		});
		expect(error.message).toBe('email rejected: fixed reason (403 invalid_api_key)');
		const unsafe = new EmailError('rejected', 'fixed reason', { code: 'Has Spaces <x@y.z>' });
		expect(unsafe.code).toBeNull();
		expect(unsafe.status).toBeNull();
		expect(unsafe.message).toBe('email rejected: fixed reason');
		expect(isEmailError(new Error('x'))).toBe(false);
	});

	it('queueEmail never rejects and logs only the template label and the error kind', async () => {
		const logged: Record<string, string | number>[] = [];
		const logger = {
			warn: (_: string, details: Record<string, string | number>) => logged.push(details)
		};
		const pending: Promise<unknown>[] = [];
		const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
		await queueEmail(
			ctx,
			{ send: async () => Promise.reject(new EmailError('unavailable', 'down', { status: 503 })) },
			{ templateId: 'verify-email', message },
			logger
		);
		await queueEmail(
			ctx,
			{ send: async () => Promise.reject(new TypeError('boom a@example.test')) },
			{ templateId: 'Not A Label a@example.test', message },
			logger
		);
		await queueEmail(
			ctx,
			{ send: async () => ({ id: 'ok' }) },
			{ templateId: 'verify-email', message },
			logger
		);
		expect(pending).toHaveLength(3);
		expect(logged).toEqual([
			{ template: 'verify-email', kind: 'unavailable', status: 503 },
			{ template: 'custom', kind: 'unexpected' }
		]);
	});
});

describe('byte helpers', () => {
	it('base64, hex and constant-time comparison', async () => {
		expect(fromBase64('')).toBeNull();
		expect(fromBase64('***')).toBeNull();
		// Passes the alphabet check but is not decodable (length ≡ 1 mod 4): atob throws.
		expect(fromBase64('a')).toBeNull();
		expect(fromBase64('YWJj')).toEqual(utf8('abc'));
		expect(toBase64(utf8('abc').buffer)).toBe('YWJj');
		expect(toHex(new Uint8Array([0, 15, 255]).buffer)).toBe('000fff');
		expect(timingSafeEqual(utf8('abc'), utf8('abc'))).toBe(true);
		expect(timingSafeEqual(utf8('abc'), utf8('abd'))).toBe(false);
		expect(timingSafeEqual(utf8('abc'), utf8('ab'))).toBe(false);
		await expect(deriveSuppressionKey('short')).rejects.toBeInstanceOf(EmailError);
	});
});
