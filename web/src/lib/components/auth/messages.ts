// Localized copy for auth outcomes and field issues (keys in messages/_staging/T3.6.*.json).
import { m } from '#lib/paraglide/messages.js';
import {
	PASSWORD_MAX,
	PASSWORD_MIN,
	type StrengthHint,
	type StrengthLevel
} from './password-strength.ts';
import type { AuthErrorKind, FieldIssue } from './types.ts';

/** `m:ss` (minutes and seconds), the same in both locales. */
export function formatWait(seconds: number): string {
	const total = Math.max(0, Math.ceil(seconds));
	const minutes = Math.floor(total / 60);
	const rest = String(total % 60).padStart(2, '0');
	return `${minutes}:${rest}`;
}

export function errorMessage(kind: AuthErrorKind, retryAfter?: number): string {
	switch (kind) {
		case 'credentials':
			return m.auth_error_credentials();
		case 'unverified':
			return m.auth_error_unverified();
		case 'banned':
			return m.auth_error_banned();
		case 'rate':
			return retryAfter
				? m.auth_error_rate({ time: formatWait(retryAfter) })
				: m.auth_error_rate_generic();
		case 'cooldown':
			return m.auth_error_cooldown({ time: formatWait(retryAfter ?? 0) });
		case 'turnstile':
			return m.auth_error_turnstile();
		case 'unavailable':
			return m.auth_error_unavailable();
		case 'signup_disabled':
			return m.auth_error_signup_disabled();
		case 'token':
			return m.auth_error_token();
		case 'code':
			return m.auth_error_code();
		case 'generic':
			return m.auth_error_generic();
	}
}

export function issueMessage(issue: FieldIssue): string {
	switch (issue) {
		case 'required':
			return m.auth_issue_required();
		case 'email':
			return m.auth_issue_email();
		case 'short':
			return m.auth_issue_short({ min: PASSWORD_MIN });
		case 'long':
			return m.auth_issue_long({ max: PASSWORD_MAX });
		case 'mismatch':
			return m.auth_issue_mismatch();
		case 'code':
			return m.auth_issue_code();
	}
}

export function strengthLabel(level: StrengthLevel): string {
	const labels = [
		m.auth_strength_0,
		m.auth_strength_1,
		m.auth_strength_2,
		m.auth_strength_3,
		m.auth_strength_4
	] as const;
	return labels[level]();
}

export function strengthHint(hint: StrengthHint): string {
	switch (hint) {
		case 'length':
			return m.auth_strength_hint_length();
		case 'common':
			return m.auth_strength_hint_common();
		case 'repeat':
			return m.auth_strength_hint_repeat();
		case 'sequence':
			return m.auth_strength_hint_sequence();
		case 'personal':
			return m.auth_strength_hint_personal();
		case 'variety':
			return m.auth_strength_hint_variety();
	}
}
