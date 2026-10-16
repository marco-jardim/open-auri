// Admin users (T3.8): search with masked e-mails and ban/unban through the Better Auth admin
// plugin, every attempt audited.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAudit } from '#lib/server/admin/audit.ts';
import {
	banUser,
	getAdminUser,
	maskEmail,
	parseBanForm,
	parseUnbanForm,
	searchUsers,
	unbanUser
} from '#lib/server/admin/users.ts';
import { account, harness, type Account } from './helpers.ts';
import type { Harness } from '../auth/harness.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

function form(fields: Record<string, string>): FormData {
	const data = new FormData();
	for (const [name, value] of Object.entries(fields)) data.set(name, value);
	return data;
}

function deps(h: Harness, actor: Account) {
	return { db: env.DB, auth: h.auth, headers: actor.client.headers(), actorId: actor.id };
}

describe('pure helpers', () => {
	it('masks e-mails keeping only the shape', () => {
		expect(maskEmail('marcos@example.com')).toBe('m***@e***.com');
		expect(maskEmail('a@b')).toBe('a***@b***');
		expect(maskEmail('nobody')).toBe('***');
	});

	it('parses the ban and unban forms strictly', () => {
		expect(parseBanForm(form({ userId: 'u1', reason: '  spam links  ', duration: '7' }))).toEqual({
			userId: 'u1',
			reason: 'spam links',
			duration: '7'
		});
		expect(
			parseBanForm(form({ userId: 'u1', reason: 'spam\nagain', duration: 'permanent' }))
		).toMatchObject({ duration: 'permanent' });
		for (const fields of [
			{ userId: 'u1', reason: 'ok', duration: '7' },
			{ userId: 'u1', reason: 'x'.repeat(501), duration: '7' },
			{ userId: 'u1', reason: 'spam\u0000', duration: '7' },
			{ userId: 'u1', reason: 'spam links', duration: '2' },
			{ userId: "u1' OR 1=1", reason: 'spam links', duration: '7' },
			{ userId: '', reason: 'spam links', duration: '7' }
		]) {
			expect(parseBanForm(form(fields))).toBeNull();
		}
		expect(parseUnbanForm(form({ userId: 'u1', reason: 'appeal accepted' }))).toEqual({
			userId: 'u1',
			reason: 'appeal accepted'
		});
		expect(parseUnbanForm(form({ userId: 'u1' }))).toBeNull();
	});
});

describe('searchUsers', () => {
	it('finds by nickname prefix, exact e-mail or id, and never returns the address', async () => {
		const h = harness(network);
		const target = await account(h, 'searchme');

		const byNick = await searchUsers(env.DB, target.username.slice(0, 8).toUpperCase());
		expect(byNick.map((row) => row.id)).toContain(target.id);

		const byEmail = await searchUsers(env.DB, ` ${target.email.toUpperCase()} `);
		expect(byEmail).toHaveLength(1);
		const row = byEmail[0];
		expect(row).toMatchObject({
			id: target.id,
			nickname: target.username,
			emailVerified: true,
			role: 'user',
			banned: false,
			banExpires: null,
			twoFactorEnabled: false
		});
		expect(row?.emailMasked).toMatch(/^s\*\*\*@e\*\*\*\.com$/);
		expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(JSON.stringify(byEmail)).not.toContain(target.email);

		expect((await searchUsers(env.DB, target.id)).map((r) => r.id)).toEqual([target.id]);
		// No partial e-mail matching (no address harvesting) and no LIKE wildcards.
		expect(await searchUsers(env.DB, '@example.com')).toEqual([]);
		expect(await searchUsers(env.DB, target.email.slice(0, -1))).toEqual([]);
		expect(await searchUsers(env.DB, '%')).toEqual([]);
		expect(await searchUsers(env.DB, '_')).toEqual([]);
		expect((await searchUsers(env.DB, '', 3)).length).toBeLessThanOrEqual(3);
		expect((await searchUsers(env.DB, '')).map((r) => r.id)).toContain(target.id);
	});
});

describe('ban and unban', () => {
	it('bans with reason and expiry, ends the sessions, unbans, and audits both', async () => {
		const h = harness(network, { admin2faRequired: false });
		const admin = await account(h, 'mod', true);
		const target = await account(h, 'target');
		expect(await target.client.session()).not.toBeNull();

		const before = Date.now();
		expect(
			await banUser(deps(h, admin), { userId: target.id, reason: 'spam links', duration: '7' })
		).toEqual({ ok: true });

		const banned = await getAdminUser(env.DB, target.id);
		expect(banned?.banned).toBe(true);
		const expires = Date.parse(banned?.banExpires ?? '');
		expect(expires).toBeGreaterThanOrEqual(before + 7 * 86_400_000 - 60_000);
		expect(expires).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000 + 60_000);
		const reason = await env.DB.prepare('SELECT banReason FROM "user" WHERE id = ?')
			.bind(target.id)
			.first<{ banReason: string }>();
		expect(reason?.banReason).toBe('spam links');
		expect(await target.client.session()).toBeNull();

		expect(
			await unbanUser(deps(h, admin), { userId: target.id, reason: 'appeal accepted' })
		).toEqual({ ok: true });
		expect((await getAdminUser(env.DB, target.id))?.banned).toBe(false);

		const trail = await listAudit(env.DB, { targetId: target.id });
		expect(trail.rows.map((row) => row.action)).toEqual(['user.unban', 'user.ban']);
		const [unban, ban] = trail.rows;
		expect(ban).toMatchObject({
			actorId: admin.id,
			actorKind: 'admin',
			targetKind: 'user',
			targetId: target.id,
			detail: { reason: 'spam links', days: 7 }
		});
		expect(unban?.detail).toEqual({ reason: 'appeal accepted' });
		expect(JSON.stringify(trail.rows)).not.toContain(target.email);
	});

	it('records a permanent ban without expiry', async () => {
		const h = harness(network, { admin2faRequired: false });
		const admin = await account(h, 'modperm', true);
		const target = await account(h, 'perm');
		expect(
			await banUser(deps(h, admin), { userId: target.id, reason: 'fraud', duration: 'permanent' })
		).toEqual({ ok: true });
		const banned = await getAdminUser(env.DB, target.id);
		expect(banned).toMatchObject({ banned: true, banExpires: null });
		const trail = await listAudit(env.DB, { targetId: target.id });
		expect(trail.rows[0]?.detail).toEqual({ reason: 'fraud', days: null });
	});

	it('refuses self, other admins, unknown users and unbanning an active account', async () => {
		const h = harness(network, { admin2faRequired: false });
		const admin = await account(h, 'modself', true);
		const other = await account(h, 'modother', true);
		const active = await account(h, 'active');
		const d = deps(h, admin);
		const reason = 'testing refusals';
		expect(await banUser(d, { userId: admin.id, reason, duration: '1' })).toEqual({
			ok: false,
			code: 'SELF'
		});
		expect(await banUser(d, { userId: other.id, reason, duration: '1' })).toEqual({
			ok: false,
			code: 'TARGET_IS_ADMIN'
		});
		expect(await banUser(d, { userId: 'does-not-exist', reason, duration: '1' })).toEqual({
			ok: false,
			code: 'NOT_FOUND'
		});
		expect(await unbanUser(d, { userId: active.id, reason })).toEqual({
			ok: false,
			code: 'NOT_BANNED'
		});
		// Refusals change nothing and write nothing.
		for (const id of [admin.id, other.id, active.id]) {
			expect((await listAudit(env.DB, { targetId: id })).total).toBe(0);
			expect((await getAdminUser(env.DB, id))?.banned).toBe(false);
		}
	});

	it('audits the attempt and the failure when Better Auth refuses (non-admin session)', async () => {
		const h = harness(network, { admin2faRequired: false });
		const impostor = await account(h, 'impostor');
		const target = await account(h, 'victim');
		expect(
			await banUser(deps(h, impostor), { userId: target.id, reason: 'not allowed', duration: '1' })
		).toEqual({ ok: false, code: 'FAILED' });
		expect((await getAdminUser(env.DB, target.id))?.banned).toBe(false);
		const trail = await listAudit(env.DB, { targetId: target.id });
		expect(trail.rows.map((row) => row.action).sort()).toEqual(['user.ban', 'user.ban.failed']);
		const failed = trail.rows.find((row) => row.action === 'user.ban.failed');
		expect(typeof failed?.detail?.reason).toBe('string');
	});
});
