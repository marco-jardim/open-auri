// Edge branches of the account modules: the export of a missing or banned user with pending
// requests, malformed stored dates, bio and visibility validation, the nickname write race and
// odd session rows.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { POLICY_VERSION } from '#lib/content/legal/version.ts';
import { recordDeletionRequest } from '#lib/server/account/deletion.ts';
import { recordEmailChangeRequest } from '#lib/server/account/email-change.ts';
import { handlePolicyRequest } from '#lib/server/account/endpoints.ts';
import {
	accountSection,
	buildAccountExport,
	exportFileName,
	type ExportSection
} from '#lib/server/account/export.ts';
import { changeNickname } from '#lib/server/account/nickname.ts';
import {
	BIO_MAX,
	getAccountProfile,
	sanitizeBio,
	toEpoch,
	updateBio,
	updateVisibility
} from '#lib/server/account/profile.ts';
import { listAccountSessions, parseDevice } from '#lib/server/account/sessions.ts';
import { locals, nick, origin, seedSession, seedUser } from '../account/helpers.ts';

const NOW = Date.UTC(2026, 9, 16, 12);

describe('account export', () => {
	it('a user that no longer exists exports empty sections, not an error', async () => {
		const document = await buildAccountExport({
			db: env.DB,
			userId: 'user-that-does-not-exist',
			currentSessionId: null,
			now: NOW
		});
		expect(document).toMatchObject({
			format: 'open-auri.account-export',
			version: 1,
			generatedAt: new Date(NOW).toISOString(),
			sections: {
				account: null,
				profile: null,
				policyAcceptances: [],
				sessions: [],
				pendingRequests: { emailChange: null, accountClosure: null }
			}
		});
	});

	it('includes ban details, pending e-mail change and closure; no secrets', async () => {
		const user = await seedUser({ username: nick('exp') });
		await env.DB.prepare(
			'UPDATE "user" SET banned = 1, banReason = ?, banExpires = ?, twoFactorEnabled = 1 WHERE id = ?'
		)
			.bind('spam', new Date(NOW + 86_400_000).toISOString(), user.id)
			.run();
		await recordEmailChangeRequest(env.DB, user.id, 'new-address@example.test', NOW);
		await recordDeletionRequest(env.DB, user.id, 'delete-all', NOW);
		const session = await seedSession(user.id, { createdAt: NOW - 1000 });
		const document = await buildAccountExport({
			db: env.DB,
			userId: user.id,
			currentSessionId: session.id,
			now: NOW
		});
		const sections = document.sections as Record<string, Record<string, unknown>>;
		expect(sections.account).toMatchObject({
			banned: true,
			banReason: 'spam',
			twoFactorEnabled: true,
			signInMethods: []
		});
		expect(sections.account?.banExpires).toBe(new Date(NOW + 86_400_000).toISOString());
		expect(sections.pendingRequests).toEqual({
			emailChange: expect.objectContaining({ newEmail: 'new-address@example.test' }),
			accountClosure: { mode: 'delete-all', requestedAt: new Date(NOW).toISOString() }
		});
		expect(JSON.stringify(document)).not.toContain(session.token);
		expect(exportFileName(NOW)).toBe('open-auri-dados-2026-10-16.json');
	});

	it('refuses duplicate section keys', async () => {
		const sections: ExportSection[] = [accountSection, { ...accountSection }];
		await expect(
			buildAccountExport({ db: env.DB, userId: 'x', currentSessionId: null, now: NOW }, sections)
		).rejects.toThrow(/Duplicate export section/);
	});
});

describe('profile', () => {
	it('toEpoch accepts numbers, numeric and ISO strings and Dates; everything else is null', () => {
		expect(toEpoch(5)).toBe(5);
		expect(toEpoch(Number.POSITIVE_INFINITY)).toBeNull();
		expect(toEpoch('1700000000000')).toBe(1_700_000_000_000);
		expect(toEpoch('2026-10-16T12:00:00.000Z')).toBe(NOW);
		expect(toEpoch('not a date')).toBeNull();
		expect(toEpoch('')).toBeNull();
		expect(toEpoch(new Date(NOW))).toBe(NOW);
		expect(toEpoch(new Date('invalid'))).toBeNull();
		expect(toEpoch(null)).toBeNull();
		expect(toEpoch({})).toBeNull();
	});

	it('falls back for missing display nickname and unknown visibility values', async () => {
		const username = nick('prof');
		const user = await seedUser({ username });
		await env.DB.prepare('UPDATE "user" SET "displayUsername" = NULL WHERE id = ?')
			.bind(user.id)
			.run();
		const profile = await getAccountProfile(env.DB, user.id, NOW);
		expect(profile).toMatchObject({
			displayUsername: username,
			activityVisibility: 'private',
			libraryVisibility: 'private'
		});
		expect(await getAccountProfile(env.DB, 'missing-user', NOW)).toBeNull();
	});

	it('bio: sanitized, empty becomes null, over-long is refused; visibility is validated', async () => {
		const user = await seedUser();
		expect(sanitizeBio('  a\r\nb\t\u202Ec\u0007  \n\n\n\nd  ')).toBe('a\nb c\n\nd');
		expect(await updateBio(env.DB, user.id, '   ')).toEqual({ ok: true, bio: null });
		expect(await updateBio(env.DB, user.id, 42 as never)).toEqual({ ok: true, bio: null });
		expect(await updateBio(env.DB, user.id, '🎧'.repeat(BIO_MAX))).toMatchObject({ ok: true });
		expect(await updateBio(env.DB, user.id, 'x'.repeat(BIO_MAX + 1))).toEqual({
			ok: false,
			error: 'too-long'
		});
		await expect(
			updateVisibility(env.DB, user.id, { activity: 'everyone' as never, library: 'public' })
		).rejects.toThrow('Invalid visibility');
		await updateVisibility(env.DB, user.id, { activity: 'public', library: 'private' });
		expect(await getAccountProfile(env.DB, user.id, NOW)).toMatchObject({
			activityVisibility: 'public',
			libraryVisibility: 'private'
		});
	});
});

describe('nickname', () => {
	it('refuses unknown users and non-string input', async () => {
		expect(await changeNickname(env.DB, 'missing-user', nick(), NOW)).toEqual({
			ok: false,
			error: 'invalid'
		});
		const user = await seedUser();
		expect(await changeNickname(env.DB, user.id, 7 as never, NOW)).toEqual({
			ok: false,
			error: 'invalid'
		});
	});

	it('a unique-index race at write time answers "taken"; other D1 errors propagate', async () => {
		const user = await seedUser();
		const failing = (message: string) => ({
			prepare: (query: string) => env.DB.prepare(query),
			batch: async () => {
				throw new Error(message);
			}
		});
		expect(
			await changeNickname(
				failing('D1_ERROR: UNIQUE constraint failed: user.usernameSkeleton') as never,
				user.id,
				nick('race'),
				NOW
			)
		).toEqual({ ok: false, error: 'taken' });
		await expect(
			changeNickname(failing('D1_ERROR: disk I/O error') as never, user.id, nick('race'), NOW)
		).rejects.toThrow('disk I/O error');
	});
});

describe('sessions', () => {
	it('parses reduced user agents and tolerates odd stored dates', async () => {
		expect(parseDevice(null)).toEqual({ browser: null, os: null });
		expect(parseDevice('Other on Other')).toEqual({ browser: null, os: null });
		expect(parseDevice('Firefox on Linux')).toEqual({ browser: 'Firefox', os: 'Linux' });
		const user = await seedUser();
		await env.DB.prepare(
			'INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", ' +
				'"userAgent", "userId", "impersonatedBy") VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)'
		)
			.bind(
				`odd-${crypto.randomUUID()}`,
				new Date(NOW + 86_400_000).toISOString(),
				`tok-${crypto.randomUUID()}`,
				'garbage',
				'garbage',
				user.id,
				'admin-1'
			)
			.run();
		await env.DB.prepare(
			'INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") ' +
				'VALUES (?, ?, ?, ?, ?, ?)'
		)
			.bind(
				`expired-${crypto.randomUUID()}`,
				'garbage',
				`tok-${crypto.randomUUID()}`,
				NOW,
				NOW,
				user.id
			)
			.run();
		const sessions = await listAccountSessions(env.DB, user.id, null, NOW);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			createdAt: 0,
			lastActiveAt: 0,
			browser: null,
			os: null,
			impersonated: true,
			current: false
		});
	});
});

describe('policy endpoint edge cases', () => {
	it('missing content type is 415; a non-object JSON body is an invalid version', async () => {
		const user = await seedUser();
		const session = await seedSession(user.id);
		const signedIn = locals(user, session.id);
		const base = { db: env.DB, publicOrigin: origin(), locals: signedIn };
		const noType = await handlePolicyRequest({
			...base,
			request: new Request(`${origin()}/conta/politica`, {
				method: 'POST',
				headers: { origin: origin() },
				body: new Uint8Array([123, 125])
			})
		});
		expect(noType.status).toBe(415);
		for (const body of ['[1]', 'null', JSON.stringify({ version: 1 })]) {
			const response = await handlePolicyRequest({
				...base,
				request: new Request(`${origin()}/conta/politica`, {
					method: 'POST',
					headers: { origin: origin(), 'content-type': 'application/json' },
					body
				})
			});
			expect(response.status, body).toBe(400);
		}
		const sameSite = await handlePolicyRequest({
			...base,
			request: new Request(`${origin()}/conta/politica`, {
				method: 'POST',
				headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
				body: JSON.stringify({ version: POLICY_VERSION })
			})
		});
		expect(sameSite.status).toBe(200);
	});
});
