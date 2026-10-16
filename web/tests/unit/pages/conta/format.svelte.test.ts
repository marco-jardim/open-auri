// Labels and feedback messages of the account area (browser project: paraglide resolves the
// locale like in the app).
import { expect, test } from 'vitest';
import {
	deviceLabel,
	feedbackMessage,
	formatDate,
	formatDateTime
} from '#lib/components/account/format.ts';
import { feedbackFor, type FormFeedback, type FormId } from '#lib/components/account/types.ts';
import { m } from '#lib/paraglide/messages.js';

test('device labels degrade gracefully', () => {
	expect(deviceLabel({ browser: 'Firefox', os: 'Linux' })).toBe(
		m.conta_sessions_device({ browser: 'Firefox', os: 'Linux' })
	);
	expect(deviceLabel({ browser: 'Firefox', os: null })).toBe('Firefox');
	expect(deviceLabel({ browser: null, os: 'iOS' })).toBe(m.conta_sessions_device_os({ os: 'iOS' }));
	expect(deviceLabel({ browser: null, os: null })).toBe(m.conta_sessions_device_unknown());
});

test('dates are formatted in the given locale', () => {
	const at = Date.UTC(2026, 9, 16, 12, 0, 0);
	expect(formatDate(at, 'en-US')).toContain('2026');
	expect(formatDate(at, 'pt-BR')).toContain('outubro');
	expect(formatDateTime(at, 'en-US')).toContain('2026');
});

test('every error code of the actions has its own message', () => {
	const generic = m.conta_error_generic();
	const codes: [FormId, string][] = [
		['nickname', 'unauthenticated'],
		['nickname', 'unverified'],
		['nickname', 'EMAIL_NOT_VERIFIED'],
		['nickname', 'BANNED'],
		['nickname', 'invalid'],
		['nickname', 'taken'],
		['nickname', 'too-soon'],
		['nickname', 'unchanged'],
		['bio', 'too-long'],
		['password', 'wrong-password'],
		['password', 'too-short'],
		['password', 'too-long'],
		['password', 'mismatch'],
		['password', 'same-password'],
		['password', 'PASSWORD_TOO_SHORT'],
		['sessions', 'not-found'],
		['sessions', 'current'],
		['email', 'invalid-email'],
		['email', 'same-email'],
		['email', 'reauth-required'],
		['email', 'TURNSTILE_FAILED'],
		['email', 'TURNSTILE_REQUIRED'],
		['email', 'TURNSTILE_UNAVAILABLE'],
		['email', 'RATE_LIMITED'],
		['email', 'unavailable'],
		['close', 'not-acknowledged'],
		['close', 'invalid-mode'],
		['close', 'wrong-password'],
		['policy', 'version']
	];
	for (const [form, error] of codes) {
		expect(feedbackMessage({ form, error }), `${form}:${error}`).not.toBe(generic);
	}
	expect(feedbackMessage({ form: 'email', error: 'SOMETHING_NEW' })).toBe(generic);
	expect(feedbackMessage({ form: 'bio', error: 'too-long' })).toBe(m.conta_bio_error_too_long());
	expect(feedbackMessage({ form: 'password', error: 'too-long' })).toBe(
		m.conta_password_error_long()
	);
});

test('details reach the message: retry date, wait seconds, revoked count', () => {
	const retryAt = Date.UTC(2026, 10, 15, 12, 0, 0);
	expect(feedbackMessage({ form: 'nickname', error: 'too-soon', retryAt })).toBe(
		m.conta_nickname_error_too_soon({ date: formatDate(retryAt) })
	);
	expect(feedbackMessage({ form: 'email', error: 'RATE_LIMITED', retryAfter: 42 })).toBe(
		m.conta_error_rate_limited_wait({ seconds: '42' })
	);
	expect(feedbackMessage({ form: 'sessions', ok: true, detail: 'others', count: 3 })).toBe(
		m.conta_sessions_revoked_others({ count: '3' })
	);
});

test('every form has a success message', () => {
	const forms: FormId[] = [
		'nickname',
		'bio',
		'visibility',
		'password',
		'sessions',
		'email',
		'close',
		'policy'
	];
	for (const form of forms) {
		expect(feedbackMessage({ form, ok: true }), form).not.toBe(m.conta_error_generic());
	}
	expect(feedbackMessage({ form: 'nickname', ok: true, detail: 'first' })).toBe(
		m.conta_nickname_saved_first()
	);
});

test('feedbackFor only returns the feedback of its own form', () => {
	const feedback: FormFeedback = { form: 'bio', ok: true };
	expect(feedbackFor(feedback, 'bio')).toBe(feedback);
	expect(feedbackFor(feedback, 'nickname')).toBeNull();
	expect(feedbackFor(null, 'bio')).toBeNull();
	expect(feedbackFor(undefined, 'bio')).toBeNull();
});
