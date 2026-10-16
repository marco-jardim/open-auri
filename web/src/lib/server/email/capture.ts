// Dev-only mail capture (EMAIL_TRANSPORT=capture) for the local end-to-end suite: instead of
// calling Resend, messages are written to the D1 table `dev_mail_outbox`, and
// GET /api/dev/mailbox?to=<address> returns the latest ones so Playwright can follow the links.
//
// Guards (all three must hold before anything is captured or served):
//   1. getServerEnv refuses EMAIL_TRANSPORT=capture unless PUBLIC_ORIGIN is localhost/127.0.0.1;
//   2. createCaptureProvider and respondToMailboxRequest re-check the origin (defense in depth);
//   3. the endpoint answers 404 unless the transport is `capture` and the request itself was made
//      to a loopback host.
// No migration: the table is created lazily (CREATE TABLE IF NOT EXISTS) the first time capture
// mode touches it, so the production schema never contains a mailbox of plain addresses.
// `id` is the SHA-256 of the idempotency key, so a re-send of the same logical message is
// ignored, like Resend's Idempotency-Key (the auth tests rely on it).
import type { D1Database } from '@cloudflare/workers-types';
import { isLocalOrigin, type ServerEnv } from '../env.ts';
import { toHex, utf8 } from './bytes.ts';
import {
	assertMessageMetadata,
	EmailError,
	type EmailMessage,
	type EmailProvider,
	type EmailSendResult
} from './provider.ts';
import { normalizeAddress } from './suppression.ts';

export const DEV_MAILBOX_TABLE = 'dev_mail_outbox';
export const DEV_MAILBOX_PATH = '/api/dev/mailbox';
/** Most messages returned by one mailbox request. */
export const DEV_MAILBOX_LIMIT = 20;

const CREATE_TABLE =
	'CREATE TABLE IF NOT EXISTS dev_mail_outbox (' +
	'id TEXT PRIMARY KEY, to_hash TEXT NOT NULL, to_address TEXT NOT NULL, subject TEXT NOT NULL, ' +
	'text TEXT NOT NULL, html TEXT NOT NULL, created_at INTEGER NOT NULL)';
const CREATE_INDEX =
	'CREATE INDEX IF NOT EXISTS dev_mail_outbox_to ON dev_mail_outbox (to_hash, created_at)';

const ready = new WeakSet<object>();

async function ensureTable(db: D1Database): Promise<void> {
	if (ready.has(db)) return;
	await db.batch([db.prepare(CREATE_TABLE), db.prepare(CREATE_INDEX)]);
	ready.add(db);
}

async function sha256(value: string): Promise<string> {
	return toHex(await crypto.subtle.digest('SHA-256', utf8(value)));
}

/** Lookup key of an address (normalized like the suppression list). */
export function mailboxKey(address: string): Promise<string> {
	return sha256(normalizeAddress(address));
}

export interface CapturedEmail {
	id: string;
	to: string;
	subject: string;
	text: string;
	html: string;
	createdAt: number;
}

type CaptureEnv = Pick<ServerEnv, 'db' | 'publicOrigin' | 'emailTransport'>;

function assertCaptureAllowed(env: CaptureEnv): void {
	if (env.emailTransport !== 'capture' || !isLocalOrigin(env.publicOrigin)) {
		throw new EmailError('rejected', 'mail capture is only available on a local origin');
	}
}

/** The capture transport. Throws `rejected` when the env is not a local capture env. */
export function createCaptureProvider(
	env: CaptureEnv,
	now: () => number = Date.now
): EmailProvider {
	assertCaptureAllowed(env);
	return {
		async send(message: EmailMessage): Promise<EmailSendResult> {
			assertMessageMetadata(message);
			await ensureTable(env.db);
			const id = await sha256(message.idempotencyKey);
			await env.db
				.prepare(
					'INSERT OR IGNORE INTO dev_mail_outbox ' +
						'(id, to_hash, to_address, subject, text, html, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
				)
				.bind(
					id,
					await mailboxKey(message.to),
					message.to,
					message.subject,
					message.text,
					message.html,
					now()
				)
				.run();
			return { id: `capture_${id.slice(0, 32)}` };
		}
	};
}

/** Latest captured messages for `address`, newest first. */
export async function readMailbox(
	env: CaptureEnv,
	address: string,
	limit = DEV_MAILBOX_LIMIT
): Promise<CapturedEmail[]> {
	assertCaptureAllowed(env);
	await ensureTable(env.db);
	const { results } = await env.db
		.prepare(
			'SELECT id, to_address, subject, text, html, created_at FROM dev_mail_outbox ' +
				'WHERE to_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
		)
		.bind(await mailboxKey(address), Math.max(1, Math.min(limit, DEV_MAILBOX_LIMIT)))
		.all<{
			id: string;
			to_address: string;
			subject: string;
			text: string;
			html: string;
			created_at: number;
		}>();
	return results.map((row) => ({
		id: row.id,
		to: row.to_address,
		subject: row.subject,
		text: row.text,
		html: row.html,
		createdAt: row.created_at
	}));
}

function isLoopbackRequest(request: Request): boolean {
	try {
		return isLocalOrigin(new URL(request.url).origin);
	} catch {
		return false;
	}
}

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * GET /api/dev/mailbox?to=<address>. 404 (empty, indistinguishable from a missing route) unless
 * this is a local capture env and the request was made to a loopback host.
 */
export async function respondToMailboxRequest(
	request: Request,
	env: CaptureEnv
): Promise<Response> {
	if (
		env.emailTransport !== 'capture' ||
		!isLocalOrigin(env.publicOrigin) ||
		!isLoopbackRequest(request)
	) {
		return new Response(null, { status: 404, headers: NO_STORE });
	}
	if (request.method !== 'GET') {
		return new Response(null, { status: 405, headers: { ...NO_STORE, allow: 'GET' } });
	}
	const to = new URL(request.url).searchParams.get('to')?.trim() ?? '';
	if (!to.includes('@') || to.length > 254) {
		return Response.json({ code: 'INVALID_ADDRESS' }, { status: 400, headers: NO_STORE });
	}
	const messages = await readMailbox(env, to);
	return Response.json({ messages }, { headers: NO_STORE });
}
