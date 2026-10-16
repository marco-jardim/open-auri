// LGPD export, social section (T4.1): the user's own lineages with versions and visibility,
// favorites, activity, shares with the aggregate funnel, attributed events, packs, reports filed
// and trades; never another user's identity.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_EXPORT_SECTIONS, buildAccountExport } from '#lib/server/account/export.ts';
import {
	addFavorite,
	createPack,
	createShare,
	createTrade,
	insertReport,
	recordActivity,
	recordShareEvent,
	setPackItems,
	tryPairTrades
} from '#lib/server/social/repo.ts';
import { socialSection } from '#lib/server/social/export.ts';
import { member, publish, sid } from './helpers.ts';

describe('social export section', () => {
	it('is registered and holds the user’s social data without other identities', async () => {
		expect(ACCOUNT_EXPORT_SECTIONS.map((section) => section.key)).toContain('social');
		const me = await member();
		const them = await member({ activity: 'public', library: 'public' });
		const now = Date.UTC(2026, 9, 16, 12);
		const mine = await publish(me.id, { visibility: 'unlisted', now });
		const theirs = await publish(them.id, { now });
		await addFavorite(env.DB, me.id, theirs.lineageId, now);
		await recordActivity(env.DB, me.id, theirs.lineageId, 'installed', now);
		await addFavorite(env.DB, them.id, mine.lineageId, now);

		const shareId = sid('share');
		await createShare(env.DB, {
			id: shareId,
			lineageId: mine.lineageId,
			versionId: mine.versionId,
			ownerUserId: me.id,
			channel: 'qr',
			now
		});
		await recordShareEvent(env.DB, {
			shareId,
			kind: 'open',
			userId: null,
			day: '2026-10-16',
			at: now
		});
		await recordShareEvent(env.DB, {
			shareId,
			kind: 'previewed',
			userId: them.id,
			day: '2026-10-16',
			at: now
		});
		const theirShare = sid('share');
		await createShare(env.DB, {
			id: theirShare,
			lineageId: theirs.lineageId,
			versionId: null,
			ownerUserId: them.id,
			channel: null,
			now
		});
		await recordShareEvent(env.DB, {
			shareId: theirShare,
			kind: 'favorited',
			userId: me.id,
			day: '2026-10-16',
			at: now
		});

		const packId = sid('pack');
		await createPack(env.DB, {
			id: packId,
			ownerUserId: me.id,
			name: 'Mine',
			description: 'd',
			visibility: 'private',
			now
		});
		await setPackItems(env.DB, packId, me.id, [mine.lineageId, theirs.lineageId], now);
		await insertReport(env.DB, {
			id: sid('rep'),
			targetKind: 'user',
			targetId: them.id,
			reason: 'impersonation',
			note: 'pretends to be someone',
			reporterUserId: me.id,
			now
		});
		await insertReport(env.DB, {
			id: sid('rep'),
			targetKind: 'lineage',
			targetId: theirs.lineageId,
			reason: 'dangerous',
			note: null,
			reporterUserId: me.id,
			now
		});
		const myTrade = await createTrade(env.DB, {
			id: sid('trade'),
			userId: me.id,
			lineageId: mine.lineageId,
			versionId: mine.versionId,
			now: Date.now()
		});
		const theirTrade = await createTrade(env.DB, {
			id: sid('trade'),
			userId: them.id,
			lineageId: theirs.lineageId,
			versionId: theirs.versionId,
			now: Date.now()
		});
		if (!myTrade.ok || !theirTrade.ok) throw new Error('trade not created');
		expect(await tryPairTrades(env.DB, myTrade.value.id, theirTrade.value.id, Date.now())).toBe(
			true
		);

		const document = await buildAccountExport({
			db: env.DB,
			userId: me.id,
			currentSessionId: null,
			now: Date.now()
		});
		const social = document.sections.social;
		expect(social).toEqual(
			await socialSection.collect({
				db: env.DB,
				userId: me.id,
				currentSessionId: null,
				now: Date.now()
			})
		);
		expect(social).toMatchObject({
			lineages: [
				{
					id: mine.lineageId,
					visibility: 'unlisted',
					status: 'active',
					headVersion: mine.versionId,
					versions: [
						{ id: mine.versionId, curveId: mine.curve.id, s1: mine.curve.s1, license: 'CC-BY-4.0' }
					]
				}
			],
			favorites: [{ lineageId: theirs.lineageId, createdAt: new Date(now).toISOString() }],
			activity: [{ lineageId: theirs.lineageId, kind: 'installed', count: 1 }],
			shares: [
				{
					id: shareId,
					channel: 'qr',
					funnel: {
						open: { anonymous: 1, users: 0 },
						previewed: { anonymous: 0, users: 1 },
						installed: { anonymous: 0, users: 0 },
						favorited: { anonymous: 0, users: 0 }
					}
				}
			],
			sharedWithMe: [{ lineageId: theirs.lineageId, kind: 'favorited' }],
			packs: [
				{
					id: packId,
					visibility: 'private',
					items: [
						{ lineageId: mine.lineageId, position: 0 },
						{ lineageId: theirs.lineageId, position: 1 }
					]
				}
			],
			trades: [{ id: myTrade.value.id, status: 'matched', scoreGiven: null }]
		});
		const reports = (social as { reports: { targetKind: string; targetId: string | null }[] })
			.reports;
		expect(reports).toHaveLength(2);
		expect(reports.find((report) => report.targetKind === 'user')?.targetId).toBeNull();

		const text = JSON.stringify(social);
		for (const foreign of [them.id, them.email, them.username, theirTrade.value.id, theirShare]) {
			expect(text, foreign).not.toContain(foreign);
		}
	});

	it('a user without social data exports empty lists', async () => {
		const nobody = await member();
		const section = await socialSection.collect({
			db: env.DB,
			userId: nobody.id,
			currentSessionId: null,
			now: Date.now()
		});
		expect(section).toEqual({
			lineages: [],
			favorites: [],
			activity: [],
			shares: [],
			sharedWithMe: [],
			packs: [],
			reports: [],
			trades: []
		});
	});
});
