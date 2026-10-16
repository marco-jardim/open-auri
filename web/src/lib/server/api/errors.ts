// Stable error contract of every /api/v1 route: `{ "error": { "code": "...", "details"?: ... } }`
// with `cache-control: no-store`. Codes are part of the public API (clients switch on them):
// append, never rename or reuse. Error bodies never carry user input, e-mails, IPs or tokens.

export const API_ERROR_CODES = [
	'INVALID_BODY',
	'UNSUPPORTED_MEDIA_TYPE',
	'PAYLOAD_TOO_LARGE',
	'BAD_ORIGIN',
	'AUTH_REQUIRED',
	'EMAIL_NOT_VERIFIED',
	'BANNED',
	'FORBIDDEN',
	'NOT_FOUND',
	'REAUTH_REQUIRED',
	'CONFLICT',
	'RATE_LIMITED',
	'RATE_LIMIT_UNAVAILABLE',
	'TURNSTILE_FAILED',
	'INTERNAL',
	'INVALID_CURSOR',
	'INVALID_CURVE',
	'GATE_REJECTED',
	'HEAD_MOVED',
	'ALREADY_ACTIVE',
	'DUPLICATE',
	'GONE',
	'QUOTA_EXCEEDED',
	'CONSENT_REQUIRED'
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Status each code is normally sent with (documentation and defaults; `apiError` takes both). */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
	INVALID_BODY: 400,
	UNSUPPORTED_MEDIA_TYPE: 415,
	PAYLOAD_TOO_LARGE: 413,
	BAD_ORIGIN: 403,
	AUTH_REQUIRED: 401,
	EMAIL_NOT_VERIFIED: 403,
	BANNED: 403,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	REAUTH_REQUIRED: 403,
	CONFLICT: 409,
	RATE_LIMITED: 429,
	RATE_LIMIT_UNAVAILABLE: 503,
	TURNSTILE_FAILED: 403,
	INTERNAL: 500,
	INVALID_CURSOR: 400,
	INVALID_CURVE: 422,
	GATE_REJECTED: 422,
	HEAD_MOVED: 409,
	ALREADY_ACTIVE: 409,
	DUPLICATE: 409,
	GONE: 410,
	QUOTA_EXCEEDED: 429,
	CONSENT_REQUIRED: 400
};

/** JSON-serialisable detail payload (machine-readable; never echoes user input). */
export type ApiJson = string | number | boolean | null | ApiJson[] | { [key: string]: ApiJson };

export interface ApiErrorOptions {
	/** Extra response headers (e.g. `retry-after`). */
	headers?: Readonly<Record<string, string>>;
	cause?: unknown;
}

/** Thrown by the kit and by route handlers; `defineApi` turns it into {@link apiError}. */
export class ApiError extends Error {
	readonly status: number;
	readonly code: ApiErrorCode;
	/** Own property only when details were given (`declare`: no field initialiser is emitted). */
	declare readonly details?: ApiJson;
	readonly headers: Readonly<Record<string, string>>;

	constructor(
		status: number,
		code: ApiErrorCode,
		details?: ApiJson,
		options: ApiErrorOptions = {}
	) {
		super(code, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		if (details !== undefined) this.details = details;
		this.headers = options.headers ?? {};
	}
}

/** The JSON error response. Always `no-store`. */
export function apiError(
	status: number,
	code: ApiErrorCode,
	details?: ApiJson,
	headers: Readonly<Record<string, string>> = {}
): Response {
	const error: { code: ApiErrorCode; details?: ApiJson } = { code };
	if (details !== undefined) error.details = details;
	const out = new Headers(headers);
	out.set('content-type', 'application/json; charset=utf-8');
	out.set('cache-control', 'no-store');
	return new Response(JSON.stringify({ error }), { status, headers: out });
}

/** {@link apiError} for a caught {@link ApiError}. */
export function apiErrorFrom(error: ApiError): Response {
	return apiError(error.status, error.code, error.details, error.headers);
}
