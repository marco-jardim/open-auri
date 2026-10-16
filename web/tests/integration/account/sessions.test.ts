// Active sessions of /conta: listing (approximate device, last activity, expired ones hidden) and
// revocation, always scoped to the owner.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	listAccountSessions,
	parseDevice,
	revokeAccountSession,
	revokeOtherAccountSessions
} from '#lib/server/account/sessions.ts';
import { DAY, count, seedSession, seedUser } from './helpers.ts';

async function exists(sessionId: string): Promise<boolean> {
	return (await count('SELECT count(*) AS n FROM "session" WHERE "id" = ?', sessionId)) === 1;
}

describe('parseDevice', () => {
	it('splits the reduced user agent and treats Other as unknown', () => {
		expect(parseDevice('Firefox on Linux')).toEqual({ browser: 'Firefox', os: 'Linux' });
		expect(parseDevice('Samsung Internet on Android')).toEqual({
			browser: 'Samsung Internet',
			os: 'Android'
		});
		expect(parseDevice('Other on Windows')).toEqual({ browser: null, os: 'Windows' });
		expect(parseDevice('Other on Other')).toEqual({ browser: null, os: null });
		expect(parseDevice('')).toEqual({ browser: null, os: null });
		expect(parseDevice(null)).toEqual({ browser: null, os: null });
	});
});

describe('listAccountSessions', () => {
	it('lists only unexpired sessions of the owner, current first, then by last activity', async () => {
		const now = Date.now();
		const me = await seedUser();
		const them = await seedUser();
		const current = await seedSession(me.id, { userAgent: 'Firefox on Linux', createdAt: now });
		const older = await seedSession(me.id, {
			userAgent: 'Safari on iOS',
			createdAt: now - 5 * DAY,
			updatedAt: now - 2 * DAY
		});
		const recent = await seedSession(me.id, {
			userAgent: 'Chrome on Windows',
			createdAt: now - 3 * DAY,
			updatedAt: now - 60_000
		});
		await seedSession(me.id, { createdAt: now - 10 * DAY, expiresAt: now - DAY });
		await seedSession(them.id);

		const sessions = await listAccountSessions(env.DB, me.id, current.id, now);
		expect(sessions.map((session) => session.id)).toEqual([current.id, recent.id, older.id]);
		expect(sessions[0]).toMatchObject({ current: true, browser: 'Firefox', os: 'Linux' });
		expect(sessions[1]).toMatchObject({
			current: false,
			browser: 'Chrome',
			os: 'Windows',
			lastActiveAt: now - 60_000,
			createdAt: now - 3 * DAY,
			impersonated: false
		});
		for (const session of sessions) {
			expect(Object.keys(session)).not.toContain('token');
		}
	});

	it('flags impersonation sessions', async () => {
		const me = await seedUser();
		const support = await seedSession(me.id);
		await env.DB.prepare('UPDATE "session" SET "impersonatedBy" = ? WHERE "id" = ?')
			.bind('admin-id', support.id)
			.run();
		const [session] = await listAccountSessions(env.DB, me.id, null, Date.now());
		expect(session?.impersonated).toBe(true);
	});
});

describe('revocation', () => {
	it('revokes one session of the owner, never the current one, never someone else’s', async () => {
		const me = await seedUser();
		const them = await seedUser();
		const current = await seedSession(me.id);
		const other = await seedSession(me.id);
		const foreign = await seedSession(them.id);

		expect(await revokeAccountSession(env.DB, me.id, foreign.id, current.id)).toBe('not-found');
		expect(await exists(foreign.id)).toBe(true);
		expect(await revokeAccountSession(env.DB, me.id, current.id, current.id)).toBe('current');
		expect(await exists(current.id)).toBe(true);
		expect(await revokeAccountSession(env.DB, me.id, '', current.id)).toBe('not-found');
		expect(await revokeAccountSession(env.DB, me.id, 'x'.repeat(200), current.id)).toBe(
			'not-found'
		);
		expect(await revokeAccountSession(env.DB, me.id, other.id, current.id)).toBe('revoked');
		expect(await exists(other.id)).toBe(false);
		expect(await revokeAccountSession(env.DB, me.id, other.id, current.id)).toBe('not-found');
	});

	it('"sign out all others" keeps the current session and other users’ sessions', async () => {
		const me = await seedUser();
		const them = await seedUser();
		const current = await seedSession(me.id);
		const a = await seedSession(me.id);
		const b = await seedSession(me.id);
		const foreign = await seedSession(them.id);

		expect(await revokeOtherAccountSessions(env.DB, me.id, current.id)).toBe(2);
		expect(await exists(current.id)).toBe(true);
		expect(await exists(a.id)).toBe(false);
		expect(await exists(b.id)).toBe(false);
		expect(await exists(foreign.id)).toBe(true);
		expect(await revokeOtherAccountSessions(env.DB, me.id, current.id)).toBe(0);
	});
});
