// Library, activity, audience and shares (T4.1): idempotent favorites, deduplicated activity with
// first/last/count, the owner's audience respecting activity_visibility, public counts of distinct
// verified users, the user's own history, and the share funnel without identities.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	addFavorite,
	countsForLineages,
	createShare,
	deleteOwnActivity,
	getAudience,
	getShare,
	getShareStats,
	listInstalled,
	listOwnActivity,
	listOwnShares,
	recordActivity,
	recordShareEvent,
	removeFavorite
} from '#lib/server/social/repo.ts';
import type { ActivityKind } from '#lib/server/social/types.ts';
import { ban, count, member, publish, seedUser, sid } from './helpers.ts';

describe('favorites', () => {
	it('are idempotent both ways', async () => {
		const owner = await seedUser();
		const user = await seedUser();
		const { lineageId } = await publish(owner.id);
		expect(await addFavorite(env.DB, user.id, lineageId, Date.now())).toEqual({
			ok: true,
			value: { created: true }
		});
		expect(await addFavorite(env.DB, user.id, lineageId, Date.now())).toEqual({
			ok: true,
			value: { created: false }
		});
		const rows = () =>
			count(
				'SELECT count(*) AS n FROM favorites WHERE user_id = ? AND lineage_id = ?',
				user.id,
				lineageId
			);
		expect(await rows()).toBe(1);
		expect(await removeFavorite(env.DB, user.id, lineageId)).toBe(true);
		expect(await removeFavorite(env.DB, user.id, lineageId)).toBe(false);
		expect(await rows()).toBe(0);
	});

	it('a lineage the user cannot read cannot be favorited', async () => {
		const owner = await seedUser();
		const user = await seedUser();
		const { lineageId } = await publish(owner.id, { visibility: 'private' });
		expect(await addFavorite(env.DB, user.id, lineageId, Date.now())).toEqual({
			ok: false,
			code: 'not-found'
		});
		expect(await addFavorite(env.DB, owner.id, lineageId, Date.now())).toMatchObject({ ok: true });
	});
});

describe('activity', () => {
	it('one row per user, lineage and kind with first, last and count', async () => {
		const owner = await seedUser();
		const user = await seedUser();
		const { lineageId } = await publish(owner.id);
		const t = Date.now();
		await recordActivity(env.DB, user.id, lineageId, 'previewed', t);
		await recordActivity(env.DB, user.id, lineageId, 'previewed', t - 5000);
		const last = await recordActivity(env.DB, user.id, lineageId, 'previewed', t + 5000);
		expect(last).toEqual({
			ok: true,
			value: { lineageId, kind: 'previewed', firstAt: t - 5000, lastAt: t + 5000, count: 3 }
		});
		expect(
			await count(
				'SELECT count(*) AS n FROM activity WHERE user_id = ? AND lineage_id = ?',
				user.id,
				lineageId
			)
		).toBe(1);
	});

	it('refuses an invalid kind and an unreadable lineage', async () => {
		const owner = await seedUser();
		const user = await seedUser();
		const hidden = await publish(owner.id, { visibility: 'private' });
		const visible = await publish(owner.id);
		const bad: unknown = 'listened';
		expect(
			await recordActivity(env.DB, user.id, visible.lineageId, bad as ActivityKind, Date.now())
		).toEqual({ ok: false, code: 'invalid-input' });
		expect(
			await recordActivity(env.DB, user.id, hidden.lineageId, 'installed', Date.now())
		).toEqual({ ok: false, code: 'not-found' });
	});

	it('the user lists installed curves and deletes their own history', async () => {
		const owner = await seedUser();
		const user = await seedUser();
		const a = await publish(owner.id);
		const b = await publish(owner.id);
		const now = Date.now();
		await recordActivity(env.DB, user.id, a.lineageId, 'installed', now);
		await recordActivity(env.DB, user.id, b.lineageId, 'installed', now + 1);
		await recordActivity(env.DB, user.id, b.lineageId, 'previewed', now);
		const share = await createShare(env.DB, {
			id: sid('share'),
			lineageId: b.lineageId,
			versionId: null,
			ownerUserId: owner.id,
			channel: 'link',
			now
		});
		if (!share.ok) throw new Error(share.code);
		await recordShareEvent(env.DB, {
			shareId: share.value.id,
			kind: 'previewed',
			userId: user.id,
			day: '2026-10-16',
			at: now
		});
		const installed = await listInstalled(env.DB, user.id);
		expect(installed.items.map((entry) => entry.lineage.id)).toEqual([b.lineageId, a.lineageId]);

		expect(
			await deleteOwnActivity(env.DB, user.id, { lineageId: b.lineageId, kind: 'previewed' })
		).toBe(1);
		expect(
			await count('SELECT count(*) AS n FROM share_event_users WHERE user_id = ?', user.id)
		).toBe(0);
		expect((await listOwnActivity(env.DB, user.id)).items).toHaveLength(2);
		expect(await deleteOwnActivity(env.DB, user.id)).toBe(2);
		expect((await listOwnActivity(env.DB, user.id)).items).toEqual([]);
	});
});

describe('audience and public counts', () => {
	it('names only public profiles, counts the private ones, skips unverified, banned and the owner', async () => {
		const owner = await member();
		const { lineageId } = await publish(owner.id);
		const open = await member({ activity: 'public' });
		const closed = await member({ activity: 'private' });
		const unverified = await seedUser({ verified: false });
		const banned = await member({ activity: 'public' });
		const now = Date.now();
		for (const user of [open, closed, unverified, banned, owner]) {
			await recordActivity(env.DB, user.id, lineageId, 'previewed', now);
			await addFavorite(env.DB, user.id, lineageId, now);
		}
		await recordActivity(env.DB, open.id, lineageId, 'installed', now);
		await ban(banned.id);

		const audience = await getAudience(env.DB, lineageId, owner.id);
		expect(audience?.previewed).toEqual({
			total: 2,
			privateCount: 1,
			named: [{ username: open.username, displayUsername: open.username, at: now }]
		});
		expect(audience?.favorited).toMatchObject({ total: 2, privateCount: 1 });
		expect(audience?.installed).toMatchObject({ total: 1, privateCount: 0 });
		const text = JSON.stringify(audience);
		for (const hidden of [
			closed.username,
			closed.id,
			closed.email,
			banned.username,
			unverified.id
		]) {
			expect(text).not.toContain(hidden);
		}
		// Only the owner sees the audience.
		expect(await getAudience(env.DB, lineageId, open.id)).toBeNull();

		const counts = await countsForLineages(env.DB, [lineageId], { userId: null });
		expect(counts.get(lineageId)).toEqual({ favorites: 2, previewed: 2, installed: 1 });
	});
});

describe('shares', () => {
	it('funnel: anonymous daily counters and attributed users once per kind, owner only', async () => {
		const owner = await seedUser();
		const sharer = await seedUser();
		// Attributed users are counted only while verified, not banned and public (FX4.9).
		const visitor = await member({ activity: 'public' });
		const { lineageId, versionId } = await publish(owner.id);
		const id = sid('share');
		const created = await createShare(env.DB, {
			id,
			lineageId,
			versionId,
			ownerUserId: sharer.id,
			channel: 'qr',
			now: Date.now()
		});
		expect(created).toMatchObject({ ok: true, value: { id, lineageId, versionId, channel: 'qr' } });
		const event = (kind: 'open' | 'previewed' | 'favorited', userId: string | null, day: string) =>
			recordShareEvent(env.DB, { shareId: id, kind, userId, day, at: Date.now() });
		expect(await event('open', null, '2026-10-15')).toBe(true);
		expect(await event('open', null, '2026-10-16')).toBe(true);
		expect(await event('open', visitor.id, '2026-10-16')).toBe(true);
		expect(await event('previewed', null, '2026-10-16')).toBe(true);
		expect(await event('previewed', visitor.id, '2026-10-16')).toBe(true);
		expect(await event('previewed', visitor.id, '2026-10-16')).toBe(false);
		expect(await event('favorited', visitor.id, '2026-10-16')).toBe(true);
		expect(
			await recordShareEvent(env.DB, {
				shareId: sid('missing'),
				kind: 'open',
				userId: null,
				day: '2026-10-16',
				at: 1
			})
		).toBe(false);

		const stats = await getShareStats(env.DB, id, sharer.id);
		expect(stats?.days).toEqual([
			{ day: '2026-10-15', kind: 'open', count: 1 },
			{ day: '2026-10-16', kind: 'open', count: 2 },
			{ day: '2026-10-16', kind: 'previewed', count: 1 }
		]);
		expect(stats?.totals).toEqual({
			open: { anonymous: 3, users: 0 },
			previewed: { anonymous: 1, users: 1 },
			installed: { anonymous: 0, users: 0 },
			favorited: { anonymous: 0, users: 1 }
		});
		expect(JSON.stringify(stats)).not.toContain(visitor.id);
		expect(await getShareStats(env.DB, id, owner.id)).toBeNull();
		expect((await listOwnShares(env.DB, sharer.id)).items.map((share) => share.id)).toEqual([id]);
		expect((await getShare(env.DB, id))?.ownerUserId).toBe(sharer.id);
	});

	it('only readable lineages, matching versions and valid channels can be shared', async () => {
		const owner = await seedUser();
		const sharer = await seedUser();
		const hidden = await publish(owner.id, { visibility: 'private' });
		const other = await publish(owner.id);
		const visible = await publish(owner.id);
		const base = { ownerUserId: sharer.id, channel: null, now: Date.now() };
		expect(
			await createShare(env.DB, {
				...base,
				id: sid('share'),
				lineageId: hidden.lineageId,
				versionId: null
			})
		).toEqual({ ok: false, code: 'not-found' });
		expect(
			await createShare(env.DB, {
				...base,
				id: sid('share'),
				lineageId: visible.lineageId,
				versionId: other.versionId
			})
		).toEqual({ ok: false, code: 'not-found' });
		expect(
			await createShare(env.DB, {
				...base,
				id: sid('share'),
				lineageId: visible.lineageId,
				versionId: null,
				channel: 'Bad Channel'
			})
		).toEqual({ ok: false, code: 'invalid-input' });
		await expect(
			recordShareEvent(env.DB, {
				shareId: 'x',
				kind: 'open',
				userId: null,
				day: '16/10/2026',
				at: 1
			})
		).rejects.toMatchObject({ code: 'invalid-input' });
	});
});
