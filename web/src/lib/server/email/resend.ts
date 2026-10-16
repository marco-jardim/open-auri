// Resend adapter (POST https://api.resend.com/emails).
//
// Retry policy, at most `maxAttempts` (3) requests per send, all with the same Idempotency-Key so
// Resend deduplicates a request that succeeded but whose response was lost:
// - 5xx, 429 and 409 `concurrent_idempotent_requests` are retried with exponential backoff and
//   jitter; a `Retry-After` header (seconds or HTTP date) replaces the computed delay. A
//   `Retry-After` longer than `maxDelayMs` ends the attempts at once (waitUntil work must finish
//   shortly after the response).
// - Network failures and timeouts are retried too: the request may never have reached Resend, and
//   the idempotency key makes a duplicate harmless.
// - Any other 4xx (400, 401, 403, 404, 409 `invalid_idempotent_request`, 422, ...) is final.
import {
	assertMessageMetadata,
	EmailError,
	type EmailMessage,
	type EmailProvider,
	type EmailSendResult
} from './provider.ts';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface FetchInit {
	method: 'POST';
	headers: Record<string, string>;
	body: string;
	signal?: AbortSignal;
}

/** The subset of `Response` the adapter reads. */
export interface FetchResponse {
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export interface ResendProviderOptions {
	apiKey: string;
	/** `Name <address>` or a bare address on a verified domain. */
	from: string;
	/** Required by Resend; identifies the app, e.g. `open-auri-web/1`. */
	userAgent: string;
	/** Defaults to the global `fetch`, looked up at call time (so test interceptors apply). */
	fetch?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
	/** Uniform [0, 1) source for jitter. */
	random?: () => number;
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	/** Per-attempt timeout. */
	timeoutMs?: number;
	now?: () => number;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ResendErrorBody {
	name?: unknown;
}

async function readErrorCode(response: FetchResponse): Promise<string | undefined> {
	try {
		const body: unknown = JSON.parse(await response.text());
		if (typeof body === 'object' && body !== null) {
			const name = (body as ResendErrorBody).name;
			if (typeof name === 'string') return name;
		}
	} catch {
		// Non-JSON error body: the status alone classifies it.
		return undefined;
	}
	return undefined;
}

/** Milliseconds requested by `Retry-After` (delta-seconds or HTTP date), or null. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
	if (value === null) return null;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return null;
	return Math.max(0, date - nowMs);
}

type AttemptOutcome =
	| { done: true; result: EmailSendResult }
	| { done: false; retry: boolean; error: EmailError; retryAfterMs: number | null };

export class ResendProvider implements EmailProvider {
	readonly #apiKey: string;
	readonly #from: string;
	readonly #userAgent: string;
	readonly #fetch: FetchLike;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #random: () => number;
	readonly #maxAttempts: number;
	readonly #baseDelayMs: number;
	readonly #maxDelayMs: number;
	readonly #timeoutMs: number;
	readonly #now: () => number;

	constructor(options: ResendProviderOptions) {
		if (!options.apiKey) throw new EmailError('rejected', 'Resend API key is missing');
		if (!options.from) throw new EmailError('invalid', 'sender address is missing');
		if (!options.userAgent) throw new EmailError('invalid', 'User-Agent is required by Resend');
		this.#apiKey = options.apiKey;
		this.#from = options.from;
		this.#userAgent = options.userAgent;
		this.#fetch = options.fetch ?? defaultFetch;
		this.#sleep = options.sleep ?? defaultSleep;
		this.#random = options.random ?? Math.random;
		this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
		this.#baseDelayMs = options.baseDelayMs ?? 300;
		this.#maxDelayMs = options.maxDelayMs ?? 8000;
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#now = options.now ?? Date.now;
	}

	async send(message: EmailMessage): Promise<EmailSendResult> {
		assertMessageMetadata(message);
		const body = JSON.stringify({
			from: this.#from,
			to: [message.to],
			subject: message.subject,
			html: message.html,
			text: message.text,
			...(message.tags && message.tags.length > 0
				? { tags: message.tags.map(({ name, value }) => ({ name, value })) }
				: {})
		});
		const headers = {
			Authorization: `Bearer ${this.#apiKey}`,
			'Content-Type': 'application/json',
			'User-Agent': this.#userAgent,
			'Idempotency-Key': message.idempotencyKey
		};

		let lastError = new EmailError('unavailable', 'no attempt was made');
		for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
			const outcome = await this.#attempt(headers, body);
			if (outcome.done) return outcome.result;
			lastError = outcome.error;
			if (!outcome.retry || attempt === this.#maxAttempts) break;

			const delay = outcome.retryAfterMs ?? this.#backoff(attempt);
			if (delay > this.#maxDelayMs) break;
			await this.#sleep(delay);
		}
		throw lastError;
	}

	/** Exponential backoff with equal jitter: half fixed, half random. */
	#backoff(attempt: number): number {
		const ceiling = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (attempt - 1));
		return Math.round(ceiling / 2 + this.#random() * (ceiling / 2));
	}

	async #attempt(headers: Record<string, string>, body: string): Promise<AttemptOutcome> {
		let response: FetchResponse;
		try {
			response = await this.#fetch(RESEND_ENDPOINT, {
				method: 'POST',
				headers,
				body,
				signal: AbortSignal.timeout(this.#timeoutMs)
			});
		} catch {
			return {
				done: false,
				retry: true,
				error: new EmailError('unavailable', 'network failure or timeout'),
				retryAfterMs: null
			};
		}

		const status = response.status;
		if (status >= 200 && status < 300) {
			let id: unknown;
			try {
				id = (JSON.parse(await response.text()) as { id?: unknown }).id;
			} catch {
				id = undefined;
			}
			if (typeof id !== 'string' || id === '') {
				return {
					done: false,
					retry: false,
					error: new EmailError('unavailable', 'Resend accepted without a message id', { status }),
					retryAfterMs: null
				};
			}
			return { done: true, result: { id } };
		}

		const code = await readErrorCode(response);
		const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'), this.#now());
		const details = { status, ...(code === undefined ? {} : { code }) };

		if (status === 429) {
			return {
				done: false,
				retry: true,
				error: new EmailError('rate-limited', 'Resend is throttling requests', details),
				retryAfterMs
			};
		}
		if (status >= 500) {
			return {
				done: false,
				retry: true,
				error: new EmailError('unavailable', 'Resend server error', details),
				retryAfterMs
			};
		}
		if (status === 409 && code === 'concurrent_idempotent_requests') {
			return {
				done: false,
				retry: true,
				error: new EmailError('unavailable', 'same idempotency key still in flight', details),
				retryAfterMs
			};
		}
		if (status === 401 || status === 403) {
			return {
				done: false,
				retry: false,
				error: new EmailError('rejected', 'Resend refused the credentials or sender', details),
				retryAfterMs: null
			};
		}
		return {
			done: false,
			retry: false,
			error: new EmailError('invalid', 'Resend rejected the request', details),
			retryAfterMs: null
		};
	}
}
