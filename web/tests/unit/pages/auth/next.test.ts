import { describe, expect, test } from 'vitest';
import {
	AUTH_PAGES,
	MAX_NEXT_LENGTH,
	afterSignIn,
	safeNext,
	withNext
} from '#lib/components/auth/next.ts';
import { resetToken, signInNotice, verifyStatus } from '#lib/components/auth/status.ts';

describe('safeNext', () => {
	test.each([
		['/', '/'],
		['/biblioteca', '/biblioteca'],
		['/c/abc123?aba=ficha#topo', '/c/abc123?aba=ficha#topo'],
		['/conta/seguranca', '/conta/seguranca'],
		['/a/./b/../c', '/a/c'],
		['/%2F%2Fevil.example', '/%2F%2Fevil.example'],
		['/%5Cevil.example', '/%5Cevil.example']
	])('accepts the same-origin path %s', (input, expected) => {
		expect(safeNext(input)).toBe(expected);
	});

	test.each([
		['empty', ''],
		['absolute https', 'https://evil.example/'],
		['absolute http', 'http://evil.example'],
		['javascript scheme', 'javascript:alert(1)'],
		['data scheme', 'data:text/html,hi'],
		['scheme-relative', '//evil.example'],
		['scheme-relative with path', '//evil.example/conta'],
		['backslash host', '/\\evil.example'],
		['double backslash', '\\\\evil.example'],
		['backslash in the middle', '/conta\\..\\evil'],
		['tab', '/\t/evil.example'],
		['newline', '/\n/evil.example'],
		['carriage return', '/conta\r\nLocation: https://evil.example'],
		['null byte', '/conta\u0000'],
		['space', '/ /evil.example'],
		['no leading slash', 'evil.example'],
		['relative dot', './conta'],
		['dot segment to //', '/.//evil.example'],
		['parent segments to //', '/a/../..//evil.example'],
		['triple slash', '///evil.example'],
		['auth API', '/api/auth/sign-out'],
		['API root', '/api'],
		['sign-in page (loop)', '/entrar'],
		['sign-up page (loop)', '/criar-conta?next=/conta'],
		['reset page', '/redefinir-senha?token=abc'],
		['nested auth page', '/verificar-email/x'],
		['too long', `/${'a'.repeat(MAX_NEXT_LENGTH)}`]
	])('rejects %s', (_name, input) => {
		expect(safeNext(input)).toBeNull();
	});

	test('rejects non-string values', () => {
		expect(safeNext(null)).toBeNull();
		expect(safeNext(undefined)).toBeNull();
		expect(safeNext(42)).toBeNull();
		expect(safeNext(['/conta'])).toBeNull();
	});

	test('never returns something a browser would resolve to another origin', () => {
		const payloads = [
			'/\\/evil.example',
			'/%09/evil.example',
			'/..//evil.example',
			'/./..//evil.example',
			'/\u3000/evil.example',
			'/\u00a0//evil.example'
		];
		for (const payload of payloads) {
			const result = safeNext(payload);
			if (result === null) continue;
			expect(new URL(result, 'https://app.example').origin).toBe('https://app.example');
			expect(result.startsWith('//')).toBe(false);
		}
	});

	test('lists the five auth pages', () => {
		expect(AUTH_PAGES).toEqual([
			'/entrar',
			'/criar-conta',
			'/verificar-email',
			'/esqueci-senha',
			'/redefinir-senha'
		]);
	});
});

describe('withNext and afterSignIn', () => {
	test('appends only safe, non-root targets', () => {
		expect(withNext('/entrar', '/biblioteca?x=1')).toBe('/entrar?next=%2Fbiblioteca%3Fx%3D1');
		expect(withNext('/verificar-email?verificado=1', '/cabo')).toBe(
			'/verificar-email?verificado=1&next=%2Fcabo'
		);
		expect(withNext('/entrar', '/')).toBe('/entrar');
		expect(withNext('/entrar', '//evil.example')).toBe('/entrar');
		expect(withNext('/entrar', null)).toBe('/entrar');
	});

	test('falls back to the home page', () => {
		expect(afterSignIn('/cabo')).toBe('/cabo');
		expect(afterSignIn('https://evil.example')).toBe('/');
		expect(afterSignIn(undefined)).toBe('/');
	});
});

describe('page states from the query string', () => {
	const params = (query: string) => new URLSearchParams(query);

	test('verification landing', () => {
		expect(verifyStatus(params('verificado=1'))).toBe('verified');
		expect(verifyStatus(params('verificado=1&error=INVALID_TOKEN'))).toBe('invalid');
		expect(verifyStatus(params('error=TOKEN_EXPIRED'))).toBe('invalid');
		expect(verifyStatus(params('enviado=1'))).toBe('sent');
		expect(verifyStatus(params(''))).toBe('idle');
	});

	test('sign-in notice', () => {
		expect(signInNotice(params('redefinida=1'))).toBe('reset');
		expect(signInNotice(params('redefinida=0'))).toBeNull();
	});

	test('reset token shape', () => {
		expect(resetToken(params('token=AbC123xyz456DEF789ghi012'))).toBe('AbC123xyz456DEF789ghi012');
		expect(resetToken(params(''))).toBeNull();
		expect(resetToken(params('token=short'))).toBeNull();
		expect(resetToken(params('token=%3Cscript%3E'))).toBeNull();
		expect(resetToken(params(`token=${'a'.repeat(513)}`))).toBeNull();
	});
});
