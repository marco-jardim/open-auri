// T4.8: /admin/moderacao. Load and actions behind the admin guard (404 for everyone else),
// remove and ban on a stale session ask for re-authentication, every decision is audited and
// resolves the target's open reports.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listAudit } from '#lib/server/admin/audit.ts';
import { fileReport, parseDecisionForm } from '#lib/server/social/moderation.ts';
import { actions, load } from '../../../../src/routes/admin/moderacao/+page.server.ts';
import { account, harness, localsOf } from '../../admin/helpers.ts';
import { outcome, platform, routeEvent, statusOf, type TestLocals } from '../../phase3/helpers.ts';
import type { Client, Harness } from '../../auth/harness.ts';
import {
	lineageCurated,
	lineageModeration,
	reporter,
	resolutions,
	seedUser,
	target
} from './helpers.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

vi.setConfig({ testTimeout: 60_000 });

const PLATFORM = { ADMIN_2FA_REQUIRED: 'false' };

interface Actor {
	h: Harness;
	id: string;
	client: Client;
	locals: TestLocals;
}

async function actor(isAdmin: boolean): Promise<Actor> {
	const h = harness(network, { admin2faRequired: false });
	const acct = await account(h, isAdmin ? 'modq' : 'modu', isAdmin);
	const current = await localsOf(acct.client);
	return { h, id: acct.id, client: acct.client, locals: { auth: h.auth, ...current } };
}

function stale(locals: TestLocals): TestLocals {
	const hourAgo = new Date(Date.now() - 3_600_000);
	if (!locals.session) return locals;
	return {
		...locals,
		session: { ...locals.session, createdAt: hourAgo, twoFactorVerifiedAt: hourAgo }
	};
}

function act(name: string, who: Actor, form: Record<string, string>, locals = who.locals) {
	const action = actions[name];
	if (!action) throw new Error(`no action ${name}`);
	return outcome(() =>
		action(
			routeEvent({
				path: `/admin/moderacao?/${name}`,
				locals,
				platform: platform(PLATFORM),
				client: who.client,
				form
			}) as never
		)
	);
}

function loadAs(who: Actor, path = '/admin/moderacao') {
	return outcome(() =>
		load(
			routeEvent({
				path,
				locals: who.locals,
				platform: platform(PLATFORM),
				client: who.client
			}) as never
		)
	);
}

/** A public lineage with `count` open reports dated far in the future (first in the queue). */
async function reported(count: number, note: string | null = null) {
	const t = await target();
	const now = Date.now() + 3_650 * 86_400_000 + Math.floor(Math.random() * 1_000_000);
	for (let i = 0; i < count; i += 1) {
		const result = await fileReport(env.DB, {
			reporterUserId: (await reporter()).id,
			targetKind: 'lineage',
			targetId: t.lineageId,
			reason: i === 0 ? 'dangerous' : 'spam',
			note: i === 0 ? note : null,
			now: now + i
		});
		expect(result.ok).toBe(true);
	}
	return t;
}

async function actions_(targetId: string): Promise<string[]> {
	return (await listAudit(env.DB, { targetId })).rows.map((row) => row.action).sort();
}

describe('admin moderation: access', () => {
	it('answers 404 to non-admins on load and on every action', async () => {
		const user = await actor(false);
		expect(statusOf(await loadAs(user))).toBe(404);
		const { lineageId } = await reported(1);
		for (const name of ['hide', 'restore', 'remove', 'dismiss', 'ban', 'curate', 'uncurate']) {
			const result = await act(name, user, {
				targetKind: 'lineage',
				targetId: lineageId,
				reason: 'not allowed',
				duration: '7'
			});
			expect(statusOf(result), name).toBe(404);
		}
		expect(await lineageModeration(lineageId)).toBe('visible');
		expect(await actions_(lineageId)).toEqual([]);
	});

	it('remove and ban on a stale session fail with reauth and change nothing', async () => {
		const admin = await actor(true);
		const { lineageId, owner } = await reported(1);
		for (const name of ['remove', 'ban']) {
			const result = await act(
				name,
				admin,
				{ targetKind: 'lineage', targetId: lineageId, reason: 'stale check', duration: '7' },
				stale(admin.locals)
			);
			expect(result, name).toMatchObject({
				kind: 'fail',
				status: 403,
				data: { reauth: true, code: 'REAUTH_REQUIRED' }
			});
		}
		// Hide is not destructive: a stale session may still hide.
		const hidden = await act(
			'hide',
			admin,
			{ targetKind: 'lineage', targetId: lineageId, reason: 'quick hide' },
			stale(admin.locals)
		);
		expect(hidden).toMatchObject({ kind: 'data', data: { done: 'hide', resolved: 1 } });
		const banned = await env.DB.prepare('SELECT banned FROM "user" WHERE id = ?')
			.bind(owner.id)
			.first<{ banned: number }>();
		expect(banned?.banned).toBe(0);
		expect(await actions_(lineageId)).toEqual(['moderation.hide']);
	});
});

describe('admin moderation: queue and decisions', () => {
	it('loads the queue grouped by target with reason counts, notes and preview', async () => {
		const admin = await actor(true);
		const { lineageId, owner } = await reported(3, 'too loud at 3 kHz');
		const result = await loadAs(admin);
		expect(result.kind).toBe('data');
		const data = result.kind === 'data' ? result.data : {};
		const items = data.items as {
			targetId: string;
			openReports: number;
			eligibleReporters: number;
			reasons: { reason: string; count: number }[];
			notes: { note: string }[];
			preview: { name: string; author: { id: string } } | null;
		}[];
		const item = items.find((entry) => entry.targetId === lineageId);
		expect(item).toBeDefined();
		expect(item?.openReports).toBe(3);
		expect(item?.eligibleReporters).toBe(3);
		expect(item?.reasons).toEqual([
			{ reason: 'spam', count: 2 },
			{ reason: 'dangerous', count: 1 }
		]);
		expect(item?.notes.map((n) => n.note)).toEqual(['too loud at 3 kHz']);
		expect(item?.preview?.author.id).toBe(owner.id);
		expect(typeof item?.preview?.name).toBe('string');
		// No reporter ids or e-mails leave the server.
		expect(JSON.stringify(data)).not.toMatch(/@example\.com/);
		// A broken cursor falls back to the first page.
		expect((await loadAs(admin, '/admin/moderacao?cursor=AAAA')).kind).toBe('data');
	});

	it('hide, restore, remove, dismiss: moderation state, resolutions and audit rows', async () => {
		const admin = await actor(true);
		const { lineageId } = await reported(2);
		const form = { targetKind: 'lineage', targetId: lineageId, reason: 'reviewed by staff' };

		expect(await act('hide', admin, form)).toMatchObject({
			kind: 'data',
			data: { done: 'hide', targetId: lineageId, resolved: 2 }
		});
		expect(await lineageModeration(lineageId)).toBe('hidden');
		expect(await resolutions('lineage', lineageId)).toEqual(['hidden', 'hidden']);

		expect(await act('restore', admin, form)).toMatchObject({
			kind: 'data',
			data: { done: 'restore', resolved: 0 }
		});
		expect(await lineageModeration(lineageId)).toBe('visible');

		await fileReport(env.DB, {
			reporterUserId: (await reporter()).id,
			targetKind: 'lineage',
			targetId: lineageId,
			reason: 'spam',
			note: null,
			now: Date.now()
		});
		expect(await act('dismiss', admin, form)).toMatchObject({
			kind: 'data',
			data: { done: 'dismiss', resolved: 1 }
		});
		expect(await lineageModeration(lineageId)).toBe('visible');
		expect((await resolutions('lineage', lineageId)).sort()).toEqual([
			'dismissed',
			'hidden',
			'hidden'
		]);

		expect(await act('remove', admin, form)).toMatchObject({
			kind: 'data',
			data: { done: 'remove' }
		});
		expect(await lineageModeration(lineageId)).toBe('removed');

		const trail = await listAudit(env.DB, { targetId: lineageId });
		expect(trail.rows.map((row) => row.action).sort()).toEqual([
			'moderation.dismiss',
			'moderation.hide',
			'moderation.remove',
			'moderation.restore'
		]);
		for (const row of trail.rows) {
			expect(row).toMatchObject({ actorId: admin.id, actorKind: 'admin', targetKind: 'lineage' });
			expect(row.detail?.reason).toBe('reviewed by staff');
		}
		expect(trail.rows.find((row) => row.action === 'moderation.hide')?.detail?.previous).toBe(
			'visible'
		);
	});

	it('curate and uncurate a lineage (reason optional), refused on users', async () => {
		const admin = await actor(true);
		const { lineageId } = await reported(1);
		const form = { targetKind: 'lineage', targetId: lineageId, reason: '' };
		expect(await act('curate', admin, form)).toMatchObject({ data: { done: 'curate' } });
		expect(await lineageCurated(lineageId)).toBe(1);
		expect(await act('uncurate', admin, form)).toMatchObject({ data: { done: 'uncurate' } });
		expect(await lineageCurated(lineageId)).toBe(0);
		// Curation leaves the reports open.
		expect(await resolutions('lineage', lineageId)).toEqual([null]);
		expect(await actions_(lineageId)).toEqual(['moderation.curate', 'moderation.uncurate']);

		const profile = await seedUser({ username: `m${crypto.randomUUID().slice(0, 12)}` });
		for (const name of ['curate', 'hide']) {
			expect(
				await act(name, admin, { targetKind: 'user', targetId: profile.id, reason: 'not here' })
			).toMatchObject({ kind: 'fail', status: 409, data: { error: 'UNSUPPORTED' } });
		}
		expect(await actions_(profile.id)).toEqual([]);
	});

	it('bans the author through admin/users.ts and resolves the reports as banned', async () => {
		const admin = await actor(true);
		const { lineageId, owner } = await reported(2);
		const result = await act('ban', admin, {
			targetKind: 'lineage',
			targetId: lineageId,
			reason: 'repeated dangerous curves',
			duration: '30'
		});
		expect(result).toMatchObject({ kind: 'data', data: { done: 'ban', resolved: 2 } });
		const row = await env.DB.prepare('SELECT banned FROM "user" WHERE id = ?')
			.bind(owner.id)
			.first<{ banned: number }>();
		expect(row?.banned).toBe(1);
		expect(await resolutions('lineage', lineageId)).toEqual(['banned', 'banned']);
		expect(await actions_(lineageId)).toEqual(['moderation.ban_author']);
		const ban = (await listAudit(env.DB, { targetId: owner.id })).rows;
		expect(ban.map((r) => r.action)).toEqual(['user.ban']);
		expect(ban[0]).toMatchObject({ actorId: admin.id, detail: { days: 30 } });
		const trail = await listAudit(env.DB, { targetId: lineageId });
		expect(trail.rows[0]?.detail).toEqual({
			authorId: owner.id,
			reason: 'repeated dangerous curves'
		});
		expect(JSON.stringify(trail.rows)).not.toContain(owner.email);
	});

	it('refuses invalid forms, missing targets and banning oneself', async () => {
		const admin = await actor(true);
		const { lineageId } = await reported(1);
		const invalid = [
			['hide', { targetKind: 'lineage', targetId: lineageId, reason: '' }],
			['hide', { targetKind: 'lineage', targetId: lineageId, reason: 'ok\u0001' }],
			['hide', { targetKind: 'curve', targetId: lineageId, reason: 'valid reason' }],
			['ban', { targetKind: 'lineage', targetId: lineageId, reason: 'valid', duration: '2' }]
		] as const;
		for (const [name, form] of invalid) {
			expect(await act(name, admin, { ...form })).toMatchObject({
				kind: 'fail',
				status: 400,
				data: { error: 'INVALID_INPUT' }
			});
		}
		expect(
			await act('hide', admin, { targetKind: 'lineage', targetId: 'missing-1234', reason: 'gone' })
		).toMatchObject({ kind: 'fail', status: 404, data: { error: 'NOT_FOUND' } });
		expect(
			await act('ban', admin, {
				targetKind: 'user',
				targetId: admin.id,
				reason: 'self ban',
				duration: '1'
			})
		).toMatchObject({ kind: 'fail', status: 409, data: { error: 'SELF' } });
		expect(await lineageModeration(lineageId)).toBe('visible');
		expect(await actions_(lineageId)).toEqual([]);
	});

	it('parseDecisionForm keeps only the expected fields', () => {
		const form = new FormData();
		form.set('targetKind', 'pack');
		form.set('targetId', 'pack-12345678');
		form.set('reason', '  spam pack  ');
		form.set('duration', 'permanent');
		expect(parseDecisionForm(form, 'hide')).toEqual({
			decision: 'hide',
			targetKind: 'pack',
			targetId: 'pack-12345678',
			reason: 'spam pack'
		});
		expect(parseDecisionForm(form, 'ban')).toMatchObject({ duration: 'permanent' });
	});
});
