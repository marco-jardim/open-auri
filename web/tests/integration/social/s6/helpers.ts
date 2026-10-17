// Fixtures of the S6 route tests (T4.9): synthetic route events, receipts and row readers.
import { env } from 'cloudflare:workers';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { S6_CONSENT_VERSION } from '#lib/server/social/s6.ts';
import { ORIGIN, randomIp, signedOut } from '../../api/helpers.ts';
import { publish, seedUser } from '../repo/helpers.ts';

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

/**
 * Unique ids that are NOT eligible S6 items (no preset, no listable lineage): refused by the
 * route, and dropped by the aggregation when stored directly.
 */
export function unknownItemIds(count: number): string[] {
	const prefix = `s6t-${base64Url(crypto.getRandomValues(new Uint8Array(6)))
		.toLowerCase()
		.replace(/[^a-z0-9]/g, 'x')}`;
	return Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
}

/**
 * Unique eligible item ids: the curve ids of fresh lineages with the given visibility (public =
 * publicly listable, the only kind S6 accepts besides the official presets).
 */
export async function itemIds(
	count: number,
	visibility: 'public' | 'unlisted' | 'private' = 'public'
): Promise<string[]> {
	const owner = await seedUser();
	const ids: string[] = [];
	for (let i = 0; i < count; i++) ids.push((await publish(owner.id, { visibility })).curve.id);
	return ids;
}

/** Inserts a batch row and its pairs straight into D1 (any ids, any day), in the given order. */
export async function storeBatch(
	day: string,
	pairs: readonly [string, string, 'a' | 'b' | 'tie'][]
): Promise<string> {
	const id = `s6seed-${base64Url(crypto.getRandomValues(new Uint8Array(9)))}`;
	const statements = [
		env.DB.prepare(
			'INSERT INTO s6_batches (id, receipt_hash, consent_ver, day) VALUES (?, ?, ?, ?)'
		).bind(id, await sha256Hex(newReceipt()), S6_CONSENT_VERSION, day)
	];
	for (const [a, b, choice] of pairs) {
		statements.push(
			env.DB.prepare(
				'INSERT INTO s6_pairs (batch_id, a, b, choice, level_matched) VALUES (?, ?, ?, ?, 1)'
			).bind(id, a, b, choice)
		);
	}
	await env.DB.batch(statements);
	return id;
}

export async function dropBatch(id: string): Promise<void> {
	await env.DB.prepare('DELETE FROM s6_batches WHERE id = ?').bind(id).run();
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
