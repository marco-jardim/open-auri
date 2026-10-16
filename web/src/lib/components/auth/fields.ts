// Client-safe constants shared by the auth forms and their actions. The server-side sources of
// truth live under #lib/server (not importable from the browser); a unit test keeps them equal.

/** Hidden form field carrying the Turnstile token (forwarded as `x-turnstile-token`). */
export const TURNSTILE_FIELD = 'cf-turnstile-response';

/** Widget actions per form; must equal TURNSTILE_ACTIONS in #lib/server/security/turnstile.ts. */
export const AUTH_TURNSTILE_ACTIONS = {
	signIn: 'sign-in',
	signUp: 'sign-up',
	reset: 'reset-password'
} as const;
