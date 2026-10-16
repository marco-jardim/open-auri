// Labels and messages of the account area: dates, devices and the feedback of each form action.
import { m } from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import type { FormFeedback, SessionView } from './types.ts';

export function formatDateTime(ms: number, locale: string = getLocale()): string {
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
		new Date(ms)
	);
}

export function formatDate(ms: number, locale: string = getLocale()): string {
	return new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(ms));
}

/** "Firefox no Linux" / "Firefox on Linux"; partial or unknown devices degrade gracefully. */
export function deviceLabel(session: Pick<SessionView, 'browser' | 'os'>): string {
	const { browser, os } = session;
	if (browser && os) return m.conta_sessions_device({ browser, os });
	if (browser) return browser;
	if (os) return m.conta_sessions_device_os({ os });
	return m.conta_sessions_device_unknown();
}

function errorMessage(feedback: FormFeedback): string {
	const code = feedback.error ?? '';
	switch (code) {
		case 'unauthenticated':
		case 'UNAUTHENTICATED':
		case 'UNAUTHORIZED':
			return m.conta_error_unauthenticated();
		case 'unverified':
		case 'EMAIL_NOT_VERIFIED':
			return m.conta_error_unverified();
		case 'BANNED':
			return m.conta_error_banned();
		case 'RATE_LIMITED':
			return feedback.retryAfter
				? m.conta_error_rate_limited_wait({ seconds: String(feedback.retryAfter) })
				: m.conta_error_rate_limited();
		case 'TURNSTILE_REQUIRED':
		case 'TURNSTILE_FAILED':
			return m.conta_error_turnstile();
		case 'TURNSTILE_UNAVAILABLE':
		case 'RATE_LIMIT_UNAVAILABLE':
		case 'unavailable':
			return m.conta_error_unavailable();
		case 'wrong-password':
		case 'INVALID_PASSWORD':
			return m.conta_error_wrong_password();
		case 'invalid':
			return feedback.form === 'nickname'
				? m.conta_nickname_error_invalid()
				: m.conta_error_generic();
		case 'taken':
			return m.conta_nickname_error_taken();
		case 'too-soon':
			return feedback.retryAt
				? m.conta_nickname_error_too_soon({ date: formatDate(feedback.retryAt) })
				: m.conta_nickname_error_too_soon_generic();
		case 'unchanged':
			return m.conta_nickname_error_unchanged();
		case 'too-long':
			return feedback.form === 'bio' ? m.conta_bio_error_too_long() : m.conta_password_error_long();
		case 'too-short':
		case 'PASSWORD_TOO_SHORT':
			return m.conta_password_error_short();
		case 'PASSWORD_TOO_LONG':
			return m.conta_password_error_long();
		case 'mismatch':
			return m.conta_password_error_mismatch();
		case 'same-password':
			return m.conta_password_error_same();
		case 'invalid-email':
		case 'INVALID_EMAIL':
			return m.conta_email_error_invalid();
		case 'same-email':
			return m.conta_email_error_same();
		case 'reauth-required':
			return m.conta_email_error_reauth();
		case 'not-found':
			return m.conta_sessions_error_not_found();
		case 'current':
			return m.conta_sessions_error_current();
		case 'not-acknowledged':
			return m.conta_close_error_ack();
		case 'invalid-mode':
			return m.conta_close_error_mode();
		case 'version':
			return m.conta_policy_error();
		case 'invalid-code':
			return m.conta_2fa_error_code();
		case 'two-factor-required':
		case 'TWO_FACTOR_REQUIRED':
			return m.conta_2fa_error_marker();
		case 'already-enabled':
			return m.conta_2fa_error_already();
		case 'not-enrolling':
			return m.conta_2fa_error_not_enrolling();
		default:
			return m.conta_error_generic();
	}
}

function successMessage(feedback: FormFeedback): string {
	switch (feedback.form) {
		case 'nickname':
			return feedback.detail === 'first'
				? m.conta_nickname_saved_first()
				: m.conta_nickname_saved();
		case 'bio':
			return m.conta_bio_saved();
		case 'visibility':
			return m.conta_visibility_saved();
		case 'password':
			return m.conta_password_saved();
		case 'sessions':
			return feedback.detail === 'others'
				? m.conta_sessions_revoked_others({ count: String(feedback.count ?? 0) })
				: m.conta_sessions_revoked();
		case 'email':
			return m.conta_email_requested();
		case 'close':
			return m.conta_close_requested();
		case 'policy':
			return m.conta_policy_saved();
		case 'twoFactor':
			return feedback.detail === 'started'
				? m.conta_2fa_started()
				: feedback.detail === 'disabled'
					? m.conta_2fa_disabled()
					: m.conta_2fa_enabled();
	}
}

export function feedbackMessage(feedback: FormFeedback): string {
	return feedback.ok ? successMessage(feedback) : errorMessage(feedback);
}
