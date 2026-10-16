import { describe, expect, it } from 'vitest';
import { EmailError } from '#lib/server/email/provider.ts';
import {
	accountDeleted,
	cleanText,
	confirmAccountDeletion,
	EMAIL_LOCALES,
	escapeHtml,
	renderTemplate,
	resetPassword,
	resolveEmailLocale,
	safeUrl,
	TEMPLATE_IDS,
	verifyEmail,
	type RenderedEmail,
	type TemplateDataMap,
	type TemplateId
} from '#lib/server/email/templates/index.ts';

const ORIGIN = 'https://open-auri.example';

const FIXTURES: TemplateDataMap = {
	'verify-email': {
		origin: ORIGIN,
		url: `${ORIGIN}/verificar-email?token=tok_verify`,
		expiresInMinutes: 60
	},
	'reset-password': {
		origin: ORIGIN,
		name: 'Ana',
		url: `${ORIGIN}/redefinir-senha?token=tok_reset`,
		expiresInMinutes: 30
	},
	'confirm-new-email': {
		origin: ORIGIN,
		name: 'Ana',
		url: `${ORIGIN}/conta/email/confirmar?token=tok_change`,
		expiresInMinutes: 1440
	},
	'email-change-notice': { origin: ORIGIN, name: 'Ana', url: `${ORIGIN}/esqueci-senha` },
	'password-changed': { origin: ORIGIN, name: 'Ana', url: `${ORIGIN}/esqueci-senha` },
	'confirm-account-deletion': {
		origin: ORIGIN,
		name: 'Ana',
		url: `${ORIGIN}/conta/encerrar/confirmar?token=tok_delete`,
		expiresInMinutes: 60
	},
	'account-deleted': { origin: ORIGIN, name: 'Ana' }
};

function render(id: TemplateId, locale: (typeof EMAIL_LOCALES)[number]): RenderedEmail {
	switch (id) {
		case 'verify-email':
			return renderTemplate(id, locale, FIXTURES[id]);
		case 'reset-password':
			return renderTemplate(id, locale, FIXTURES[id]);
		case 'confirm-new-email':
			return renderTemplate(id, locale, FIXTURES[id]);
		case 'email-change-notice':
			return renderTemplate(id, locale, FIXTURES[id]);
		case 'password-changed':
			return renderTemplate(id, locale, FIXTURES[id]);
		case 'confirm-account-deletion':
			return renderTemplate(id, locale, FIXTURES[id]);
		case 'account-deleted':
			return renderTemplate(id, locale, FIXTURES[id]);
	}
}

// Plan section 3.4: names that must not appear as branding.
const BANNED = [
	/\bMoog\b/,
	/\bMinimoog\b/,
	/\bEMI\b/,
	/Abbey Road/,
	/\bBeatles\b/,
	/\bAmpex\b/,
	/\bGibson\b/,
	/\bAntares\b/,
	/Auto-Tune/,
	/\bSSL\b/,
	/Solid State Logic/,
	/\bHarman\b/,
	/\bJBL\b/,
	/\bSamsung\b/,
	/\bDolby\b/,
	/\bBell\b/,
	/AT&T/,
	/\bExxon\b/,
	/\bYamaha\b/,
	/\bApogee\b/,
	/\bNeve\b/,
	/\bWaves\b/,
	/\bKuba\b/
];

const CASES = TEMPLATE_IDS.flatMap((id) => EMAIL_LOCALES.map((locale) => [id, locale] as const));

describe('templates', () => {
	it('covers the seven messages in both locales', () => {
		expect(TEMPLATE_IDS).toHaveLength(7);
		expect(CASES).toHaveLength(14);
	});

	it.each(CASES)('%s (%s) matches the snapshot', (id, locale) => {
		expect(render(id, locale)).toMatchSnapshot();
	});

	it.each(CASES)('%s (%s) is an accessible, tracker-free document', (id, locale) => {
		const { subject, html, text } = render(id, locale);
		expect(html.startsWith('<!DOCTYPE html>\n')).toBe(true);
		expect(html).toContain(`<html lang="${locale}" dir="ltr">`);
		expect(html).toContain('<meta charset="utf-8">');
		expect(html).toContain(`<title>${escapeHtml(subject)}</title>`);
		expect(html).toMatch(/<h1 [^>]*>[^<]+<\/h1>/);
		expect(html).toContain('role="article"');
		for (const forbidden of ['<img', '<link', '<style', '<script', 'url(', '@import', 'src=']) {
			expect(html).not.toContain(forbidden);
		}
		// Every link targets the configured origin and shows readable text.
		for (const match of html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)) {
			expect(match[1]?.startsWith(`${ORIGIN}/`)).toBe(true);
			expect(match[2]?.trim()).not.toBe('');
		}
		expect(html).toContain('open-auri');
		expect(subject).toContain('open-auri');
		expect(text).toContain(ORIGIN);
		expect(text).not.toMatch(/<[a-z]/i);
	});

	it.each(CASES.filter(([id]) => id !== 'account-deleted'))(
		'%s (%s) shows the action URL as visible text',
		(id, locale) => {
			const fixture = FIXTURES[id];
			const url = 'url' in fixture ? fixture.url : '';
			expect(url).not.toBe('');
			const { html, text } = render(id, locale);
			expect(html).toContain(`>${escapeHtml(url)}</a>`);
			expect(text).toContain(url);
		}
	);

	it('has no action link in the closure notice', () => {
		for (const locale of EMAIL_LOCALES) {
			const { html } = render('account-deleted', locale);
			const hrefs = Array.from(html.matchAll(/href="([^"]+)"/g), (m) => m[1]);
			expect(hrefs).toEqual([`${ORIGIN}/privacidade`, `${ORIGIN}/`]);
		}
	});

	it.each(CASES)('%s (%s) avoids banned brands and pt-BR em dashes', (id, locale) => {
		const { subject, html, text } = render(id, locale);
		const all = `${subject}\n${html}\n${text}`;
		for (const pattern of BANNED) expect(all).not.toMatch(pattern);
		if (locale === 'pt-BR') expect(all).not.toContain('\u2014');
	});

	it('formats the link lifetime per locale', () => {
		const base = FIXTURES['verify-email'];
		const lifetime = (locale: 'pt-BR' | 'en-US', expiresInMinutes: number) =>
			verifyEmail(locale, { ...base, expiresInMinutes }).text;
		expect(lifetime('pt-BR', 1)).toContain('Este link vale por 1 minuto.');
		expect(lifetime('pt-BR', 90)).toContain('Este link vale por 90 minutos.');
		expect(lifetime('pt-BR', 60)).toContain('Este link vale por 1 hora.');
		expect(lifetime('pt-BR', 120)).toContain('Este link vale por 2 horas.');
		expect(lifetime('pt-BR', 2880)).toContain('Este link vale por 2 dias.');
		expect(lifetime('en-US', 1440)).toContain('This link expires in 1 day.');
		expect(lifetime('en-US', 45)).toContain('This link expires in 45 minutes.');
		for (const bad of [0, -5, 1.5, 43_201, Number.NaN]) {
			expect(() => lifetime('pt-BR', bad)).toThrow(EmailError);
		}
	});

	it('greets by name only when there is one', () => {
		const data = FIXTURES['reset-password'];
		expect(resetPassword('pt-BR', data).text).toContain('Olá, Ana.');
		expect(resetPassword('en-US', data).text).toContain('Hi Ana,');
		expect(resetPassword('pt-BR', { ...data, name: null }).text).toContain('\nOlá.\n');
		expect(resetPassword('en-US', { ...data, name: '  \n ' }).text).toContain('\nHi,\n');
	});

	it('links the privacy policy from the account closure messages', () => {
		const expected = `${ORIGIN}/privacidade`;
		expect(confirmAccountDeletion('pt-BR', FIXTURES['confirm-account-deletion']).html).toContain(
			`href="${expected}"`
		);
		expect(accountDeleted('en-US', FIXTURES['account-deleted']).text).toContain(expected);
	});
});

describe('escaping', () => {
	const XSS_NAME = `<script>alert("x")</script>'"><img src=x onerror=alert(1)>&amp;`;

	it('escapes HTML metacharacters', () => {
		expect(escapeHtml(`<a href="x" title='y'>&\`</a>`)).toBe(
			'&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&#96;&lt;/a&gt;'
		);
	});

	it.each(EMAIL_LOCALES)('neutralizes markup in names (%s)', (locale) => {
		const { html, text } = resetPassword(locale, { ...FIXTURES['reset-password'], name: XSS_NAME });
		expect(html).not.toContain('<script');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('onerror=alert(1)>');
		expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;&quot;&gt;');
		expect(html).toContain('&amp;amp;');
		// Plain text has no HTML context: the characters stay, on the greeting line only.
		const greeting = locale === 'pt-BR' ? `Olá, ${XSS_NAME}.` : `Hi ${XSS_NAME},`;
		expect(text.split('\n')).toContain(greeting);
	});

	it('removes control and bidi characters from names and caps their length', () => {
		expect(cleanText('Ana\r\nBcc: x@y.z')).toBe('Ana Bcc: x@y.z');
		expect(cleanText('a\u202Egnp.exe')).toBe('a gnp.exe');
		expect(cleanText('\u0000\t ')).toBeNull();
		expect(cleanText(undefined)).toBeNull();
		const long = cleanText('x'.repeat(200));
		expect(Array.from(long ?? '')).toHaveLength(64);
		expect(long?.endsWith('…')).toBe(true);
		const { text } = resetPassword('pt-BR', {
			...FIXTURES['reset-password'],
			name: 'Ana\nClique aqui: https://phish.example'
		});
		expect(text).toContain('Olá, Ana Clique aqui: https://phish.example.');
	});

	it('keeps hostile characters in URLs inside the attribute', () => {
		const url = `${ORIGIN}/redefinir-senha?token=a"><script>alert(1)</script>&x='y'`;
		const { html } = resetPassword('en-US', { ...FIXTURES['reset-password'], url });
		expect(html).not.toContain('<script');
		for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
			expect(href).not.toMatch(/[<>'"]/);
		}
		expect(html).toContain('token=a%22%3E%3Cscript%3E');
	});

	it.each([
		['javascript:alert(1)'],
		['data:text/html,<script>alert(1)</script>'],
		['http://open-auri.example/verificar'],
		['https://user:pass@open-auri.example/verificar'],
		['/relative/path'],
		['not a url']
	])('rejects the link %s', (url) => {
		expect(() => verifyEmail('pt-BR', { ...FIXTURES['verify-email'], url })).toThrow(EmailError);
		let message = '';
		try {
			safeUrl(url, ORIGIN);
		} catch (error) {
			message = error instanceof Error ? error.message : '';
		}
		expect(message).not.toContain(url);
	});

	it('allows plain http only on a local configured origin', () => {
		const local = 'http://localhost:5173';
		expect(safeUrl(`${local}/verificar-email?token=t`, local)).toBe(
			`${local}/verificar-email?token=t`
		);
		expect(() => safeUrl('http://localhost:9999/x', local)).toThrow(EmailError);
		expect(() => safeUrl('http://evil.example/x', 'http://evil.example')).toThrow(EmailError);
		expect(safeUrl('https://elsewhere.example/x', ORIGIN)).toBe('https://elsewhere.example/x');
	});
});

describe('resolveEmailLocale', () => {
	it('maps account locales and falls back to pt-BR', () => {
		expect(resolveEmailLocale('en-US')).toBe('en-US');
		expect(resolveEmailLocale('en')).toBe('en-US');
		expect(resolveEmailLocale('pt-BR')).toBe('pt-BR');
		expect(resolveEmailLocale('fr')).toBe('pt-BR');
		expect(resolveEmailLocale(null)).toBe('pt-BR');
	});
});
