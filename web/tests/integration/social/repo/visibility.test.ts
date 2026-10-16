// Visibility in every read of the repository (T4.1): private lineages never listed, unlisted only
// by id, hidden / auto-hidden / removed / retracted / banned owner / gate-rejected head excluded
// from every list, the owner sees their own, admins only through the explicit flag.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	addFavorite,
	canViewLineage,
	countsForLineages,
	createPack,
	getLineageForViewer,
	getPackForViewer,
	getVersionForViewer,
	listFavorites,
	listLineagesByCurve,
	listOwnLineages,
	listProfileFavorites,
	listProfileLineages,
	listProfilePacks,
	listPublicFeed,
	listPublicPacks,
	listRankings,
	publicLineageSql,
	readableLineageSql,
	recomputeRankings,
	retractLineage,
	saveCurveGate,
	setLineageVisibility,
	setModeration,
	setPackItems,
	type VisibilityFacts
} from '#lib/server/social/repo.ts';
import type { LineageSummary, Page, Viewer } from '#lib/server/social/types.ts';
import { ban, member, publish, seedUser, sid, type Published } from './helpers.ts';

type Case =
	| 'public'
	| 'unlisted'
	| 'private'
	| 'retracted'
	| 'hidden'
	| 'autoHidden'
	| 'removed'
	| 'gateFailed'
	| 'bannedOwner';

const CASES: Case[] = [
	'public',
	'unlisted',
	'private',
	'retracted',
	'hidden',
	'autoHidden',
	'removed',
	'gateFailed',
	'bannedOwner'
];

let owner: Awaited<ReturnType<typeof member>>;
let bannedOwner: Awaited<ReturnType<typeof member>>;
let fan: Awaited<ReturnType<typeof member>>;
let stranger: Awaited<ReturnType<typeof member>>;
const lineages = {} as Record<Case, Published>;
let packId: string;

const ANON: Viewer = { userId: null };

beforeAll(async () => {
	owner = await member({ library: 'public', activity: 'public' });
	bannedOwner = await member({ library: 'public' });
	fan = await member({ library: 'public', activity: 'public' });
	stranger = await member();
	const voters = [fan, stranger, await member(), await member()];
	for (const name of CASES) {
		lineages[name] = await publish(name === 'bannedOwner' ? bannedOwner.id : owner.id);
	}
	// Activity while everything is still public, so every lineage would rank and count.
	for (const name of CASES) {
		for (const voter of voters) {
			const result = await addFavorite(env.DB, voter.id, lineages[name].lineageId, Date.now());
			expect(result.ok).toBe(true);
		}
	}
	const now = Date.now();
	await setLineageVisibility(env.DB, lineages.unlisted.lineageId, owner.id, 'unlisted', now);
	await setLineageVisibility(env.DB, lineages.private.lineageId, owner.id, 'private', now);
	await retractLineage(env.DB, lineages.retracted.lineageId, owner.id, now);
	await setModeration(env.DB, 'lineage', lineages.hidden.lineageId, 'hidden', now);
	await setModeration(
		env.DB,
		'lineage',
		lineages.autoHidden.lineageId,
		'auto_hidden',
		now,
		'visible'
	);
	await setModeration(env.DB, 'lineage', lineages.removed.lineageId, 'removed', now);
	await saveCurveGate(
		env.DB,
		{ ...lineages.gateFailed.curve, gateVer: 'v2:stricter', gateOk: false, gateReasons: ['X'] },
		now
	);
	await ban(bannedOwner.id);

	packId = sid('pack');
	const pack = await createPack(env.DB, {
		id: packId,
		ownerUserId: owner.id,
		name: 'Everything',
		description: '',
		visibility: 'public',
		now
	});
	expect(pack.ok).toBe(true);
	// Added by the owner, who can read all of their own lineages (not the banned owner's).
	const own = CASES.filter((name) => name !== 'bannedOwner' && name !== 'gateFailed');
	const items = await setPackItems(
		env.DB,
		packId,
		owner.id,
		own.map((name) => lineages[name].lineageId),
		now
	);
	expect(items).toEqual({ ok: true, value: { count: own.length } });
});

function mine(found: string[]): Case[] {
	return CASES.filter((name) => found.includes(lineages[name].lineageId));
}

async function walk<T>(
	read: (cursor: string | null) => Promise<Page<T>>,
	id: (item: T) => string
): Promise<string[]> {
	const seen: string[] = [];
	let cursor: string | null = null;
	for (let guard = 0; guard < 500; guard += 1) {
		const page: Page<T> = await read(cursor);
		seen.push(...page.items.map(id));
		if (!page.nextCursor) return seen;
		cursor = page.nextCursor;
	}
	throw new Error('pagination did not end');
}

const summaryId = (item: LineageSummary) => item.id;

describe('lists only show publicly listable lineages', () => {
	it('public feed', async () => {
		const found = await walk((cursor) => listPublicFeed(env.DB, { cursor, limit: 50 }), summaryId);
		expect(mine(found)).toEqual(['public']);
	});

	it('rankings (computed while everything was public, re-checked on read)', async () => {
		const now = Date.now();
		await recomputeRankings(env.DB, 'favorites', 'all', now);
		const found = await walk(
			(cursor) => listRankings(env.DB, 'favorites', 'all', { cursor, limit: 100 }),
			(entry) => entry.lineage.id
		);
		expect(mine(found)).toEqual(['public']);
		// Stored rows exclude them already (not only the read-time check).
		const stored = await env.DB.prepare(
			"SELECT lineage_id FROM rankings WHERE metric = 'favorites' AND \"window\" = 'all'"
		).all<{ lineage_id: string }>();
		expect(mine(stored.results.map((row) => row.lineage_id))).toEqual(['public']);
	});

	it('profile creations, favorites and packs', async () => {
		const creations = await walk(
			(cursor) => listProfileLineages(env.DB, owner.id, { cursor, limit: 50 }),
			summaryId
		);
		expect(mine(creations)).toEqual(['public']);
		const favorites = await walk(
			(cursor) => listProfileFavorites(env.DB, fan.id, { cursor, limit: 50 }),
			(entry) => entry.lineage.id
		);
		expect(mine(favorites)).toEqual(['public']);
		const banned = await listProfileLineages(env.DB, bannedOwner.id);
		expect(banned.items).toEqual([]);
		const packs = await listProfilePacks(env.DB, owner.id);
		expect(packs.items.map((pack) => pack.id)).toContain(packId);
	});

	it('items of someone else’s pack; the owner sees their own items', async () => {
		const forAnyone = await getPackForViewer(env.DB, packId, ANON);
		expect(mine(forAnyone?.items.map((item) => item.lineage.id) ?? [])).toEqual(['public']);
		const forStranger = await getPackForViewer(env.DB, packId, { userId: stranger.id });
		expect(mine(forStranger?.items.map((item) => item.lineage.id) ?? [])).toEqual(['public']);
		const forOwner = await getPackForViewer(env.DB, packId, { userId: owner.id });
		expect(mine(forOwner?.items.map((item) => item.lineage.id) ?? []).sort()).toEqual(
			['autoHidden', 'hidden', 'private', 'public', 'removed', 'retracted', 'unlisted'].sort()
		);
	});

	it('lineages by curve', async () => {
		const found: string[] = [];
		for (const name of CASES) {
			const list = await listLineagesByCurve(env.DB, lineages[name].curve.id, ANON);
			found.push(...list.map(summaryId));
		}
		expect(mine(found)).toEqual(['public']);
	});

	it('a user’s own favorites keep only what the user can still read', async () => {
		const found = await walk(
			(cursor) => listFavorites(env.DB, stranger.id, { cursor, limit: 50 }),
			(entry) => entry.lineage.id
		);
		expect(mine(found).sort()).toEqual(['public', 'unlisted']);
	});

	it('the owner’s own library lists every state (owner-scoped exception)', async () => {
		const found = await walk(
			(cursor) => listOwnLineages(env.DB, owner.id, { cursor, limit: 3 }),
			summaryId
		);
		expect(mine(found).sort()).toEqual(CASES.filter((name) => name !== 'bannedOwner').sort());
		const privateOnly = await listOwnLineages(env.DB, owner.id, { visibility: 'private' });
		expect(mine(privateOnly.items.map(summaryId))).toEqual(['private']);
		// Another user's id gives only that user's rows, never the owner's.
		const other = await listOwnLineages(env.DB, stranger.id);
		expect(mine(other.items.map(summaryId))).toEqual([]);
	});

	it('public packs list neither private nor unlisted packs', async () => {
		const hiddenPack = sid('pack');
		await createPack(env.DB, {
			id: hiddenPack,
			ownerUserId: owner.id,
			name: 'Secret',
			description: '',
			visibility: 'private',
			now: Date.now()
		});
		const found = await walk(
			(cursor) => listPublicPacks(env.DB, { cursor, limit: 50 }),
			(pack) => pack.id
		);
		expect(found).toContain(packId);
		expect(found).not.toContain(hiddenPack);
		expect(await getPackForViewer(env.DB, hiddenPack, ANON)).toBeNull();
		expect((await getPackForViewer(env.DB, hiddenPack, { userId: owner.id }))?.id).toBe(hiddenPack);
	});
});

describe('reads by id', () => {
	const readable = async (viewer: Viewer): Promise<Case[]> => {
		const found: Case[] = [];
		for (const name of CASES) {
			if (await getLineageForViewer(env.DB, lineages[name].lineageId, viewer)) found.push(name);
		}
		return found;
	};

	it('anonymous and other users: public and unlisted only', async () => {
		expect(await readable(ANON)).toEqual(['public', 'unlisted']);
		expect(await readable({ userId: stranger.id })).toEqual(['public', 'unlisted']);
		// A version of a hidden lineage is not readable either.
		expect(await getVersionForViewer(env.DB, lineages.hidden.versionId, ANON)).toBeNull();
		expect(await getVersionForViewer(env.DB, lineages.public.versionId, ANON)).not.toBeNull();
	});

	it('the owner reads every own lineage; an admin reads everything, only with the flag', async () => {
		expect(await readable({ userId: owner.id })).toEqual(
			CASES.filter((name) => name !== 'bannedOwner')
		);
		expect(await readable({ userId: stranger.id, admin: true })).toEqual(CASES);
		expect(
			await getVersionForViewer(env.DB, lineages.gateFailed.versionId, { userId: owner.id })
		).not.toBeNull();
	});

	it('public counts only for lineages the viewer can read', async () => {
		const counts = await countsForLineages(
			env.DB,
			CASES.map((name) => lineages[name].lineageId),
			ANON
		);
		expect(mine([...counts.keys()]).sort()).toEqual(['public', 'unlisted']);
		expect(counts.get(lineages.public.lineageId)?.favorites).toBe(4);
	});
});

describe('predicates', () => {
	it('canViewLineage mirrors the SQL rules', () => {
		const base: VisibilityFacts = {
			ownerUserId: 'owner-0001',
			visibility: 'public',
			status: 'active',
			moderation: 'visible',
			headGateOk: true,
			ownerBanned: false
		};
		const anyone: Viewer = { userId: null };
		expect(canViewLineage(base, anyone, true)).toBe(true);
		expect(canViewLineage({ ...base, visibility: 'unlisted' }, anyone, true)).toBe(false);
		expect(canViewLineage({ ...base, visibility: 'unlisted' }, anyone)).toBe(true);
		expect(canViewLineage({ ...base, visibility: 'private' }, anyone)).toBe(false);
		expect(canViewLineage({ ...base, visibility: 'private' }, { userId: 'owner-0001' })).toBe(true);
		expect(canViewLineage({ ...base, visibility: 'private' }, { userId: 'x', admin: true })).toBe(
			true
		);
		expect(canViewLineage({ ...base, visibility: 'private' }, { userId: 'owner-0001' }, true)).toBe(
			false
		);
		for (const facts of [
			{ status: 'retracted' as const },
			{ moderation: 'hidden' as const },
			{ headGateOk: false },
			{ ownerBanned: true }
		]) {
			expect(canViewLineage({ ...base, ...facts }, anyone)).toBe(false);
		}
	});

	it('refuses unsafe aliases and keeps viewer ids as parameters', () => {
		expect(() => publicLineageSql('l; DROP TABLE x')).toThrow();
		const fragment = readableLineageSql('l', { userId: "x' OR 1=1" });
		expect(fragment.text).not.toContain("x' OR 1=1");
		expect(fragment.params).toEqual(["x' OR 1=1"]);
		expect(readableLineageSql('l', { userId: null }).params).toEqual([]);
		expect(readableLineageSql('l', { userId: 'u', admin: true }).text).toContain('1 = 1');
	});
});

describe('seed sanity', () => {
	it('the banned owner is really banned and the stranger sees nothing private', async () => {
		const row = await env.DB.prepare('SELECT "banned" AS banned FROM "user" WHERE "id" = ?')
			.bind(bannedOwner.id)
			.first<{ banned: number }>();
		expect(row?.banned).toBe(1);
		const outsider = await seedUser();
		expect(
			await getLineageForViewer(env.DB, lineages.private.lineageId, { userId: outsider.id })
		).toBeNull();
	});
});
