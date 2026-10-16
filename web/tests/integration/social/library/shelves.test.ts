// Library shelves (T4.3): GET /api/v1/me/library through the real route. Own creations in every
// visibility (filterable), favorites and installed curves still readable, keyset pagination,
// query validation and authz. Another user's private lineage never shows up.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { addFavorite, recordActivity, retractLineage } from '#lib/server/social/repo.ts';
import type { LibraryItem } from '#lib/server/social/library.ts';
import { GET } from '../../../../src/routes/api/v1/me/library/+server.ts';
import {
	bodyOf,
	errorCode,
	member,
	publish,
	routeEvent,
	SIGNED_OUT,
	type Member
} from './helpers.ts';

interface ShelfBody {
	shelf: string;
	items: LibraryItem[];
	nextCursor: string | null;
}

function get(who: Member | null, query: string) {
	return GET(
		routeEvent({ path: `/api/v1/me/library${query}`, locals: who ? who.locals : SIGNED_OUT })
	);
}

async function shelf(who: Member, query: string): Promise<ShelfBody> {
	const response = await get(who, query);
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toContain('no-store');
	return bodyOf<ShelfBody>(response);
}

describe('GET /api/v1/me/library', () => {
	it('created: every own visibility and state, newest first, filterable', async () => {
		const me = await member();
		const t = Date.now();
		const priv = await publish(me.user.id, { visibility: 'private', now: t - 3000 });
		const unl = await publish(me.user.id, { visibility: 'unlisted', now: t - 2000 });
		const pub = await publish(me.user.id, { visibility: 'public', now: t - 1000 });
		const ret = await retractLineage(env.DB, pub.lineageId, me.user.id, t);
		expect(ret.ok).toBe(true);

		const all = await shelf(me, '?shelf=created');
		expect(all.shelf).toBe('created');
		expect(all.items.map((item) => item.id)).toEqual([
			pub.lineageId,
			unl.lineageId,
			priv.lineageId
		]);
		expect(all.items.every((item) => item.own)).toBe(true);
		expect(all.items[0]?.status).toBe('retracted');
		expect(all.items[2]?.at).toBe(t - 3000);
		expect(JSON.stringify(all)).not.toContain(me.user.id);

		const onlyPrivate = await shelf(me, '?shelf=created&visibility=private');
		expect(onlyPrivate.items.map((item) => item.id)).toEqual([priv.lineageId]);
	});

	it("another user's private lineage is not on the shelves, even when favorited before", async () => {
		const me = await member();
		const other = await member();
		const secret = await publish(other.user.id, { visibility: 'private' });
		const open = await publish(other.user.id);
		const now = Date.now();
		expect((await addFavorite(env.DB, me.user.id, open.lineageId, now)).ok).toBe(true);
		expect((await addFavorite(env.DB, me.user.id, secret.lineageId, now)).ok).toBe(false);

		const created = await shelf(me, '?shelf=created');
		expect(created.items).toEqual([]);
		const favorites = await shelf(me, '?shelf=favorites');
		expect(favorites.items.map((item) => item.id)).toEqual([open.lineageId]);
		expect(favorites.items[0]?.own).toBe(false);
		expect(favorites.items[0]?.author?.username).toBe(other.user.username);
	});

	it('favorites and installed hold only readable lineages, most recent first', async () => {
		const me = await member();
		const other = await member();
		const a = await publish(other.user.id);
		const b = await publish(other.user.id, { visibility: 'unlisted' });
		const c = await publish(other.user.id);
		const t = Date.now();
		await addFavorite(env.DB, me.user.id, a.lineageId, t - 2000);
		await addFavorite(env.DB, me.user.id, b.lineageId, t - 1000);
		await addFavorite(env.DB, me.user.id, c.lineageId, t);
		await retractLineage(env.DB, c.lineageId, other.user.id, t);
		const favorites = await shelf(me, '?shelf=favorites');
		expect(favorites.items.map((item) => item.id)).toEqual([b.lineageId, a.lineageId]);
		expect(favorites.items.map((item) => item.at)).toEqual([t - 1000, t - 2000]);

		await recordActivity(env.DB, me.user.id, a.lineageId, 'installed', t - 500);
		await recordActivity(env.DB, me.user.id, b.lineageId, 'installed', t - 900);
		await recordActivity(env.DB, me.user.id, b.lineageId, 'previewed', t);
		const installed = await shelf(me, '?shelf=installed');
		expect(installed.items.map((item) => item.id)).toEqual([a.lineageId, b.lineageId]);
	});

	it('paginates with limit and an opaque cursor', async () => {
		const me = await member();
		const t = Date.now();
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const published = await publish(me.user.id, { visibility: 'private', now: t - 5000 + i });
			ids.unshift(published.lineageId);
		}
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const after: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
			const page: ShelfBody = await shelf(me, `?shelf=created&limit=2${after}`);
			expect(page.items.length).toBeLessThanOrEqual(2);
			seen.push(...page.items.map((item) => item.id));
			cursor = page.nextCursor;
			pages++;
		} while (cursor !== null && pages < 10);
		expect(seen).toEqual(ids);
		expect(pages).toBe(3);
	});

	it('400 for a bad shelf, limit, visibility outside created, or cursor', async () => {
		const me = await member();
		for (const query of [
			'',
			'?shelf=packs',
			'?shelf=created&limit=0',
			'?shelf=created&limit=101',
			'?shelf=created&limit=two',
			'?shelf=created&visibility=secret',
			'?shelf=favorites&visibility=private'
		]) {
			const response = await get(me, query);
			expect(response.status, query).toBe(400);
			expect(await errorCode(response)).toBe('INVALID_BODY');
		}
		// 'e30' is base64url of '{}': decodes, but is not a cursor.
		const response = await get(me, '?shelf=created&cursor=e30');
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe('INVALID_CURSOR');
	});

	it('authz: 401 signed out; an unverified account reads its own library', async () => {
		const anonymous = await get(null, '?shelf=created');
		expect(anonymous.status).toBe(401);
		expect(await errorCode(anonymous)).toBe('AUTH_REQUIRED');
		const unverified = await member({ verified: false });
		expect((await get(unverified, '?shelf=favorites')).status).toBe(200);
	});
});
