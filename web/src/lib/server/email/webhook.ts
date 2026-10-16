// Resend webhook (svix-signed): hard bounces and complaints go to the suppression list.
//
// Verification follows the svix scheme: headers `svix-id`, `svix-timestamp` (unix seconds) and
// `svix-signature` (space-separated `v1,<base64>` entries, any of which may match); the secret is
// the base64 after `whsec_`; the signature is HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`.
// Timestamps further than 5 minutes from now are rejected; every candidate is compared in
// constant time. A processed svix-id is recorded in `email_webhook_events` in the same D1 batch
// as the suppression rows, so a replay (or svix's own redelivery) writes nothing new.
//
// Bounces: Resend's `email.bounced` payload carries `data.bounce.type` (`Permanent`,
// `Transient`, `Undetermined`, from SES). Only `Permanent` suppresses. A payload without
// `data.bounce.type` is treated as permanent: a missing classification must not keep e-mailing
// a dead mailbox (which hurts sender reputation).
//
// No personal data is logged: only the event type, the outcome and counts.
import type { D1Database } from '@cloudflare/workers-types';
import { batch, sql, type BoundStatement } from '../db.ts';
import type { ServerEnv } from '../env.ts';
import { fromBase64, timingSafeEqual, toBase64, utf8 } from './bytes.ts';
import { SuppressionList, type SuppressionReason } from './suppression.ts';

export const SVIX_TOLERANCE_SECONDS = 5 * 60;
/** Resend payloads are a few KiB; anything far larger is refused before hashing. */
export const MAX_WEBHOOK_BODY_BYTES = 128 * 1024;
/** Processed svix-ids are kept this long; svix stops redelivering after a few days. */
export const WEBHOOK_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound of recipients read from one event. */
const MAX_RECIPIENTS = 50;

const SVIX_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SVIX_TIMESTAMP = /^\d{1,12}$/;

export type SvixFailure = 'missing-headers' | 'bad-secret' | 'stale' | 'bad-signature';

export interface SvixInput {
	/** `whsec_<base64>` (the prefix is optional). */
	secret: string;
	id: string | null;
	timestamp: string | null;
	signature: string | null;
	body: string;
	nowMs: number;
	toleranceSeconds?: number;
}

/** Decodes the signing key; null when the secret is not valid base64. */
export function parseSvixSecret(secret: string): Uint8Array<ArrayBuffer> | null {
	const encoded = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
	return fromBase64(encoded);
}

/** Base64 `v1` signature for the given parts (also used by tests to sign fixtures). */
export async function computeSvixSignature(
	key: Uint8Array<ArrayBuffer>,
	id: string,
	timestamp: string,
	body: string
): Promise<string> {
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		key,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign('HMAC', cryptoKey, utf8(`${id}.${timestamp}.${body}`));
	return toBase64(mac);
}

export async function verifySvixSignature(
	input: SvixInput
): Promise<{ ok: true } | { ok: false; reason: SvixFailure }> {
	const { id, timestamp, signature } = input;
	if (!id || !timestamp || !signature || !SVIX_ID.test(id) || !SVIX_TIMESTAMP.test(timestamp)) {
		return { ok: false, reason: 'missing-headers' };
	}
	const key = parseSvixSecret(input.secret);
	if (key === null) return { ok: false, reason: 'bad-secret' };

	const tolerance = input.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS;
	if (Math.abs(input.nowMs / 1000 - Number(timestamp)) > tolerance) {
		return { ok: false, reason: 'stale' };
	}

	const expected = fromBase64(await computeSvixSignature(key, id, timestamp, input.body));
	if (expected === null) return { ok: false, reason: 'bad-signature' };
	let matched = false;
	for (const entry of signature.split(' ')) {
		const comma = entry.indexOf(',');
		if (comma < 0 || entry.slice(0, comma) !== 'v1') continue;
		const candidate = fromBase64(entry.slice(comma + 1));
		// No early exit: every candidate is checked.
		if (candidate !== null && timingSafeEqual(candidate, expected)) matched = true;
	}
	return matched ? { ok: true } : { ok: false, reason: 'bad-signature' };
}

export interface SuppressionIntent {
	reason: SuppressionReason;
	addresses: string[];
}

function recipients(data: Record<string, unknown>): string[] {
	const to = data['to'];
	const list = Array.isArray(to) ? to : [to];
	return list
		.filter((value): value is string => typeof value === 'string' && value.includes('@'))
		.slice(0, MAX_RECIPIENTS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a verified event asks for: `null` for events that do not suppress (delivered, opened,
 * transient bounces, unknown types).
 */
export function suppressionIntent(event: unknown): SuppressionIntent | null {
	if (!isRecord(event) || !isRecord(event['data'])) return null;
	const data = event['data'];
	if (event['type'] === 'email.complained') {
		return { reason: 'complaint', addresses: recipients(data) };
	}
	if (event['type'] === 'email.bounced') {
		const bounce = data['bounce'];
		const bounceType = isRecord(bounce) ? bounce['type'] : undefined;
		const permanent = typeof bounceType !== 'string' || bounceType.toLowerCase() === 'permanent';
		return permanent ? { reason: 'bounce', addresses: recipients(data) } : null;
	}
	return null;
}

export type WebhookOutcome =
	| 'suppressed'
	| 'ignored'
	| 'replay'
	| 'invalid-signature'
	| 'stale'
	| 'missing-headers'
	| 'malformed'
	| 'misconfigured';

export interface WebhookResult {
	status: 204 | 400 | 401 | 503;
	outcome: WebhookOutcome;
	/** Event type, only when the signature was valid and the type is a short identifier. */
	eventType?: string;
	suppressedCount?: number;
}

export interface WebhookInput {
	db: D1Database;
	/** RESEND_WEBHOOK_SECRET. */
	webhookSecret: string;
	/** BETTER_AUTH_SECRET (suppression hash key, see suppression.ts). */
	suppressionSecret: string;
	headers: { get(name: string): string | null };
	rawBody: string;
	nowMs: number;
}

/** Verifies, de-duplicates and applies one webhook delivery. Pure apart from D1 writes. */
export async function handleResendWebhook(input: WebhookInput): Promise<WebhookResult> {
	const verification = await verifySvixSignature({
		secret: input.webhookSecret,
		id: input.headers.get('svix-id'),
		timestamp: input.headers.get('svix-timestamp'),
		signature: input.headers.get('svix-signature'),
		body: input.rawBody,
		nowMs: input.nowMs
	});
	if (!verification.ok) {
		switch (verification.reason) {
			case 'missing-headers':
				return { status: 400, outcome: 'missing-headers' };
			case 'bad-secret':
				return { status: 503, outcome: 'misconfigured' };
			case 'stale':
				return { status: 401, outcome: 'stale' };
			case 'bad-signature':
				return { status: 401, outcome: 'invalid-signature' };
		}
	}
	// Verified above, so the header is present and well-formed.
	const eventId = input.headers.get('svix-id') ?? '';

	let event: unknown;
	try {
		event = JSON.parse(input.rawBody);
	} catch {
		return { status: 400, outcome: 'malformed' };
	}
	const rawType = isRecord(event) ? event['type'] : undefined;
	const eventType =
		typeof rawType === 'string' && /^[a-z0-9_.]{1,64}$/.test(rawType) ? rawType : 'unknown';

	const intent = suppressionIntent(event);
	if (intent === null || intent.addresses.length === 0) {
		return { status: 204, outcome: 'ignored', eventType };
	}

	const list = new SuppressionList(input.db, input.suppressionSecret);
	const statements: BoundStatement[] = [];
	for (const address of intent.addresses) {
		statements.push(
			await list.suppressStatement(address, intent.reason, input.nowMs, eventId, eventId)
		);
	}
	statements.push(
		sql(
			input.db,
			'INSERT OR IGNORE INTO email_webhook_events (id, received_at) VALUES (?, ?)',
			eventId,
			input.nowMs
		),
		sql(
			input.db,
			'DELETE FROM email_webhook_events WHERE received_at < ?',
			input.nowMs - WEBHOOK_EVENT_RETENTION_MS
		)
	);
	const results = await batch(input.db, statements);
	const eventInsert = results[intent.addresses.length];
	if (!eventInsert || eventInsert.meta.changes === 0) {
		return { status: 204, outcome: 'replay', eventType };
	}
	const suppressedCount = results
		.slice(0, intent.addresses.length)
		.reduce((sum, result) => sum + result.meta.changes, 0);
	return { status: 204, outcome: 'suppressed', eventType, suppressedCount };
}

export interface WebhookLogger {
	warn(message: string, details: Record<string, string | number>): void;
	info(message: string, details: Record<string, string | number>): void;
}

export interface RespondOptions {
	now?: () => number;
	logger?: WebhookLogger;
}

/** HTTP wrapper used by `routes/api/webhooks/resend/+server.ts`. */
export async function respondToResendWebhook(
	request: Request,
	env: ServerEnv,
	options: RespondOptions = {}
): Promise<Response> {
	const logger = options.logger ?? console;
	const now = options.now ?? Date.now;

	if (request.method !== 'POST') {
		return new Response(null, { status: 405, headers: { Allow: 'POST' } });
	}
	const webhookSecret = env.secrets.resendWebhookSecret;
	if (!webhookSecret) {
		logger.warn('email.webhook disabled', { reason: 'RESEND_WEBHOOK_SECRET is not set' });
		return new Response(null, { status: 503 });
	}

	const declared = Number(request.headers.get('content-length') ?? '0');
	if (declared > MAX_WEBHOOK_BODY_BYTES) return new Response(null, { status: 413 });
	const rawBody = await request.text();
	if (utf8(rawBody).byteLength > MAX_WEBHOOK_BODY_BYTES) {
		return new Response(null, { status: 413 });
	}

	const result = await handleResendWebhook({
		db: env.db,
		webhookSecret,
		suppressionSecret: env.secrets.betterAuthSecret,
		headers: request.headers,
		rawBody,
		nowMs: now()
	});

	const details: Record<string, string | number> = { outcome: result.outcome };
	if (result.eventType) details['event'] = result.eventType;
	if (result.suppressedCount !== undefined) details['suppressed'] = result.suppressedCount;
	if (result.status === 204) logger.info('email.webhook', details);
	else logger.warn('email.webhook rejected', details);

	return new Response(null, { status: result.status });
}
