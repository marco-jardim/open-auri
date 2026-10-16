// Fixtures of the S6 route tests (T4.9): synthetic route events, receipts and row readers.
import { env } from 'cloudflare:workers';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { S6_CONSENT_VERSION } from '#lib/server/social/s6.ts';
import { ORIGIN, randomIp, signedOut } from '../../api/helpers.ts';

export interface RouteEventInit {
	method: string;
	path: string;
	routeId: string;
	headers?: Record<string, string>;
	body?: string;
	locals?: AuthLocals;
	platformEnv?: unknown;
	params?: Record<string, string>;
	ip?: string;
}

/** The fields of a SvelteKit RequestEvent the api kit and the S6 routes read. */
export function routeEvent(init: RouteEventInit) {
	const unsafe = init.method !== 'GET' && init.method !== 'HEAD';
	return {
		request: new Request(`${ORIGIN}${init.path}`, {
			method: init.method,
			headers: {
				'cf-connecting-ip': init.ip ?? randomIp(),
				...(unsafe ? { origin: ORIGIN } : {}),
				...init.headers
			},
			...(init.body === undefined ? {} : { body: init.body })
		}),
		locals: init.locals ?? signedOut(),
		platform: { env: init.platformEnv ?? env },
		route: { id: init.routeId },
		params: init.params ?? {},
		url: new URL(`${ORIGIN}${init.path}`)
	};
}

export function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** What the browser generates: 32 random bytes, unpadded base64url. */
export function newReceipt(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Unique item ids per test (the D1 database is shared between files). */
export function itemIds(count: number): string[] {
	const prefix = `s6t-${base64Url(crypto.getRandomValues(new Uint8Array(6)))
		.toLowerCase()
		.replace(/[^a-z0-9]/g, 'x')}`;
	return Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
}

export interface PairBody {
	a: string;
	b: string;
	choice: 'a' | 'b' | 'tie';
	levelMatched: boolean;
}

export function batchBody(
	receipt: string,
	pairs: PairBody[],
	consentVersion: string = S6_CONSENT_VERSION
): string {
	return JSON.stringify({ consentVersion, receipt, pairs });
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function batchRow(receipt: string): Promise<Record<string, unknown> | null> {
	return env.DB.prepare('SELECT * FROM s6_batches WHERE receipt_hash = ?')
		.bind(await sha256Hex(receipt))
		.first<Record<string, unknown>>();
}

export async function pairRows(batchId: string): Promise<Record<string, unknown>[]> {
	const result = await env.DB.prepare('SELECT * FROM s6_pairs WHERE batch_id = ? ORDER BY id')
		.bind(batchId)
		.all<Record<string, unknown>>();
	return result.results;
}

export async function columnsOf(table: string): Promise<string[]> {
	const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
	return result.results.map((row) => row.name).sort();
}
