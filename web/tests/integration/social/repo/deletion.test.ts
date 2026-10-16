// Account closure across every social table (T4.1 extension of the T3.7 deletion tests): both
// modes delete everything personal, 'delete-all' deletes all content, 'anonymize' keeps public
// active lineages and public packs without an owner; forks by others survive; nothing of the other
// users is touched beyond losing what pointed at deleted content.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	accountDeletionHook,
	recordDeletionRequest,
	type DeletionMode
} from '#lib/server/account/deletion.ts';
import {
	addFavorite,
	appendVersion,
	countsForLineages,
	createPack,
	createShare,
	createTrade,
	forkLineage,
	getLineageForViewer,
	getPackForViewer,
	insertReport,
	recomputeRankings,
	recordActivity,
	recordShareEvent,
	resolveReports,
	retractLineage,
	setPackItems,
	tryPairTrades
} from '#lib/server/social/repo.ts';
import {
	count,
	curveInput,
	member,
	publish,
	sid,
	versionInput,
	type Published
} from './helpers.ts';

interface World {
	user: Awaited<ReturnType<typeof member>>;
	other: Awaited<ReturnType<typeof member>>;
	pub: Published & { second: string };
	unlisted: Published;
	priv: Published;
	retracted: Published;
	otherLineage: Published;
	fork: string;
	publicPack: string;
	privatePack: string;
	userShare: string;
	otherShare: string;
	otherTrade: string;
	openReport: string;
	resolvedReport: string;
	aboutUser: string;
	aboutPrivate: string;
	otherReport: string;
}

/** User U with content in every state and every kind of social row, plus another user O. */
async function world(): Promise<World> {
	const user = await member({ library: 'public', activity: 'public' });
	const other = await member({ library: 'public', activity: 'public' });
	const now = Date.now();
	const pub = await publish(user.id);
	const second = versionInput();
	const appended = await appendVersion(env.DB, {
		lineageId: pub.lineageId,
		ownerUserId: user.id,
		expectedHead: pub.versionId,
		curve: curveInput(),
		version: second,
		now
	});
	if (!appended.ok) throw new Error(appended.code);
	const unlisted = await publish(user.id, { visibility: 'unlisted' });
	const priv = await publish(user.id, { visibility: 'private' });
	const retracted = await publish(user.id);
	await retractLineage(env.DB, retracted.lineageId, user.id, now);
	const otherLineage = await publish(other.id);

	// O forks U's public root version.
	const fork = sid('lin');
	const forked = await forkLineage(env.DB, pub.versionId, {
		lineageId: fork,
		ownerUserId: other.id,
		visibility: 'public',
		curve: curveInput(),
		version: versionInput(),
		now
	});
	if (!forked.ok) throw new Error(forked.code);

	// Favorites and activity both ways.
	await addFavorite(env.DB, user.id, otherLineage.lineageId, now);
	await addFavorite(env.DB, user.id, pub.lineageId, now);
	await addFavorite(env.DB, other.id, pub.lineageId, now);
	await addFavorite(env.DB, other.id, unlisted.lineageId, now);
	await recordActivity(env.DB, user.id, otherLineage.lineageId, 'installed', now);
	await recordActivity(env.DB, other.id, pub.lineageId, 'previewed', now);

	// Shares: U shares their lineage (O previews through it); O shares their own (U favorites).
	const userShare = sid('share');
	await createShare(env.DB, {
		id: userShare,
		lineageId: pub.lineageId,
		versionId: null,
		ownerUserId: user.id,
		channel: 'link',
		now
	});
	await recordShareEvent(env.DB, {
		shareId: userShare,
		kind: 'open',
		userId: null,
		day: '2026-10-16',
		at: now
	});
	await recordShareEvent(env.DB, {
		shareId: userShare,
		kind: 'previewed',
		userId: other.id,
		day: '2026-10-16',
		at: now
	});
	const otherShare = sid('share');
	await createShare(env.DB, {
		id: otherShare,
		lineageId: otherLineage.lineageId,
		versionId: null,
		ownerUserId: other.id,
		channel: null,
		now
	});
	await recordShareEvent(env.DB, {
		shareId: otherShare,
		kind: 'favorited',
		userId: user.id,
		day: '2026-10-16',
		at: now
	});

	// Packs.
	const publicPack = sid('pack');
	const privatePack = sid('pack');
	for (const [id, visibility] of [
		[publicPack, 'public'],
		[privatePack, 'private']
	] as const) {
		await createPack(env.DB, {
			id,
			ownerUserId: user.id,
			name: 'Pack',
			description: '',
			visibility,
			now
		});
		await setPackItems(
			env.DB,
			id,
			user.id,
			[pub.lineageId, priv.lineageId, otherLineage.lineageId],
			now
		);
	}

	// Reports by U (open and resolved), about U, about U's private lineage, and by O about O's.
	const report = async (
		targetKind: 'lineage' | 'pack' | 'user',
		targetId: string,
		reporter: string
	) => {
		const id = sid('rep');
		const result = await insertReport(env.DB, {
			id,
			targetKind,
			targetId,
			reason: 'spam',
			note: null,
			reporterUserId: reporter,
			now
		});
		if (!result.ok || !result.value.created) throw new Error('report not created');
		return id;
	};
	const openReport = await report('lineage', otherLineage.lineageId, user.id);
	const elsewhere = sid('pack');
	const resolvedReport = await report('pack', elsewhere, user.id);
	await resolveReports(env.DB, 'pack', elsewhere, 'dismissed', now);
	const aboutUser = await report('user', user.id, other.id);
	const aboutPrivate = await report('lineage', priv.lineageId, other.id);
	const otherReport = await report('lineage', fork, other.id);

	// A matched trade between U and O, and a ranking that includes U's public lineage.
	const userTrade = await createTrade(env.DB, {
		id: sid('trade'),
		userId: user.id,
		lineageId: pub.lineageId,
		versionId: second.id,
		now
	});
	const otherTrade = await createTrade(env.DB, {
		id: sid('trade'),
		userId: other.id,
		lineageId: otherLineage.lineageId,
		versionId: otherLineage.versionId,
		now
	});
	if (!userTrade.ok || !otherTrade.ok) throw new Error('trade not created');
	expect(await tryPairTrades(env.DB, userTrade.value.id, otherTrade.value.id, now)).toBe(true);
	await recomputeRankings(env.DB, 'favorites', 'all', Date.now());

	return {
		user,
		other,
		pub: { ...pub, second: second.id },
		unlisted,
		priv,
		retracted,
		otherLineage,
		fork,
		publicPack,
		privatePack,
		userShare,
		otherShare,
		otherTrade: otherTrade.value.id,
		openReport,
		resolvedReport,
		aboutUser,
		aboutPrivate,
		otherReport
	};
}

/** Closes U's account the way Better Auth does: the hook's batch, then the user row. */
async function close(w: World, mode: DeletionMode): Promise<void> {
	await recordDeletionRequest(env.DB, w.user.id, mode, Date.now());
	await accountDeletionHook({ db: env.DB })({ id: w.user.id, email: w.user.email });
	await env.DB.prepare('DELETE FROM "user" WHERE "id" = ?').bind(w.user.id).run();
}

/** Rows of every social table that still reference U personally. */
async function personalRows(w: World) {
	const id = w.user.id;
	return {
		lineagesOwned: await count('SELECT count(*) AS n FROM lineages WHERE owner_user_id = ?', id),
		packsOwned: await count('SELECT count(*) AS n FROM packs WHERE owner_user_id = ?', id),
		favorites: await count('SELECT count(*) AS n FROM favorites WHERE user_id = ?', id),
		activity: await count('SELECT count(*) AS n FROM activity WHERE user_id = ?', id),
		shares: await count('SELECT count(*) AS n FROM shares WHERE owner_user_id = ?', id),
		shareEvents: await count(
			'SELECT count(*) AS n FROM share_events WHERE share_id = ?',
			w.userShare
		),
		shareEventUsers: await count(
			'SELECT count(*) AS n FROM share_event_users WHERE user_id = ?',
			id
		),
		trades: await count('SELECT count(*) AS n FROM trades WHERE user_id = ?', id),
		reportsFiled: await count('SELECT count(*) AS n FROM reports WHERE reporter_user_id = ?', id),
		reportsAboutUser: await count(
			"SELECT count(*) AS n FROM reports WHERE target_kind = 'user' AND target_id = ?",
			id
		)
	};
}

const NOTHING_PERSONAL = {
	lineagesOwned: 0,
	packsOwned: 0,
	favorites: 0,
	activity: 0,
	shares: 0,
	shareEvents: 0,
	shareEventUsers: 0,
	trades: 0,
	reportsFiled: 0,
	reportsAboutUser: 0
};

async function exists(table: string, id: string): Promise<boolean> {
	const tables: Record<string, string> = {
		lineages: 'SELECT count(*) AS n FROM lineages WHERE id = ?',
		versions: 'SELECT count(*) AS n FROM versions WHERE lineage_id = ?',
		packs: 'SELECT count(*) AS n FROM packs WHERE id = ?',
		reports: 'SELECT count(*) AS n FROM reports WHERE id = ?',
		shares: 'SELECT count(*) AS n FROM shares WHERE id = ?'
	};
	const query = tables[table];
	if (!query) throw new Error(table);
	return (await count(query, id)) > 0;
}

/** What both modes guarantee about the other user O. */
async function otherUserIntact(w: World): Promise<void> {
	expect(await exists('lineages', w.otherLineage.lineageId)).toBe(true);
	expect(await exists('lineages', w.fork)).toBe(true);
	expect(await exists('shares', w.otherShare)).toBe(true);
	expect(await exists('reports', w.otherReport)).toBe(true);
	expect(
		await count('SELECT count(*) AS n FROM share_event_users WHERE share_id = ?', w.otherShare)
	).toBe(0);
	const trade = await env.DB.prepare('SELECT status, match_id FROM trades WHERE id = ?')
		.bind(w.otherTrade)
		.first<{ status: string; match_id: string | null }>();
	expect(trade).toEqual({ status: 'cancelled', match_id: null });
	// O can start a new trade (the partial unique index no longer sees an active one).
	const again = await createTrade(env.DB, {
		id: sid('trade'),
		userId: w.other.id,
		lineageId: w.otherLineage.lineageId,
		versionId: w.otherLineage.versionId,
		now: Date.now()
	});
	expect(again.ok).toBe(true);
	// Resolved reports filed by U survive without the reporter; open ones are gone.
	expect(await exists('reports', w.openReport)).toBe(false);
	const resolved = await env.DB.prepare('SELECT reporter_user_id FROM reports WHERE id = ?')
		.bind(w.resolvedReport)
		.first<{ reporter_user_id: string | null }>();
	expect(resolved).toEqual({ reporter_user_id: null });
	expect(await exists('reports', w.aboutUser)).toBe(false);
	expect(await exists('reports', w.aboutPrivate)).toBe(false);
}

describe('social content on account closure', () => {
	it('delete-all removes every lineage, version, pack and personal row; forks survive', async () => {
		const w = await world();
		await close(w, 'delete-all');

		expect(await personalRows(w)).toEqual(NOTHING_PERSONAL);
		for (const lineage of [w.pub, w.unlisted, w.priv, w.retracted]) {
			expect(await exists('lineages', lineage.lineageId)).toBe(false);
			expect(await exists('versions', lineage.lineageId)).toBe(false);
		}
		expect(await exists('packs', w.publicPack)).toBe(false);
		expect(await exists('packs', w.privatePack)).toBe(false);
		expect(
			await count(
				'SELECT count(*) AS n FROM pack_items WHERE pack_id IN (?, ?)',
				w.publicPack,
				w.privatePack
			)
		).toBe(0);
		expect(await exists('shares', w.userShare)).toBe(false);
		// Content of U that others had touched goes with it.
		expect(
			await count('SELECT count(*) AS n FROM favorites WHERE lineage_id = ?', w.pub.lineageId)
		).toBe(0);
		expect(
			await count('SELECT count(*) AS n FROM activity WHERE lineage_id = ?', w.pub.lineageId)
		).toBe(0);
		expect(
			await count('SELECT count(*) AS n FROM rankings WHERE lineage_id = ?', w.pub.lineageId)
		).toBe(0);
		// O's fork survives, its pointer to the deleted version cleared.
		const fork = await getLineageForViewer(env.DB, w.fork, { userId: null });
		expect(fork).toMatchObject({ id: w.fork, forkedFromVersion: null, ownerUserId: w.other.id });
		await otherUserIntact(w);
	});

	it('anonymize keeps public active lineages and public packs as "autor removido"', async () => {
		const w = await world();
		await close(w, 'anonymize');

		expect(await personalRows(w)).toEqual(NOTHING_PERSONAL);
		const kept = await getLineageForViewer(env.DB, w.pub.lineageId, { userId: null });
		expect(kept).toMatchObject({ ownerUserId: null, author: null, headVersion: w.pub.second });
		expect(
			await count('SELECT count(*) AS n FROM versions WHERE lineage_id = ?', w.pub.lineageId)
		).toBe(2);
		const counts = await countsForLineages(env.DB, [w.pub.lineageId], { userId: null });
		expect(counts.get(w.pub.lineageId)).toEqual({ favorites: 1, previewed: 1, installed: 0 });
		for (const gone of [w.unlisted, w.priv, w.retracted]) {
			expect(await exists('lineages', gone.lineageId)).toBe(false);
			expect(await exists('versions', gone.lineageId)).toBe(false);
		}
		// Other people's favorites of the kept lineage stay; U's do not.
		expect(
			await count(
				'SELECT count(*) AS n FROM favorites WHERE lineage_id = ? AND user_id = ?',
				w.pub.lineageId,
				w.other.id
			)
		).toBe(1);
		expect(await exists('packs', w.privatePack)).toBe(false);
		const pack = await getPackForViewer(env.DB, w.publicPack, { userId: null });
		expect(pack).toMatchObject({ ownerUserId: null, author: null });
		expect(pack?.items.map((item) => item.lineage.id)).toEqual([
			w.pub.lineageId,
			w.otherLineage.lineageId
		]);
		expect(await exists('shares', w.userShare)).toBe(false);
		// The fork still points at the kept version.
		const fork = await getLineageForViewer(env.DB, w.fork, { userId: null });
		expect(fork?.forkedFromVersion).toBe(w.pub.versionId);
		await otherUserIntact(w);
	});

	it('is idempotent: running the social part twice changes nothing more', async () => {
		const w = await world();
		await recordDeletionRequest(env.DB, w.user.id, 'anonymize', Date.now());
		const hook = accountDeletionHook({ db: env.DB });
		await hook({ id: w.user.id, email: w.user.email });
		const first = await personalRows(w);
		await hook({ id: w.user.id, email: w.user.email });
		expect(await personalRows(w)).toEqual(first);
		expect(first).toEqual(NOTHING_PERSONAL);
		expect(await exists('lineages', w.pub.lineageId)).toBe(true);
	});
});
