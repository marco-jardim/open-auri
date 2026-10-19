// YOLO publication, exposure: an acknowledged public YOLO lineage opens by id but never shows in
// the default feed, the rankings, S6 eligibility, S7 trades or anything else built on
// `publicLineageSql` (profiles, packs, the public dump); `GET /api/v1/feed?yolo=only` lists it
// instead. Moderation hides it at 2 eligible reporters, curation refuses it, the admin preview
// flags it. The OG card shows the YOLO chip, its metadata records it, and `/c/:id` is `noindex`.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { encodeS1 } from 'open-auri/share';
import { ApiError } from '#lib/server/api/index.ts';
import { getServerEnv } from '#lib/server/env.ts';
import { isCurrentCard, OG_CARD_VERSION, ogKey } from '#lib/server/og/keys.ts';
import { getOrCreateOg, type OgEnv } from '#lib/server/og/store.ts';
import { ogSvg } from '#lib/server/og/svg.ts';
import { publishCurve, type PublishedInfo } from '#lib/server/social/curves.ts';
import { fileReport, YOLO_AUTO_HIDE_THRESHOLD } from '#lib/server/social/moderation.ts';
import { targetPreview } from '#lib/server/social/queries/moderation.ts';
import { listableCurveIds } from '#lib/server/social/queries/s6.ts';
import { parseFeedQuery, readFeed } from '#lib/server/social/rankings.ts';
import {
	addFavorite,
	createTrade,
	encodeCursor,
	getLineageForViewer,
	publicLineageSql,
	recomputeRankings,
	setCurated
} from '#lib/server/social/repo.ts';
import { loadSharedCurve, sharedCurveMeta } from '#lib/server/social/shares.ts';
import { ANONYMOUS_VIEWER, SocialRepoError } from '#lib/server/social/types.ts';
import {
	actor,
	ageAccount,
	count,
	envelopeOf,
	published,
	uniqueYoloCurve,
	type Actor
} from '../curves/helpers.ts';
import { sid } from '../repo/helpers.ts';

/** YOLO_PUBLICATION on for the reads (absent = 'off': no YOLO head is served to others). */
const ON_READ = { yoloPublication: 'on' as const };

async function veteran(): Promise<Actor> {
	const owner = await actor();
	await ageAccount(owner.user);
	return owner;
}

/** A public YOLO lineage acknowledged by its (old enough) owner, plus a public standard one. */
async function pair(): Promise<{ owner: Actor; yolo: PublishedInfo; standard: PublishedInfo }> {
	const owner = await veteran();
	const yolo = await publishCurve(
		env.DB,
		owner.user.id,
		{ envelope: envelopeOf(uniqueYoloCurve()), visibility: 'public', acknowledge: 'yolo' },
		{ yoloPublication: 'on' }
	);
	const standard = await published(owner);
	return { owner, yolo, standard };
}

/** Whether `lineageId` is in the `new` feed (walked from its own creation time downwards). */
async function inFeed(lineageId: string, owner: Actor, yolo: boolean): Promise<boolean> {
	const lineage = await getLineageForViewer(env.DB, lineageId, { userId: owner.user.id });
	if (!lineage) throw new Error('owner cannot read the lineage');
	let cursor: string | null = encodeCursor([lineage.createdAt + 1, '']);
	for (let guard = 0; guard < 20 && cursor !== null; guard++) {
		const page = await readFeed(
			env.DB,
			{ sort: 'new', cursor, limit: 100, ...(yolo ? { yolo: 'only' as const } : {}) },
			'on'
		);
		if (page.items.some((item) => item.lineage.id === lineageId)) return true;
		const last = page.items[page.items.length - 1];
		if (!last || last.lineage.createdAt < lineage.createdAt) return false;
		cursor = page.nextCursor;
	}
	return false;
}

async function listable(lineageId: string): Promise<number> {
	return count(
		`SELECT count(*) AS n FROM lineages l WHERE l.id = ? AND ${publicLineageSql('l')}`,
		lineageId
	);
}

describe('lists keep YOLO apart', () => {
	it('the default feed excludes YOLO; yolo=only lists it and nothing standard', async () => {
		const { owner, yolo, standard } = await pair();
		expect(await inFeed(yolo.lineageId, owner, false)).toBe(false);
		expect(await inFeed(standard.lineageId, owner, false)).toBe(true);
		expect(await inFeed(yolo.lineageId, owner, true)).toBe(true);
		expect(await inFeed(standard.lineageId, owner, true)).toBe(false);
		const page = await readFeed(env.DB, { sort: 'new', limit: 100, yolo: 'only' }, 'on');
		expect(page.items.every((item) => item.lineage.curve.yolo === true)).toBe(true);
	});

	it('yolo=only takes sort=new only (a ranked sort is 400), and only the value "only"', async () => {
		const parse = (query: string) => () =>
			parseFeedQuery(new URL(`${env.PUBLIC_ORIGIN}/api/v1/feed?${query}`));
		expect(parse('yolo=only')()).toMatchObject({ sort: 'new', yolo: 'only' });
		expect(parse('sort=new')()).not.toHaveProperty('yolo');
		for (const query of ['yolo=only&sort=favorites', 'yolo=only&sort=installs', 'yolo=yes']) {
			let thrown: unknown = null;
			try {
				parse(query)();
			} catch (error) {
				thrown = error;
			}
			expect(thrown, query).toBeInstanceOf(ApiError);
			expect(thrown instanceof ApiError ? thrown.status : 0, query).toBe(400);
		}
		await expect(readFeed(env.DB, { sort: 'favorites', yolo: 'only' })).rejects.toBeInstanceOf(
			SocialRepoError
		);
	});

	it('rankings, profiles, packs and the dump (publicLineageSql) never hold a YOLO head', async () => {
		const { yolo, standard } = await pair();
		expect(await listable(yolo.lineageId)).toBe(0);
		expect(await listable(standard.lineageId)).toBe(1);
		const fan = await actor();
		await addFavorite(env.DB, fan.user.id, yolo.lineageId, Date.now() - 1000, 'on');
		await recomputeRankings(env.DB, 'favorites', 'all', Date.now());
		expect(
			await count('SELECT count(*) AS n FROM rankings WHERE lineage_id = ?', yolo.lineageId)
		).toBe(0);
	});

	it('S6 eligibility and S7 trades exclude YOLO heads', async () => {
		const { yolo, standard } = await pair();
		const eligible = await listableCurveIds(env.DB, [yolo.curveId, standard.curveId]);
		expect(eligible.has(standard.curveId)).toBe(true);
		expect(eligible.has(yolo.curveId)).toBe(false);

		const trader = await actor();
		const refused = await createTrade(env.DB, {
			id: sid('trade'),
			userId: trader.user.id,
			lineageId: yolo.lineageId,
			versionId: yolo.versionId,
			now: Date.now()
		});
		expect(refused).toEqual({ ok: false, code: 'not-found' });
		const accepted = await createTrade(env.DB, {
			id: sid('trade'),
			userId: trader.user.id,
			lineageId: standard.lineageId,
			versionId: standard.versionId,
			now: Date.now()
		});
		expect(accepted.ok).toBe(true);
	});

	it('an acknowledged YOLO lineage still opens by id (public page data carries the class)', async () => {
		const { yolo } = await pair();
		const shared = await loadSharedCurve(env.DB, ANONYMOUS_VIEWER, yolo.lineageId, null, ON_READ);
		if (shared.kind !== 'ok') throw new Error('YOLO lineage not linkable');
		expect(shared.curve.yolo).toBe(true);
		expect(shared.curve.waived).toContain('d7:pk-boost-above-16k');
	});
});

describe('moderation', () => {
	it(`auto-hides a YOLO lineage at ${YOLO_AUTO_HIDE_THRESHOLD} eligible reporters, not a standard one`, async () => {
		const { yolo, standard } = await pair();
		const reporters = [await veteran(), await veteran()];
		const results: boolean[] = [];
		for (const target of [yolo.lineageId, standard.lineageId]) {
			for (const reporter of reporters) {
				const filed = await fileReport(env.DB, {
					reporterUserId: reporter.user.id,
					targetKind: 'lineage',
					targetId: target,
					reason: 'spam',
					note: null,
					now: Date.now(),
					yoloPublication: 'on'
				});
				if (!filed.ok) throw new Error(`report refused: ${filed.code}`);
				results.push(filed.autoHidden);
			}
		}
		expect(results).toEqual([false, true, false, false]);
		expect(
			await count(
				"SELECT count(*) AS n FROM lineages WHERE id = ? AND moderation = 'auto_hidden'",
				yolo.lineageId
			)
		).toBe(1);
		expect(
			await count(
				"SELECT count(*) AS n FROM lineages WHERE id = ? AND moderation = 'visible'",
				standard.lineageId
			)
		).toBe(1);
	});

	it('the admin preview flags YOLO with its waived codes; curation refuses YOLO heads', async () => {
		const { yolo, standard } = await pair();
		const flagged = await targetPreview(env.DB, 'lineage', yolo.lineageId);
		expect(flagged?.yolo).toBe(true);
		expect(flagged?.waived).toContain('d7:pk-boost-above-16k');
		const plain = await targetPreview(env.DB, 'lineage', standard.lineageId);
		expect(plain?.yolo).toBe(false);
		expect(plain?.waived).toEqual([]);

		expect(await setCurated(env.DB, yolo.lineageId, true, Date.now())).toBe(false);
		expect(
			await count('SELECT count(*) AS n FROM lineages WHERE id = ? AND curated = 1', yolo.lineageId)
		).toBe(0);
		expect(await setCurated(env.DB, yolo.lineageId, false, Date.now())).toBe(true);
		expect(await setCurated(env.DB, standard.lineageId, true, Date.now())).toBe(true);
	});
});

describe('OG and meta tags', () => {
	it('the card draws the YOLO chip only for YOLO curves (layout 3)', () => {
		expect(OG_CARD_VERSION).toBe('3');
		const s1 = encodeS1(uniqueYoloCurve());
		const base = { name: 'Curva', license: 'CC0-1.0', s1, lang: 'pt-BR' as const };
		expect(ogSvg({ ...base, yolo: true })).toContain('>YOLO</text>');
		expect(ogSvg(base)).not.toContain('YOLO');
		expect(ogSvg({ ...base, yolo: false })).toBe(ogSvg(base));
	});

	it('isCurrentCard compares the YOLO flag when given (the sweep only checks the layout)', () => {
		expect(isCurrentCard({ card: OG_CARD_VERSION, yolo: '1' }, true)).toBe(true);
		expect(isCurrentCard({ card: OG_CARD_VERSION, yolo: '1' }, false)).toBe(false);
		expect(isCurrentCard({ card: OG_CARD_VERSION, yolo: '0' }, false)).toBe(true);
		expect(isCurrentCard({ card: OG_CARD_VERSION }, true)).toBe(false);
		expect(isCurrentCard({ card: OG_CARD_VERSION })).toBe(true);
		expect(isCurrentCard({ card: '2', yolo: '1' }, true)).toBe(false);
	});

	it('renders and stores a YOLO card with customMetadata.yolo = "1"', async () => {
		const { yolo } = await pair();
		const server = getServerEnv({ env });
		const ogEnv: OgEnv = {
			db: server.db,
			media: server.media,
			publicOrigin: server.publicOrigin,
			assets: null,
			yoloPublication: 'on'
		};
		const pending: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(promise);
			}
		};
		let svg = '';
		const result = await getOrCreateOg(ogEnv, ctx, yolo.versionId, {
			render: async (input) => {
				svg = input;
				return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
			}
		});
		await Promise.all(pending);
		expect(result.ok && result.source).toBe('render');
		expect(svg).toContain('>YOLO</text>');
		const stored = await server.media.head(ogKey(yolo.curveId, yolo.versionId));
		expect(stored?.customMetadata).toMatchObject({ card: OG_CARD_VERSION, yolo: '1' });
	});

	it('/c/:id of a YOLO curve is noindex and its image URL carries ?y=1', async () => {
		const { yolo, standard } = await pair();
		const yoloPage = await loadSharedCurve(env.DB, ANONYMOUS_VIEWER, yolo.lineageId, null, ON_READ);
		const plainPage = await loadSharedCurve(env.DB, ANONYMOUS_VIEWER, standard.lineageId, null);
		if (yoloPage.kind !== 'ok' || plainPage.kind !== 'ok') throw new Error('not linkable');
		const yoloMeta = sharedCurveMeta(env.PUBLIC_ORIGIN, yoloPage.curve);
		expect(yoloMeta.indexable).toBe(false);
		expect(yoloMeta.image.endsWith(`/og/${yolo.versionId}.png?y=1`)).toBe(true);
		const plainMeta = sharedCurveMeta(env.PUBLIC_ORIGIN, plainPage.curve);
		expect(plainMeta.indexable).toBe(true);
		expect(plainMeta.image.endsWith(`/og/${standard.versionId}.png`)).toBe(true);
		expect(plainPage.curve.yolo).toBe(false);
		expect(plainPage.curve.waived).toEqual([]);
	});
});
