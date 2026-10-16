// View shapes of the account area (/conta). The server modules (#lib/server/account) return
// structurally identical objects; they are repeated here because client code cannot import
// server modules.
import type { Action } from 'svelte/action';

export type Visibility = 'private' | 'public';
export type DeletionMode = 'anonymize' | 'delete-all';

export interface ProfileView {
	email: string;
	emailVerified: boolean;
	username: string | null;
	displayUsername: string | null;
	bio: string | null;
	activityVisibility: Visibility;
	libraryVisibility: Visibility;
	/** Epoch ms when the nickname may change again; null when it may change now. */
	nextNicknameChangeAt: number | null;
}

export interface SessionView {
	id: string;
	browser: string | null;
	os: string | null;
	createdAt: number;
	lastActiveAt: number;
	expiresAt: number;
	current: boolean;
	impersonated: boolean;
}

export interface PendingEmailView {
	newEmail: string;
	requestedAt: number;
	expiresAt: number;
}

export interface HoldView {
	username: string;
	releasedAt: number;
}

export interface ClosureView {
	mode: DeletionMode;
	requestedAt: number;
}

export type FormId =
	| 'nickname'
	| 'bio'
	| 'visibility'
	| 'password'
	| 'sessions'
	| 'email'
	| 'close'
	| 'policy'
	| 'twoFactor';

/** 2FA state of the account: off, enrolment started but not confirmed, or on. */
export type TwoFactorStatus = 'off' | 'pending' | 'on';

/**
 * What `?/twoFactorStart` returns once: the otpauth URI (QR + manual key) and the backup codes.
 * Only ever in the action result of that request: never in a cookie, the URL or storage.
 */
export interface TwoFactorEnrolmentView {
	totpURI: string;
	backupCodes: string[];
}

export interface TwoFactorView {
	status: TwoFactorStatus;
	/** The account has the admin role (2FA required for /admin; disabling needs the 2FA marker). */
	admin: boolean;
}

/** What every /conta form action returns (success or `fail()` data). */
export interface FormFeedback {
	form: FormId;
	ok?: boolean;
	/** Error code (ours, Better Auth's or the T3.3 guard's). */
	error?: string;
	/** Success detail ('first' | 'change' | 'cosmetic', 'revoked', 'others'). */
	detail?: string;
	/** Epoch ms (nickname too soon). */
	retryAt?: number;
	/** Seconds (rate limited). */
	retryAfter?: number;
	count?: number;
	/** Echo of a non-secret field to refill the form (nickname, bio, new e-mail). */
	value?: string;
	/** `?/twoFactorStart` success only: shown once (see TwoFactorEnrolmentView). */
	enrolment?: TwoFactorEnrolmentView;
}

/** `use:enhance` from `$app/forms` in the page; a no-op in tests and without JavaScript. */
export type FormEnhance = Action<HTMLFormElement>;

export const noEnhance: FormEnhance = () => undefined;

/** Feedback for `form`, or null when the last action was another form. */
export function feedbackFor(feedback: FormFeedback | null | undefined, form: FormId) {
	return feedback && feedback.form === form ? feedback : null;
}
