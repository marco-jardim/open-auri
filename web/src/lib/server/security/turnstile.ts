// Server-side Turnstile verification (Siteverify). Fail closed: anything other than a successful
// response whose action and hostname match the expected ones is a failure, and network or
// configuration problems are reported as `unavailable` (callers must reject the request).
// `remoteip` is never sent (plan §3.8: no IP leaves the Worker outside the access log).

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Turnstile tokens are at most 2048 characters. */
export const MAX_TOKEN_LENGTH = 2048;
const TIMEOUT_MS = 5000;

/** Widget actions used by the app (≤ 32 chars of [a-z0-9_-], as Turnstile requires). */
export const TURNSTILE_ACTIONS = {
	signUp: 'sign-up',
	signIn: 'sign-in',
	reset: 'reset-password',
	changeEmail: 'change-email',
	report: 'report',
	s6: 's6-submit'
} as const;
export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];

export type TurnstileFailure =
	'missing' | 'invalid' | 'expired-or-duplicate' | 'action' | 'hostname' | 'unavailable';

export type TurnstileResult = { ok: true } | { ok: false; reason: TurnstileFailure };

export interface VerifyTurnstileOptions {
	/** Value of `cf-turnstile-response` sent by the client. */
	token: string | null | undefined;
	/** Expected widget action. */
	action: string;
	/** Expected hostname (the hostname of PUBLIC_ORIGIN). */
	hostname: string;
	secret: string;
	fetch?: (input: string, init: RequestInit) => Promise<Response>;
	/** Defaults to a random UUID; reuse the same key when retrying the same verification. */
	idempotencyKey?: string;
}

interface SiteverifyResponse {
	success?: unknown;
	'error-codes'?: unknown;
	action?: unknown;
	hostname?: unknown;
}

function failure(reason: TurnstileFailure): TurnstileResult {
	return { ok: false, reason };
}

/** Maps Siteverify error codes to a reason; configuration and server errors are `unavailable`. */
export function reasonFromErrorCodes(codes: readonly string[]): TurnstileFailure {
	if (codes.includes('timeout-or-duplicate')) return 'expired-or-duplicate';
	if (codes.includes('missing-input-response')) return 'missing';
	if (codes.includes('invalid-input-response')) return 'invalid';
	return 'unavailable';
}

export async function verifyTurnstile(options: VerifyTurnstileOptions): Promise<TurnstileResult> {
	const { token, action, hostname, secret } = options;
	if (typeof token !== 'string' || token.length === 0) return failure('missing');
	if (token.length > MAX_TOKEN_LENGTH) return failure('invalid');
	if (!secret) return failure('unavailable');

	const body = new URLSearchParams({
		secret,
		response: token,
		idempotency_key: options.idempotencyKey ?? crypto.randomUUID()
	});
	// Resolved at call time so test interceptors installed on the global fetch apply.
	const doFetch = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));

	let data: SiteverifyResponse;
	try {
		const response = await doFetch(SITEVERIFY_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (!response.ok) return failure('unavailable');
		const parsed: unknown = await response.json();
		if (typeof parsed !== 'object' || parsed === null) return failure('unavailable');
		data = parsed as SiteverifyResponse;
	} catch {
		// Network error, timeout or a non-JSON body: never treat as success.
		return failure('unavailable');
	}

	if (data.success !== true) {
		const codes = Array.isArray(data['error-codes'])
			? data['error-codes'].filter((code): code is string => typeof code === 'string')
			: [];
		return failure(reasonFromErrorCodes(codes));
	}
	if (data.action !== action) return failure('action');
	if (data.hostname !== hostname) return failure('hostname');
	return { ok: true };
}
