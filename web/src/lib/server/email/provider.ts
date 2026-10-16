// Transport-agnostic e-mail contract. Adapters (Resend today) implement `EmailProvider`; callers
// never see vendor payloads. Errors carry a kind, an HTTP status and a vendor error code at most:
// never the address, the subject, the body or the vendor's free-text message (which may echo
// any of those).
import { toHex, utf8 } from './bytes.ts';

/** Resend tag: ASCII letters, digits, `_` and `-`, 1 to 256 characters each. */
export interface EmailTag {
	name: string;
	value: string;
}

export interface EmailMessage {
	/** A single recipient. */
	to: string;
	subject: string;
	html: string;
	text: string;
	/**
	 * Stable key for this logical message (same key on every retry and re-send of the same
	 * event). Printable ASCII without spaces, 1 to 256 characters. Must not contain the address:
	 * use {@link buildIdempotencyKey}.
	 */
	idempotencyKey: string;
	tags?: readonly EmailTag[];
}

export interface EmailSendResult {
	/** Provider message id (not personal data). */
	id: string;
}

export interface EmailProvider {
	/** Resolves with the provider id or rejects with an {@link EmailError}. */
	send(message: EmailMessage): Promise<EmailSendResult>;
}

export type EmailErrorKind =
	/** The address is on the suppression list (bounce or complaint); nothing was sent. */
	| 'suppressed'
	/** The message or its metadata is malformed (caller bug); retrying will not help. */
	| 'invalid'
	/** The provider is throttling us and the retry budget ran out. */
	| 'rate-limited'
	/** Network failure, timeout or 5xx after the retry budget ran out. */
	| 'unavailable'
	/** The provider refused the request (credentials, domain, permissions). */
	| 'rejected';

export interface EmailErrorDetails {
	status?: number;
	/** Vendor error name such as `validation_error`; only short snake_case identifiers kept. */
	code?: string;
}

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export class EmailError extends Error {
	readonly kind: EmailErrorKind;
	readonly status: number | null;
	readonly code: string | null;

	/** `reason` must be a fixed, PII-free description written in code, never a vendor string. */
	constructor(kind: EmailErrorKind, reason: string, details: EmailErrorDetails = {}) {
		const code = details.code !== undefined && SAFE_CODE.test(details.code) ? details.code : null;
		const status = details.status ?? null;
		const suffix = [status, code].filter((part) => part !== null).join(' ');
		super(`email ${kind}: ${reason}${suffix ? ` (${suffix})` : ''}`);
		this.name = 'EmailError';
		this.kind = kind;
		this.status = status;
		this.code = code;
	}
}

export function isEmailError(error: unknown): error is EmailError {
	return error instanceof EmailError;
}

const TAG_PART = /^[A-Za-z0-9_-]{1,256}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,256}$/;

/** Throws `invalid` when the key or tags do not meet the provider limits. */
export function assertMessageMetadata(message: EmailMessage): void {
	if (!IDEMPOTENCY_KEY.test(message.idempotencyKey)) {
		throw new EmailError('invalid', 'idempotency key must be 1 to 256 printable ASCII characters');
	}
	for (const tag of message.tags ?? []) {
		if (!TAG_PART.test(tag.name) || !TAG_PART.test(tag.value)) {
			throw new EmailError('invalid', 'tag names and values must match [A-Za-z0-9_-]{1,256}');
		}
	}
	if (message.to.trim() === '' || /[\r\n]/.test(message.to)) {
		throw new EmailError('invalid', 'recipient is empty or malformed');
	}
}

/**
 * Idempotency key for one logical e-mail: `<scope>:<sha256 hex of the parts>`. Pass the parts
 * that identify the event (user id, token id, ...); they are hashed, so the key reveals none of
 * them. `scope` is usually the template id.
 */
export async function buildIdempotencyKey(
	scope: string,
	...parts: readonly string[]
): Promise<string> {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(scope)) {
		throw new EmailError('invalid', 'idempotency scope must be a short lowercase identifier');
	}
	const digest = await crypto.subtle.digest('SHA-256', utf8(parts.join('\u0000')));
	return `${scope}:${toHex(digest)}`;
}
