// FX4.1: the feed and the rankings are public (60 s public cache), so their items are public
// cards: never the owner's user id, the curve's canonical key or gate version, nor any other
// internal field. Author ids are stable public identifiers, not authentication ids.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { runRankingsJob, type FeedLineageCard } from '#lib/server/social/rankings.ts';
import { addFavorite, encodeCursor, recordActivity } from '#lib/server/social/repo.ts';
import { GET as feedGet } from '../../../../src/routes/api/v1/feed/+server.ts';
import { GET as rankingsGet } from '../../../../src/routes/api/v1/rankings/+server.ts';
import { nick } from '../repo/helpers.ts';
import { getEvent, internalKeyPaths, publish, seedUser } from './helpers.ts';

const FEED = '/api/v1/feed';
const RANKINGS = '/api/v1/rankings';

const CARD_KEYS = ['author', 'createdAt', 'curated', 'curve', 'forked', 'head', 'id', 'updatedAt'];
const HEAD_KEYS = ['createdAt', 'description', 'id', 'lang', 'license', 'name'];
const CURVE_KEYS = ['id', 'levelDb', 's1', 'yolo'];

interface RawPage {
	items: { lineage: FeedLineageCard }[];
	nextCursor: string | null;
}

async function body(response: Response): Promise<{ text: string; page: RawPage }> {
	expect(response.status).toBe(200);
	const text = await response.text();
	const page = JSON.parse(text) as RawPage;
	return { text, page };
}

/** Walks the pages of `route` until `lineageId` shows up; returns every raw body seen. */
async function findIn(
	route: string,
	query: string,
	lineageId: string,
	get: (event: ReturnType<typeof getEvent>) => Promise<Response>
): Promise<{ texts: string[]; card: FeedLineageCard | null }> {
	const texts: string[] = [];
	let cursor: string | null = null;
	for (let guard = 0; guard < 50; guard += 1) {
		const next: string = cursor === null ? '' : `&cursor=${cursor}`;
		const { text, page } = await body(await get(getEvent(route, `${route}?${query}${next}`)));
		texts.push(text);
		const hit = page.items.find((item) => item.lineage.id === lineageId);
		if (hit) return { texts, card: hit.lineage };
		cursor = page.nextCursor;
		if (cursor === null) break;
	}
	return { texts, card: null };
}

function expectPublicCard(
	card: FeedLineageCard | null,
	owner: { id: string; email: string; username: string }
) {
	expect(card).not.toBeNull();
	if (card === null) return;
	expect(Object.keys(card).sort()).toEqual(CARD_KEYS);
	expect(Object.keys(card.head).sort()).toEqual(HEAD_KEYS);
	expect(Object.keys(card.curve).sort()).toEqual(CURVE_KEYS);
	expect(card.author).toEqual({ id: expect.stringMatching(/^[a-f0-9]{32}$/), username: owner.username, displayUsername: owner.username });
	expect(card.author?.id).not.toBe(owner.id);
}

function expectNoLeak(texts: readonly string[], owner: { id: string; email: string }) {
	for (const text of texts) {
		const parsed: unknown = JSON.parse(text);
		expect(internalKeyPaths(parsed)).toEqual([]);
		expect(text).not.toContain(owner.id);
		expect(text).not.toContain(owner.email);
	}
}

describe('public cards of the feed and the rankings', () => {
	it('feed, ranked feed and rankings carry no internal ids at any depth', async () => {
		const username = nick('rk');
		const seeded = await seedUser({ username });
		const owner = { id: seeded.id, email: seeded.email, username };
		const fan = await seedUser();
		const base = 946_684_800_000 + Math.floor(Math.random() * 1e10);
		const item = await publish(owner.id, { now: base });
		const now = Date.now();
		await addFavorite(env.DB, fan.id, item.lineageId, now - 1000);
		await recordActivity(env.DB, fan.id, item.lineageId, 'installed', now - 1000);
		await runRankingsJob(env.DB, now);

		const fresh = await findIn(
			FEED,
			`sort=new&limit=5&cursor=${encodeCursor([base + 1, ''])}`,
			item.lineageId,
			feedGet
		);
		expectPublicCard(fresh.card, owner);
		expect(fresh.card?.head.id).toBe(item.versionId);
		expect(fresh.card?.curve).toEqual({
			id: item.curve.id,
			s1: item.curve.s1,
			levelDb: -3,
			yolo: false
		});
		expectNoLeak(fresh.texts, owner);
		for (const text of fresh.texts) {
			expect(text).not.toContain(item.curve.canonKey);
			expect(text).not.toContain(item.curve.gateVer);
		}

		const ranked = await findIn(
			FEED,
			'sort=favorites&window=all&limit=100',
			item.lineageId,
			feedGet
		);
		expectPublicCard(ranked.card, owner);
		expectNoLeak(ranked.texts, owner);

		const rankings = await findIn(
			RANKINGS,
			'metric=installs&window=all&limit=100',
			item.lineageId,
			rankingsGet
		);
		expectPublicCard(rankings.card, owner);
		expectNoLeak(rankings.texts, owner);
	});

	it('an author without a nickname is credited as null', async () => {
		const seeded = await seedUser();
		const base = 946_684_800_000 + Math.floor(Math.random() * 1e10);
		const item = await publish(seeded.id, { now: base });
		const fresh = await findIn(
			FEED,
			`sort=new&limit=5&cursor=${encodeCursor([base + 1, ''])}`,
			item.lineageId,
			feedGet
		);
		expect(fresh.card?.author).toBeNull();
		expectNoLeak(fresh.texts, seeded);
	});
});
