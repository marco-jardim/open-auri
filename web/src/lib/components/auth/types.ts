// Shapes shared by the auth form actions (server) and the auth form components (client).
// Nothing here carries a password, a token or anything the server did not receive from the form.

/** Page-level outcome shown in the form's alert. Uniform per flow: no account enumeration. */
export type AuthErrorKind =
	| 'credentials'
	| 'unverified'
	| 'banned'
	| 'rate'
	| 'cooldown'
	| 'turnstile'
	| 'unavailable'
	| 'signup_disabled'
	| 'token'
	| 'code'
	| 'generic';

/** Field-level validation problems (checked on the server; the browser repeats the basics). */
export type FieldIssue = 'required' | 'email' | 'short' | 'long' | 'mismatch' | 'code';

export type AuthField = 'email' | 'password' | 'confirm' | 'code';

/** Data an action returns with `fail()` or as a success payload. */
export interface AuthFormState {
	error?: AuthErrorKind;
	/** Seconds to wait, for `rate` and `cooldown`. */
	retryAfter?: number;
	fields?: Partial<Record<AuthField, FieldIssue>>;
	/** Echo of non-secret inputs so a no-JS round trip keeps them. */
	values?: { email?: string };
	/** Success flags of the flows that stay on the page. */
	sent?: boolean;
	/** Sign-in waiting for the second factor. */
	step?: 'two-factor';
	/**
	 * Validated return path echoed by the sign-in actions: they post to `?/signIn` /
	 * `?/twoFactor`, which drops the page's `?next=` on a no-JS round trip.
	 */
	next?: string | null;
	/** Epoch ms when the next verification e-mail may be requested. */
	resendAvailableAt?: number | null;
}

/** Minimal `use:enhance` adapter: the page passes Kit's `enhance`, tests pass nothing. */
