// Auth copy helpers in both locales (browser project: the locale follows setLocale).
import { afterEach, describe, expect, test } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import {
	errorMessage,
	formatWait,
	issueMessage,
	strengthHint,
	strengthLabel
} from '#lib/components/auth/messages.ts';
import { PASSWORD_MAX, PASSWORD_MIN } from '#lib/components/auth/password-strength.ts';
import type { AuthErrorKind, FieldIssue } from '#lib/components/auth/types.ts';

afterEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

const KINDS: readonly AuthErrorKind[] = [
	'credentials',
	'unverified',
	'banned',
	'rate',
	'cooldown',
	'turnstile',
	'unavailable',
	'signup_disabled',
	'token',
	'code',
	'generic'
];
const ISSUES: readonly FieldIssue[] = ['required', 'email', 'short', 'long', 'mismatch', 'code'];
const HINTS = ['length', 'common', 'repeat', 'sequence', 'personal', 'variety'] as const;
const LEVELS = [0, 1, 2, 3, 4] as const;

describe('formatWait', () => {
	test('m:ss, rounded up, never negative', () => {
		expect(formatWait(0)).toBe('0:00');
		expect(formatWait(5)).toBe('0:05');
		expect(formatWait(65)).toBe('1:05');
		expect(formatWait(59.2)).toBe('1:00');
		expect(formatWait(600)).toBe('10:00');
		expect(formatWait(3600)).toBe('60:00');
		expect(formatWait(-12)).toBe('0:00');
	});
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	describe(`auth messages in ${locale}`, () => {
		test('each error kind has its own message', async () => {
			await setLocale(locale, { reload: false });
			const texts = KINDS.map((kind) => errorMessage(kind, 30));
			for (const text of texts) expect(text.trim()).not.toBe('');
			expect(new Set(texts).size).toBe(KINDS.length);
			expect(errorMessage('credentials')).toBe(m.auth_error_credentials());
			expect(errorMessage('unverified')).toBe(m.auth_error_unverified());
			expect(errorMessage('banned')).toBe(m.auth_error_banned());
			expect(errorMessage('turnstile')).toBe(m.auth_error_turnstile());
			expect(errorMessage('unavailable')).toBe(m.auth_error_unavailable());
			expect(errorMessage('signup_disabled')).toBe(m.auth_error_signup_disabled());
			expect(errorMessage('token')).toBe(m.auth_error_token());
			expect(errorMessage('code')).toBe(m.auth_error_code());
			expect(errorMessage('generic')).toBe(m.auth_error_generic());
		});

		test('rate limits show the wait when known, a generic line otherwise', async () => {
			await setLocale(locale, { reload: false });
			const timed = errorMessage('rate', 65);
			expect(timed).toContain('1:05');
			expect(timed).toBe(m.auth_error_rate({ time: '1:05' }));
			const generic = errorMessage('rate');
			expect(generic).toBe(m.auth_error_rate_generic());
			expect(generic).not.toContain('1:05');
			// A zero wait is no wait: the generic line, not "0:00".
			expect(errorMessage('rate', 0)).toBe(generic);
		});

		test('the resend cooldown always shows a time, 0:00 when unknown', async () => {
			await setLocale(locale, { reload: false });
			expect(errorMessage('cooldown', 240)).toContain('4:00');
			expect(errorMessage('cooldown')).toBe(m.auth_error_cooldown({ time: '0:00' }));
		});

		test('field issues, with the real password limits', async () => {
			await setLocale(locale, { reload: false });
			const texts = ISSUES.map((issue) => issueMessage(issue));
			expect(new Set(texts).size).toBe(ISSUES.length);
			expect(issueMessage('short')).toContain(String(PASSWORD_MIN));
			expect(issueMessage('long')).toContain(String(PASSWORD_MAX));
			expect(issueMessage('required')).toBe(m.auth_issue_required());
			expect(issueMessage('email')).toBe(m.auth_issue_email());
			expect(issueMessage('mismatch')).toBe(m.auth_issue_mismatch());
			expect(issueMessage('code')).toBe(m.auth_issue_code());
		});

		test('strength labels and hints', async () => {
			await setLocale(locale, { reload: false });
			const labels = LEVELS.map((level) => strengthLabel(level));
			expect(new Set(labels).size).toBe(LEVELS.length);
			expect(labels).toEqual([
				m.auth_strength_0(),
				m.auth_strength_1(),
				m.auth_strength_2(),
				m.auth_strength_3(),
				m.auth_strength_4()
			]);
			const hints = HINTS.map((hint) => strengthHint(hint));
			expect(new Set(hints).size).toBe(HINTS.length);
			expect(hints).toEqual([
				m.auth_strength_hint_length(),
				m.auth_strength_hint_common(),
				m.auth_strength_hint_repeat(),
				m.auth_strength_hint_sequence(),
				m.auth_strength_hint_personal(),
				m.auth_strength_hint_variety()
			]);
		});
	});
}

test('the two locales differ for the user-facing errors', async () => {
	await setLocale('pt-BR', { reload: false });
	const pt = KINDS.map((kind) => errorMessage(kind, 65));
	expect(errorMessage('credentials')).toBe('E-mail ou senha incorretos.');
	expect(errorMessage('rate', 65)).toBe('Muitas tentativas. Tente de novo em 1:05.');
	await setLocale('en-US', { reload: false });
	const en = KINDS.map((kind) => errorMessage(kind, 65));
	expect(en).not.toEqual(pt);
	expect(en[0]).not.toBe(pt[0]);
});
