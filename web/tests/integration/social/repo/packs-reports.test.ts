// Packs (create, edit, ordered items with the head license, owner only) and moderation reports
// (one per reporter, eligible reporters for auto-hide, queue, resolution, guarded auto-hide).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	appendVersion,
	countEligibleReporters,
	createPack,
	deletePack,
	getLineageForViewer,
	getPackForViewer,
	insertReport,
	listOwnPacks,
	listReportQueue,
	listReportsForTarget,
	resolveReports,
	setCurated,
	setModeration,
	setPackItems,
	updatePack
} from '#lib/server/social/repo.ts';
import { DAY_MS } from '#lib/server/social/types.ts';
import {
	ban,
	count,
	curveInput,
	publish,
	seedUser,
	setUserCreatedAt,
	sid,
	versionInput
} from './helpers.ts';

describe('packs', () => {
	it('creates, orders, reorders and edits a pack of the owner only', async () => {
		const owner = await seedUser();
		const intruder = await seedUser();
		const a = await publish(owner.id);
		const b = await publish(owner.id);
		const c = await publish(intruder.id);
		const id = sid('pack');
		const created = await createPack(env.DB, {
			id,
			ownerUserId: owner.id,
			name: 'Vocals',
			description: 'For voice',
			visibility: 'public',
			now: Date.now()
		});
		expect(created).toMatchObject({
			ok: true,
			value: { id, name: 'Vocals', moderation: 'visible' }
		});

		expect(
			await setPackItems(env.DB, id, owner.id, [b.lineageId, a.lineageId, c.lineageId], 1)
		).toEqual({
			ok: true,
			value: { count: 3 }
		});
		let view = await getPackForViewer(env.DB, id, { userId: null });
		expect(view?.items.map((item) => [item.position, item.lineage.id, item.license])).toEqual([
			[0, b.lineageId, 'CC-BY-4.0'],
			[1, a.lineageId, 'CC-BY-4.0'],
			[2, c.lineageId, 'CC-BY-4.0']
		]);
		expect(await setPackItems(env.DB, id, owner.id, [a.lineageId, b.lineageId], 2)).toEqual({
			ok: true,
			value: { count: 2 }
		});
		view = await getPackForViewer(env.DB, id, { userId: null });
		expect(view?.items.map((item) => item.lineage.id)).toEqual([a.lineageId, b.lineageId]);

		expect(await setPackItems(env.DB, id, intruder.id, [c.lineageId], 3)).toEqual({
			ok: false,
			code: 'not-found'
		});
		expect(await setPackItems(env.DB, id, owner.id, [a.lineageId, a.lineageId], 3)).toEqual({
			ok: false,
			code: 'invalid-input'
		});
		const tooMany = Array.from({ length: 101 }, () => sid('lin'));
		expect(await setPackItems(env.DB, id, owner.id, tooMany, 3)).toEqual({
			ok: false,
			code: 'invalid-input'
		});
		const privateOther = await publish(intruder.id, { visibility: 'private' });
		expect(await setPackItems(env.DB, id, owner.id, [privateOther.lineageId], 3)).toEqual({
			ok: false,
			code: 'not-found'
		});

		expect(
			await updatePack(env.DB, id, owner.id, { name: 'Voices', visibility: 'unlisted' }, 4)
		).toEqual({
			ok: true,
			value: { changed: true }
		});
		expect(await updatePack(env.DB, id, intruder.id, { name: 'Mine' }, 4)).toEqual({
			ok: false,
			code: 'not-found'
		});
		expect(await updatePack(env.DB, id, owner.id, { name: '' }, 4)).toEqual({
			ok: false,
			code: 'invalid-input'
		});
		expect((await listOwnPacks(env.DB, owner.id)).items[0]).toMatchObject({
			id,
			name: 'Voices',
			visibility: 'unlisted',
			description: 'For voice'
		});
		expect(await deletePack(env.DB, id, intruder.id)).toBe(false);
		expect(await deletePack(env.DB, id, owner.id)).toBe(true);
		expect(await count('SELECT count(*) AS n FROM pack_items WHERE pack_id = ?', id)).toBe(0);
	});

	it('moderated packs disappear for everyone but the owner', async () => {
		const owner = await seedUser();
		const id = sid('pack');
		await createPack(env.DB, {
			id,
			ownerUserId: owner.id,
			name: 'Pack',
			description: '',
			visibility: 'public',
			now: 1
		});
		expect(await setModeration(env.DB, 'pack', id, 'hidden', 2)).toBe(true);
		expect(await getPackForViewer(env.DB, id, { userId: null })).toBeNull();
		expect((await getPackForViewer(env.DB, id, { userId: owner.id }))?.moderation).toBe('hidden');
		expect(
			await createPack(env.DB, {
				id: 'x',
				ownerUserId: owner.id,
				name: 'P',
				description: '',
				visibility: 'public',
				now: 1
			})
		).toEqual({
			ok: false,
			code: 'invalid-input'
		});
	});
});

describe('reports', () => {
	it('one report per reporter and target; eligible reporters are verified, unbanned and old enough', async () => {
		const author = await seedUser();
		const { lineageId } = await publish(author.id);
		const now = Date.now();
		const old = async () => {
			const user = await seedUser();
			await setUserCreatedAt(user.id, now - 5 * DAY_MS);
			return user;
		};
		const reporters = [await old(), await old(), await old()];
		const fresh = await seedUser();
		const unverified = await seedUser({ verified: false });
		await setUserCreatedAt(unverified.id, now - 5 * DAY_MS);
		const banned = await old();
		const report = (reporterUserId: string) =>
			insertReport(env.DB, {
				id: sid('rep'),
				targetKind: 'lineage',
				targetId: lineageId,
				reason: 'dangerous',
				note: 'Too loud at 3 kHz',
				reporterUserId,
				now
			});
		for (const user of [...reporters, fresh, unverified, banned]) {
			expect(await report(user.id)).toEqual({ ok: true, value: { created: true } });
		}
		expect(await report(reporters[0]?.id ?? '')).toEqual({ ok: true, value: { created: false } });
		await ban(banned.id);
		const rule = { minAccountAgeMs: 3 * DAY_MS, now };
		expect(await countEligibleReporters(env.DB, 'lineage', lineageId, rule)).toBe(3);

		// Auto-hide never overrides an admin decision.
		expect(await setModeration(env.DB, 'lineage', lineageId, 'auto_hidden', now, 'visible')).toBe(
			true
		);
		expect(await getLineageForViewer(env.DB, lineageId, { userId: null })).toBeNull();
		expect(await setModeration(env.DB, 'lineage', lineageId, 'hidden', now)).toBe(true);
		expect(await setModeration(env.DB, 'lineage', lineageId, 'auto_hidden', now, 'visible')).toBe(
			false
		);
		expect(await setCurated(env.DB, lineageId, true, now)).toBe(true);

		const queue = await listReportQueue(env.DB, { limit: 100 });
		expect(queue.items.find((entry) => entry.targetId === lineageId)).toMatchObject({
			targetKind: 'lineage',
			openReports: 6
		});
		expect(await resolveReports(env.DB, 'lineage', lineageId, 'restored', now + 1)).toBe(6);
		expect(await resolveReports(env.DB, 'lineage', lineageId, 'restored', now + 2)).toBe(0);
		expect(await countEligibleReporters(env.DB, 'lineage', lineageId, rule)).toBe(0);
		const reports = await listReportsForTarget(env.DB, 'lineage', lineageId);
		expect(reports).toHaveLength(6);
		expect(
			reports.every((row) => row.resolution === 'restored' && row.resolvedAt === now + 1)
		).toBe(true);
	});

	it('validates the input', async () => {
		const reporter = await seedUser();
		const base = {
			id: sid('rep'),
			targetKind: 'user' as const,
			targetId: reporter.id,
			reason: 'spam' as const,
			note: null,
			reporterUserId: reporter.id,
			now: 1
		};
		expect(await insertReport(env.DB, { ...base, note: 'n'.repeat(501) })).toEqual({
			ok: false,
			code: 'invalid-input'
		});
		const reason: unknown = 'boring';
		expect(await insertReport(env.DB, { ...base, reason: reason as 'spam' })).toEqual({
			ok: false,
			code: 'invalid-input'
		});
		expect(await insertReport(env.DB, base)).toEqual({ ok: true, value: { created: true } });
	});

	it('the report queue pages with a stable cursor', async () => {
		const reporter = await seedUser();
		const targets = [sid('t'), sid('t'), sid('t')];
		const at = Date.now();
		for (const targetId of targets) {
			await insertReport(env.DB, {
				id: sid('rep'),
				targetKind: 'pack',
				targetId,
				reason: 'spam',
				note: null,
				reporterUserId: reporter.id,
				now: at
			});
		}
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let guard = 0; guard < 1000; guard += 1) {
			const page = await listReportQueue(env.DB, { cursor, limit: 2 });
			seen.push(...page.items.map((entry) => `${entry.targetKind}:${entry.targetId}`));
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		const mine = seen.filter((key) => targets.some((target) => key === `pack:${target}`));
		expect(mine).toHaveLength(3);
		expect(new Set(seen).size).toBe(seen.length);
	});
});

describe('versions keep the curated flag and moderation apart from the owner status', () => {
	it('appending to a moderated lineage keeps the moderation state', async () => {
		const owner = await seedUser();
		const published = await publish(owner.id);
		await setModeration(env.DB, 'lineage', published.lineageId, 'hidden', Date.now());
		const appended = await appendVersion(env.DB, {
			lineageId: published.lineageId,
			ownerUserId: owner.id,
			expectedHead: published.versionId,
			curve: curveInput(),
			version: versionInput(),
			now: Date.now()
		});
		expect(appended.ok).toBe(true);
		const lineage = await getLineageForViewer(env.DB, published.lineageId, { userId: owner.id });
		expect(lineage?.moderation).toBe('hidden');
		expect(await getLineageForViewer(env.DB, published.lineageId, { userId: null })).toBeNull();
	});
});
