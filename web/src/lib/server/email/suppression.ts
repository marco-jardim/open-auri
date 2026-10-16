// Suppression list: addresses that hard-bounced or complained are never e-mailed again.
//
// Only an HMAC of the normalized address is stored (table `email_suppressions`, migration 0002),
// so the list does not hold e-mail addresses. Key: HMAC-SHA256(BETTER_AUTH_SECRET,
// "open-auri:email-suppression:v1"), i.e. a purpose-bound subkey of the auth secret.
// BETTER_AUTH_SECRET was chosen over IPHASH_PEPPER because the pepper belongs to IP hashing
// (T3.3) and may follow its own rotation policy; mixing purposes on one key is avoided.
// Consequence: rotating BETTER_AUTH_SECRET orphans the list (old hashes stop matching). The
// rotation runbook must accept that or re-hash is impossible (addresses are not kept); a bounced
// address is re-suppressed by the next bounce webhook.
import type { D1Database } from '@cloudflare/workers-types';
import { first, sql, type BoundStatement } from '../db.ts';
import { toHex, utf8 } from './bytes.ts';
import {
	EmailError,
	type EmailMessage,
	type EmailProvider,
	type EmailSendResult
} from './provider.ts';

export type SuppressionReason = 'bounce' | 'complaint';

const KEY_LABEL = 'open-auri:email-suppression:v1';

/**
 * Canonical form for matching: trimmed, Unicode NFC, lowercased. Lowercasing the local part is
 * stricter than RFC 5321 but errs on the side of not e-mailing a suppressed mailbox.
 */
export function normalizeAddress(address: string): string {
	return address.trim().normalize('NFC').toLowerCase();
}

async function hmacKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** Derives the address-hashing key from the auth secret (purpose-bound subkey). */
export async function deriveSuppressionKey(secret: string): Promise<CryptoKey> {
	if (secret.length < 32) throw new EmailError('invalid', 'suppression secret is too short');
	const root = await hmacKey(utf8(secret));
	const subkey = await crypto.subtle.sign('HMAC', root, utf8(KEY_LABEL));
	return hmacKey(new Uint8Array(subkey));
}

/** Hex HMAC-SHA256 of the normalized address. */
export async function hashAddress(key: CryptoKey, address: string): Promise<string> {
	const mac = await crypto.subtle.sign('HMAC', key, utf8(normalizeAddress(address)));
	return toHex(mac);
}

/** D1-backed list. One instance per request (or per isolate); the derived key is memoized. */
export class SuppressionList {
	readonly #db: D1Database;
	readonly #secret: string;
	#key: Promise<CryptoKey> | null = null;

	constructor(db: D1Database, secret: string) {
		this.#db = db;
		this.#secret = secret;
	}

	hash(address: string): Promise<string> {
		this.#key ??= deriveSuppressionKey(this.#secret);
		return this.#key.then((key) => hashAddress(key, address));
	}

	async isSuppressed(address: string): Promise<boolean> {
		const addressHash = await this.hash(address);
		const row = await first<{ found: number }>(
			sql(this.#db, 'SELECT 1 AS found FROM email_suppressions WHERE address_hash = ?', addressHash)
		);
		return row !== null;
	}

	/**
	 * Insert statement that keeps the first reason recorded for an address. With `unlessEventId`
	 * the row is written only if that webhook event was not processed before (replay guard used
	 * inside the webhook batch).
	 */
	async suppressStatement(
		address: string,
		reason: SuppressionReason,
		createdAt: number,
		eventId: string | null,
		unlessEventId?: string
	): Promise<BoundStatement> {
		const addressHash = await this.hash(address);
		if (unlessEventId === undefined) {
			return sql(
				this.#db,
				'INSERT OR IGNORE INTO email_suppressions (address_hash, reason, created_at, event_id) VALUES (?, ?, ?, ?)',
				addressHash,
				reason,
				createdAt,
				eventId
			);
		}
		return sql(
			this.#db,
			'INSERT OR IGNORE INTO email_suppressions (address_hash, reason, created_at, event_id) ' +
				'SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM email_webhook_events WHERE id = ?)',
			addressHash,
			reason,
			createdAt,
			eventId,
			unlessEventId
		);
	}
}

export interface SuppressionCheck {
	isSuppressed(address: string): Promise<boolean>;
}

/** Wraps a provider so suppressed addresses are refused with `suppressed` before any request. */
export function withSuppression(provider: EmailProvider, list: SuppressionCheck): EmailProvider {
	return {
		async send(message: EmailMessage): Promise<EmailSendResult> {
			if (await list.isSuppressed(message.to)) {
				throw new EmailError('suppressed', 'recipient is on the suppression list');
			}
			return provider.send(message);
		}
	};
}
