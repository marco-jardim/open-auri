// LGPD export (T3.7): every F3 section present, only the requester's rows, no secrets, the
// endpoint answers an attachment to the owner only and refuses cross-site requests.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { POLICY_VERSION } from '#lib/content/legal/version.ts';
import { recordDeletionRequest } from '#lib/server/account/deletion.ts';
import { recordEmailChangeRequest } from '#lib/server/account/email-change.ts';
import { handleExportRequest } from '#lib/server/account/endpoints.ts';
import {
	ACCOUNT_EXPORT_SECTIONS,
	buildAccountExport,
	EXPORT_FORMAT,
	exportFileName,
	type ExportSection
} from '#lib/server/account/export.ts';
import { changeNickname } from '#lib/server/account/nickname.ts';
import { updateBio } from '#lib/server/account/profile.ts';
import { recordAcceptance } from '#lib/server/legal/acceptance.ts';
import {
	ANONYMOUS,
	DAY,
	locals,
	nick,
	origin,
	seedSecrets,
	seedSession,
	seedUser
} from './helpers.ts';

interface Person {
	user: Awaited<ReturnType<typeof seedUser>>;
	session: { id: string; token: string };
	other: { id: string; token: string };
	secrets: { hash: string; totp: string };
	old: string;
	current: string;
	pending: string;
	bio: string;
}

async function person(prefix: string): Promise<Person> {
	const old = nick(prefix);
	const user = await seedUser({ username: old });
	const current = nick(prefix);
	const changed = await changeNickname(env.DB, user.id, current, Date.now());
	if (!changed.ok) throw new Error(changed.error);
	const bio = `bio of ${prefix} ${crypto.randomUUID()}`;
	await updateBio(env.DB, user.id, bio);
	await recordAcceptance(env.DB, user.id, POLICY_VERSION, Date.now());
	const pending = `${prefix}-${crypto.randomUUID().slice(0, 8)}@example.org`;
	await recordEmailChangeRequest(env.DB, user.id, pending, Date.now());
	await recordDeletionRequest(env.DB, user.id, 'anonymize', Date.now());
	return {
		user,
		session: await seedSession(user.id, { userAgent: 'Firefox on Linux' }),
		other: await seedSession(user.id, {
			userAgent: 'Safari on iOS',
			createdAt: Date.now() - DAY,
			updatedAt: Date.now() - 1000
		}),
		secrets: await seedSecrets(user.id),
		old,
		current,
		pending,
		bio
	};
}

describe('buildAccountExport', () => {
	it('covers every F3 section with the owner data', async () => {
		const me = await person('ex');
		const now = Date.now();
		const publicId = await env.DB.prepare('SELECT public_author_id FROM "user" WHERE id = ?')
			.bind(me.user.id)
			.first<{ public_author_id: string }>();
		const document = await buildAccountExport({
			db: env.DB,
			userId: me.user.id,
			currentSessionId: me.session.id,
			now
		});
		expect(document.format).toBe(EXPORT_FORMAT);
		expect(document.userId).toBe(me.user.id);
		expect(Object.keys(document.sections)).toEqual(ACCOUNT_EXPORT_SECTIONS.map((s) => s.key));
		const { account, profile, policyAcceptances, sessions, pendingRequests } = document.sections;
		expect(account).toMatchObject({
			id: me.user.id,
			publicAuthorId: publicId?.public_author_id,
			email: me.user.email,
			name: 'Private Name',
			emailVerified: true,
			signInMethods: [{ provider: 'credential' }]
		});
		expect(publicId?.public_author_id).toMatch(/^[a-f0-9]{32}$/);
		expect(profile).toMatchObject({
			nickname: me.current,
			bio: me.bio,
			activityVisibility: 'private',
			libraryVisibility: 'private',
			previousNicknamesOnHold: [{ nickname: me.old }]
		});
		expect(policyAcceptances).toEqual([
			{ version: POLICY_VERSION, acceptedAt: expect.any(String) }
		]);
		expect(sessions).toHaveLength(2);
		expect(sessions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ browser: 'Firefox', os: 'Linux', current: true }),
				expect.objectContaining({ browser: 'Safari', os: 'iOS', current: false })
			])
		);
		expect(pendingRequests).toMatchObject({
			emailChange: { newEmail: me.pending },
			accountClosure: { mode: 'anonymize' }
		});
	});

	it('holds no secrets and nothing of other users', async () => {
		const me = await person('mine');
		const them = await person('theirs');
		const text = JSON.stringify(
			await buildAccountExport({
				db: env.DB,
				userId: me.user.id,
				currentSessionId: me.session.id,
				now: Date.now()
			})
		);
		for (const secret of [
			me.secrets.hash,
			me.secrets.totp,
			me.session.token,
			me.other.token,
			me.session.id,
			'scrypt$',
			'oauth-token',
			'backup-codes',
			'usernameSkeleton',
			'ipAddress'
		]) {
			expect(text, secret).not.toContain(secret);
		}
		for (const foreign of [
			them.user.id,
			them.user.email,
			them.current,
			them.old,
			them.bio,
			them.pending,
			them.session.token,
			them.secrets.hash
		]) {
			expect(text, foreign).not.toContain(foreign);
		}
	});

	it('is a registry: extra sections are appended, duplicate keys refused', async () => {
		const me = await person('reg');
		const extra: ExportSection = {
			key: 'curves',
			collect: async (ctx) => ({ owner: ctx.userId })
		};
		const ctx = { db: env.DB, userId: me.user.id, currentSessionId: null, now: Date.now() };
		const document = await buildAccountExport(ctx, [...ACCOUNT_EXPORT_SECTIONS, extra]);
		expect(document.sections.curves).toEqual({ owner: me.user.id });
		await expect(
			buildAccountExport(ctx, [...ACCOUNT_EXPORT_SECTIONS, { ...extra, key: 'profile' }])
		).rejects.toThrow(/Duplicate/);
	});
});

describe('POST /conta/exportar', () => {
	function request(headers: Record<string, string>): Request {
		return new Request(`${origin()}/conta/exportar`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }
		});
	}

	it('answers the owner with a JSON attachment that is never cached', async () => {
		const me = await person('dl');
		const now = Date.UTC(2026, 9, 16, 15, 0, 0);
		const response = await handleExportRequest({
			request: request({ origin: origin() }),
			locals: locals(me.user, me.session.id),
			db: env.DB,
			publicOrigin: origin(),
			now
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(response.headers.get('content-disposition')).toBe(
			`attachment; filename="${exportFileName(now)}"`
		);
		expect(exportFileName(now)).toBe('open-auri-dados-2026-10-16.json');
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = (await response.json()) as { userId: string };
		expect(body.userId).toBe(me.user.id);
	});

	it('refuses anonymous and cross-site requests', async () => {
		const me = await person('dlx');
		const base = { db: env.DB, publicOrigin: origin() };
		const anonymous = await handleExportRequest({
			...base,
			request: request({ origin: origin() }),
			locals: ANONYMOUS
		});
		expect(anonymous.status).toBe(401);
		const rejectedHeaders: Record<string, string>[] = [
			{ origin: 'https://evil.example' },
			{ origin: 'null' },
			{},
			{ 'sec-fetch-site': 'cross-site' }
		];
		for (const headers of rejectedHeaders) {
			const response = await handleExportRequest({
				...base,
				request: request(headers),
				locals: locals(me.user, me.session.id)
			});
			expect(response.status).toBe(403);
			expect(response.headers.get('content-disposition')).toBeNull();
		}
		const sameSite = await handleExportRequest({
			...base,
			request: request({ 'sec-fetch-site': 'same-origin' }),
			locals: locals(me.user, me.session.id)
		});
		expect(sameSite.status).toBe(200);
	});

	it('refuses a banned account', async () => {
		const me = await person('dlb');
		const response = await handleExportRequest({
			request: request({ origin: origin() }),
			locals: locals(me.user, me.session.id, { banned: true }),
			db: env.DB,
			publicOrigin: origin()
		});
		expect(response.status).toBe(403);
	});
});
