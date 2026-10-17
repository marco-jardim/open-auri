// Favorites (T4.3): PUT/DELETE /api/v1/curves/[id]/favorite through the real route, idempotency,
// visibility (public, unlisted, own private, someone else's private, retracted), authz and the
// `?s=` share attribution of a `favorited` funnel event.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { favoriteLineage, unfavoriteLineage } from '#lib/server/social/library.ts';
import { createShare, retractLineage } from '#lib/server/social/repo.ts';
import { DELETE, PUT } from '../../../../src/routes/api/v1/curves/[id]/favorite/+server.ts';
import {
	ban,
	bodyOf,
	count,
	errorCode,
	member,
	publish,
	routeEvent,
	sid,
	SIGNED_OUT,
	type Member
} from './helpers.ts';

function put(who: Member | null, id: string, query = '') {
	return PUT(
		routeEvent({
			method: 'PUT',
			path: `/api/v1/curves/${id}/favorite${query}`,
			locals: who ? who.locals : SIGNED_OUT,
			params: { id }
		})
	);
}

function del(who: Member | null, id: string) {
	return DELETE(
		routeEvent({
			method: 'DELETE',
			path: `/api/v1/curves/${id}/favorite`,
			locals: who ? who.locals : SIGNED_OUT,
			params: { id }
		})
	);
}

function favoriteRows(userId: string, lineageId: string): Promise<number> {
	return count(
		'SELECT count(*) AS n FROM favorites WHERE user_id = ? AND lineage_id = ?',
		userId,
		lineageId
	);
}

describe('PUT/DELETE /api/v1/curves/[id]/favorite', () => {
	it('PUT twice keeps one row; DELETE twice is ok', async () => {
		const owner = await member();
		const fan = await member();
		const { lineageId } = await publish(owner.user.id);

		const first = await put(fan, lineageId);
		expect(first.status).toBe(200);
		expect(await bodyOf(first)).toEqual({ favorited: true, created: true });
		const second = await put(fan, lineageId);
		expect(second.status).toBe(200);
		expect(await bodyOf(second)).toEqual({ favorited: true, created: false });
		expect(await favoriteRows(fan.user.id, lineageId)).toBe(1);

		const removed = await del(fan, lineageId);
		expect(removed.status).toBe(200);
		expect(await bodyOf(removed)).toEqual({ favorited: false, removed: true });
		const again = await del(fan, lineageId);
		expect(again.status).toBe(200);
		expect(await bodyOf(again)).toEqual({ favorited: false, removed: false });
		expect(await favoriteRows(fan.user.id, lineageId)).toBe(0);
	});

	it('unlisted is favoritable by id; own private too', async () => {
		const owner = await member();
		const fan = await member();
		const unlisted = await publish(owner.user.id, { visibility: 'unlisted' });
		const mine = await publish(owner.user.id, { visibility: 'private' });
		expect((await put(fan, unlisted.lineageId)).status).toBe(200);
		expect((await put(owner, mine.lineageId)).status).toBe(200);
		expect(await favoriteRows(owner.user.id, mine.lineageId)).toBe(1);
	});

	it("404 for someone else's private, retracted, banned owner's and missing lineages", async () => {
		const owner = await member();
		const fan = await member();
		const secret = await publish(owner.user.id, { visibility: 'private' });
		const gone = await publish(owner.user.id);
		const retracted = await retractLineage(env.DB, gone.lineageId, owner.user.id, Date.now());
		expect(retracted.ok).toBe(true);
		const banned = await member();
		const fromBanned = await publish(banned.user.id);
		await ban(banned.user.id);

		for (const id of [secret.lineageId, gone.lineageId, fromBanned.lineageId, sid('lin')]) {
			const response = await put(fan, id);
			expect(response.status).toBe(404);
			expect(await errorCode(response)).toBe('NOT_FOUND');
			expect(await favoriteRows(fan.user.id, id)).toBe(0);
		}
		const malformed = await put(fan, 'x');
		expect(malformed.status).toBe(404);
		// DELETE never reveals existence.
		expect((await del(fan, secret.lineageId)).status).toBe(200);
	});

	it('PUT of a lineage that stopped being readable is 404 even with an old row', async () => {
		const owner = await member();
		const fan = await member();
		const { lineageId } = await publish(owner.user.id);
		expect((await put(fan, lineageId)).status).toBe(200);
		const retracted = await retractLineage(env.DB, lineageId, owner.user.id, Date.now());
		expect(retracted.ok).toBe(true);
		expect((await put(fan, lineageId)).status).toBe(404);
		// The stale row can still be removed.
		expect(await bodyOf(await del(fan, lineageId))).toEqual({ favorited: false, removed: true });
	});

	it('authz: 401 signed out, 403 unverified', async () => {
		const owner = await member();
		const { lineageId } = await publish(owner.user.id);
		const anonymous = await put(null, lineageId);
		expect(anonymous.status).toBe(401);
		expect(await errorCode(anonymous)).toBe('AUTH_REQUIRED');
		expect((await del(null, lineageId)).status).toBe(401);
		const unverified = await member({ verified: false });
		const response = await put(unverified, lineageId);
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe('EMAIL_NOT_VERIFIED');
	});

	it('403 BAD_ORIGIN without a same-origin header', async () => {
		const owner = await member();
		const fan = await member();
		const { lineageId } = await publish(owner.user.id);
		const response = await PUT(
			routeEvent({
				method: 'PUT',
				path: `/api/v1/curves/${lineageId}/favorite`,
				locals: fan.locals,
				params: { id: lineageId },
				headers: { origin: 'https://evil.example' }
			})
		);
		expect(response.status).toBe(403);
		expect(await favoriteRows(fan.user.id, lineageId)).toBe(0);
	});
});

describe('share attribution (?s=)', () => {
	function attributed(shareId: string): Promise<number> {
		return count(
			"SELECT count(*) AS n FROM share_event_users WHERE share_id = ? AND kind = 'favorited'",
			shareId
		);
	}

	async function publicActivity(userId: string): Promise<void> {
		await env.DB.prepare(`UPDATE "user" SET "activity_visibility" = 'public' WHERE "id" = ?`)
			.bind(userId)
			.run();
	}

	async function shareOf(lineageId: string, ownerUserId: string): Promise<string> {
		const share = await createShare(env.DB, {
			id: sid('shr'),
			lineageId,
			versionId: null,
			ownerUserId,
			channel: null,
			now: Date.now()
		});
		if (!share.ok) throw new Error(share.code);
		return share.value.id;
	}

	it('records one favorited event for a share of the same lineage', async () => {
		const owner = await member();
		const fan = await member();
		await publicActivity(fan.user.id);
		const { lineageId } = await publish(owner.user.id);
		const shareId = await shareOf(lineageId, owner.user.id);
		expect((await put(fan, lineageId, `?s=${shareId}`)).status).toBe(200);
		expect((await put(fan, lineageId, `?s=${shareId}`)).status).toBe(200);
		expect(await attributed(shareId)).toBe(1);
	});

	it('FX4.6: a private-activity fan is never attributed', async () => {
		const owner = await member();
		const fan = await member();
		const { lineageId } = await publish(owner.user.id);
		const shareId = await shareOf(lineageId, owner.user.id);
		const result = await favoriteLineage(env.DB, fan.user.id, lineageId, { shareId });
		expect(result).toEqual({ ok: true, created: true, attributed: false });
		expect(await attributed(shareId)).toBe(0);
	});

	it('FX4.6: unfavorite removes the attributed favorited event of that lineage', async () => {
		const owner = await member();
		const fan = await member();
		const other = await member();
		await publicActivity(fan.user.id);
		await publicActivity(other.user.id);
		const { lineageId } = await publish(owner.user.id);
		const shareId = await shareOf(lineageId, owner.user.id);
		expect(await favoriteLineage(env.DB, fan.user.id, lineageId, { shareId })).toMatchObject({
			attributed: true
		});
		expect(await favoriteLineage(env.DB, other.user.id, lineageId, { shareId })).toMatchObject({
			attributed: true
		});
		expect(await attributed(shareId)).toBe(2);

		expect(await unfavoriteLineage(env.DB, fan.user.id, lineageId)).toEqual({ removed: true });
		expect(await attributed(shareId)).toBe(1);
		expect(
			await count(
				'SELECT count(*) AS n FROM share_event_users WHERE share_id = ? AND user_id = ?',
				shareId,
				fan.user.id
			)
		).toBe(0);
		// Favoriting again through the share attributes again (once).
		expect(await favoriteLineage(env.DB, fan.user.id, lineageId, { shareId })).toMatchObject({
			attributed: true
		});
		expect(await attributed(shareId)).toBe(2);
	});

	it('ignores a share of another lineage, a missing or malformed share', async () => {
		const owner = await member();
		const fan = await member();
		const target = await publish(owner.user.id);
		const other = await publish(owner.user.id);
		const share = await createShare(env.DB, {
			id: sid('shr'),
			lineageId: other.lineageId,
			versionId: null,
			ownerUserId: owner.user.id,
			channel: null,
			now: Date.now()
		});
		if (!share.ok) throw new Error(share.code);
		const result = await favoriteLineage(env.DB, fan.user.id, target.lineageId, {
			shareId: share.value.id
		});
		expect(result).toEqual({ ok: true, created: true, attributed: false });
		expect(await attributed(share.value.id)).toBe(0);
		await unfavoriteLineage(env.DB, fan.user.id, target.lineageId);
		expect(
			await favoriteLineage(env.DB, fan.user.id, target.lineageId, { shareId: sid('shr') })
		).toEqual({ ok: true, created: true, attributed: false });
		expect((await put(fan, target.lineageId, '?s=%3Cbad%3E')).status).toBe(200);
	});

	it('does not attribute an already existing favorite', async () => {
		const owner = await member();
		const fan = await member();
		const { lineageId } = await publish(owner.user.id);
		const share = await createShare(env.DB, {
			id: sid('shr'),
			lineageId,
			versionId: null,
			ownerUserId: owner.user.id,
			channel: null,
			now: Date.now()
		});
		if (!share.ok) throw new Error(share.code);
		expect((await put(fan, lineageId)).status).toBe(200);
		const result = await favoriteLineage(env.DB, fan.user.id, lineageId, {
			shareId: share.value.id
		});
		expect(result).toEqual({ ok: true, created: false, attributed: false });
		expect(await attributed(share.value.id)).toBe(0);
	});
});
