// Fixtures of the activity tests (T4.4): synthetic route events for the real `+server.ts`
// handlers, signed-in locals of seeded users, and small D1 readers. Users, lineages and shares
// are unique per test, so the files can share the database.
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { createShare, countsForLineages } from '#lib/server/social/repo.ts';
import type { PublicCounts } from '#lib/server/social/types.ts';
import { locals, origin, uid, type SeededUser } from '../../account/helpers.ts';

export { ban, member, publish, seedUser, sid } from '../repo/helpers.ts';
export { count, type SeededUser } from '../../account/helpers.ts';

export const SIGNED_OUT: AuthLocals = { user: null, session: null };

export function signedIn(
	user: SeededUser,
	overrides: { emailVerified?: boolean; banned?: boolean } = {}
) {
	return locals(user, uid('session'), overrides);
}

function randomIp(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(3));
	return `10.${bytes[0] ?? 0}.${bytes[1] ?? 0}.${bytes[2] ?? 1}`;
}

export interface RouteEventInit {
	method?: string;
	path: string;
	routeId: string;
	locals: AuthLocals;
	params?: { id?: string };
	body?: unknown;
	/** Overrides the Origin header (null removes it). */
	origin?: string | null;
}

export interface RouteEvent {
	request: Request;
	locals: AuthLocals;
	platform: { env: unknown };
	route: { id: string };
	params: { id?: string };
	url: URL;
}

export function routeEvent(init: RouteEventInit): RouteEvent {
	const method = init.method ?? 'GET';
	const url = new URL(init.path, origin());
	const headers: Record<string, string> = { 'cf-connecting-ip': randomIp() };
	const sendOrigin = init.origin === undefined ? origin() : init.origin;
	if (method !== 'GET' && sendOrigin !== null) headers.origin = sendOrigin;
	if (init.body !== undefined) headers['content-type'] = 'application/json';
	return {
		request: new Request(url, {
			method,
			headers,
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
		}),
		locals: init.locals,
		platform: { env },
		route: { id: init.routeId },
		params: init.params ?? {},
		url
	};
}

export const ACTIVITY_ROUTE = '/api/v1/curves/[id]/activity';
export const AUDIENCE_ROUTE = '/api/v1/curves/[id]/audience';
export const ME_ROUTE = '/api/v1/me/activity';
export const OUTBOX_ROUTE = '/api/v1/me/activity/outbox';

export function activityEvent(lineageId: string, auth: AuthLocals, body: unknown): RouteEvent {
	return routeEvent({
		method: 'POST',
		path: `/api/v1/curves/${lineageId}/activity`,
		routeId: ACTIVITY_ROUTE,
		params: { id: lineageId },
		locals: auth,
		body
	});
}

export function previewBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { kind: 'previewed', durationMs: 12_000, eventId: crypto.randomUUID(), ...overrides };
}

export function installBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { kind: 'installed', eventId: crypto.randomUUID(), ...overrides };
}

export async function publicCounts(lineageId: string): Promise<PublicCounts> {
	const counts = await countsForLineages(env.DB, [lineageId], { userId: null });
	const entry = counts.get(lineageId);
	if (!entry) throw new Error('lineage not listed');
	return entry;
}

export async function activityRow(
	userId: string,
	lineageId: string,
	kind: string
): Promise<{ first_at: number; last_at: number; count: number } | null> {
	return env.DB.prepare(
		'SELECT first_at, last_at, count FROM activity WHERE user_id = ? AND lineage_id = ? AND kind = ?'
	)
		.bind(userId, lineageId, kind)
		.first<{ first_at: number; last_at: number; count: number }>();
}

export async function share(lineageId: string, ownerUserId: string): Promise<string> {
	const id = uid('shr');
	const created = await createShare(env.DB, {
		id,
		lineageId,
		versionId: null,
		ownerUserId,
		channel: null,
		now: Date.now()
	});
	if (!created.ok) throw new Error(`share failed: ${created.code}`);
	return id;
}

export async function errorCode(response: Response, status: number): Promise<unknown> {
	expect(response.status).toBe(status);
	const body = (await response.json()) as { error: { code: string; details?: unknown } };
	return body.error;
}
