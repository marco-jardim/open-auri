// T4.4: GET /api/v1/curves/[id]/audience (owner only, privacy of the audience) and
// GET|DELETE /api/v1/me/activity (own history, deletion makes public counts drop).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { recordActivity } from '#lib/server/social/repo.ts';
import type { Audience } from '#lib/server/social/types.ts';
import { GET as AUDIENCE } from '../../../../src/routes/api/v1/curves/[id]/audience/+server.ts';
import { DELETE, GET } from '../../../../src/routes/api/v1/me/activity/+server.ts';
import { POST as ACTIVITY } from '../../../../src/routes/api/v1/curves/[id]/activity/+server.ts';
import {
	activityEvent,
	AUDIENCE_ROUTE,
	ban,
	count,
	errorCode,
	installBody,
	ME_ROUTE,
	member,
	previewBody,
	publicCounts,
	publish,
	routeEvent,
	seedUser,
	share,
	signedIn,
	SIGNED_OUT
} from './helpers.ts';

function audience(lineageId: string, auth: AuthLocals) {
	return AUDIENCE(
		routeEvent({
			path: `/api/v1/curves/${lineageId}/audience`,
			routeId: AUDIENCE_ROUTE,
			params: { id: lineageId },
			locals: auth
		})
	);
}

function me(method: 'GET' | 'DELETE', auth: AuthLocals, query = '') {
	const event = routeEvent({
		method,
		path: `/api/v1/me/activity${query}`,
		routeId: ME_ROUTE,
		locals: auth
	});
	return method === 'GET' ? GET(event) : DELETE(event);
}

async function track(lineageId: string, auth: AuthLocals, body: Record<string, unknown>) {
	const response = await ACTIVITY(activityEvent(lineageId, auth, body));
	expect(response.status).toBe(201);
}

describe('audience', () => {
	it('names public profiles only, counts private ones, hides unverified, banned, owner', async () => {
		const owner = await member({ activity: 'public' });
		const open = await member({ activity: 'public' });
		const closed = await member();
		const unverified = await member({ activity: 'public' });
		const banned = await member({ activity: 'public' });
		const { lineageId } = await publish(owner.id);

		await track(lineageId, signedIn(owner), previewBody());
		await track(lineageId, signedIn(open), previewBody());
		await track(lineageId, signedIn(closed), previewBody());
		await track(lineageId, signedIn(closed), installBody());
		const now = Date.now();
		for (const user of [unverified, banned]) {
			expect((await recordActivity(env.DB, user.id, lineageId, 'previewed', now)).ok).toBe(true);
		}
		await env.DB.prepare('UPDATE "user" SET "emailVerified" = 0 WHERE "id" = ?')
			.bind(unverified.id)
			.run();
		await ban(banned.id);

		const response = await audience(lineageId, signedIn(owner));
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('no-store');
		const raw = await response.text();
		const body = JSON.parse(raw) as { audience: Audience };

		expect(body.audience.previewed.total).toBe(2);
		expect(body.audience.previewed.privateCount).toBe(1);
		expect(body.audience.previewed.named.map((n) => n.username)).toEqual([open.username]);
		expect(body.audience.installed).toEqual({ total: 1, privateCount: 1, named: [] });
		expect(body.audience.favorited.total).toBe(0);
		for (const hidden of [closed, unverified, banned, owner]) {
			expect(raw).not.toContain(hidden.username);
			expect(raw).not.toContain(hidden.id);
		}
		expect(raw).not.toContain(open.id);
		expect(raw).not.toContain(open.email);
	});

	it('is for the owner only: others, missing ids and signed-out callers are refused', async () => {
		const owner = await member();
		const other = await member();
		const { lineageId } = await publish(owner.id);
		const foreign = await audience(lineageId, signedIn(other));
		expect(((await errorCode(foreign, 404)) as { code: string }).code).toBe('NOT_FOUND');
		expect((await audience('lin-missing-000000', signedIn(owner))).status).toBe(404);
		expect((await audience('x', signedIn(owner))).status).toBe(404);
		expect((await audience(lineageId, SIGNED_OUT)).status).toBe(401);
	});
});

describe('own activity', () => {
	it('lists only the caller rows, paginated; bad cursor or limit is a 400', async () => {
		const owner = await member();
		const viewer = await member();
		const other = await member();
		const a = await publish(owner.id);
		const b = await publish(owner.id);
		await track(a.lineageId, signedIn(viewer), previewBody());
		await track(b.lineageId, signedIn(viewer), installBody());
		await track(a.lineageId, signedIn(other), installBody());

		const first = await me('GET', signedIn(viewer), '?limit=1');
		expect(first.status).toBe(200);
		const page1 = (await first.json()) as {
			items: { lineageId: string; kind: string }[];
			nextCursor: string | null;
		};
		expect(page1.items).toHaveLength(1);
		expect(page1.nextCursor).not.toBeNull();
		const second = await me('GET', signedIn(viewer), `?limit=1&cursor=${page1.nextCursor ?? ''}`);
		const page2 = (await second.json()) as typeof page1;
		const seen = [...page1.items, ...page2.items].map((item) => `${item.lineageId}:${item.kind}`);
		expect(seen.sort()).toEqual([`${a.lineageId}:previewed`, `${b.lineageId}:installed`].sort());
		expect(page2.nextCursor).toBeNull();

		const badCursor = await me('GET', signedIn(viewer), '?cursor=***');
		expect(((await errorCode(badCursor, 400)) as { code: string }).code).toBe('INVALID_CURSOR');
		expect((await me('GET', signedIn(viewer), '?limit=-3')).status).toBe(400);
		expect((await me('GET', SIGNED_OUT)).status).toBe(401);
	});

	it('unverified users can still see and delete their own history', async () => {
		const unverified = await seedUser({ verified: false });
		const auth = signedIn(unverified, { emailVerified: false });
		expect((await me('GET', auth)).status).toBe(200);
		expect((await me('DELETE', auth)).status).toBe(200);
	});

	it('deletes by kind, by lineage or everything; public counts drop at once', async () => {
		const owner = await member();
		const sharer = await member();
		const viewer = await member();
		const a = await publish(owner.id);
		const b = await publish(owner.id);
		const shareId = await share(a.lineageId, sharer.id);
		const auth = signedIn(viewer);
		await track(a.lineageId, auth, previewBody({ shareId }));
		await track(a.lineageId, auth, installBody({ shareId }));
		await track(b.lineageId, auth, previewBody());
		await track(b.lineageId, auth, installBody());
		expect(await publicCounts(a.lineageId)).toEqual({ favorites: 0, previewed: 1, installed: 1 });

		const byKind = await me('DELETE', auth, `?lineageId=${a.lineageId}&kind=installed`);
		expect(await byKind.json()).toEqual({ deleted: 1 });
		expect(await publicCounts(a.lineageId)).toEqual({ favorites: 0, previewed: 1, installed: 0 });
		expect(
			await count(
				"SELECT count(*) AS n FROM share_event_users WHERE share_id = ? AND user_id = ? AND kind = 'installed'",
				shareId,
				viewer.id
			)
		).toBe(0);

		const byLineage = await me('DELETE', auth, `?lineageId=${a.lineageId}`);
		expect(await byLineage.json()).toEqual({ deleted: 1 });
		expect(await publicCounts(a.lineageId)).toEqual({ favorites: 0, previewed: 0, installed: 0 });
		expect(
			await count(
				'SELECT count(*) AS n FROM share_event_users WHERE share_id = ? AND user_id = ?',
				shareId,
				viewer.id
			)
		).toBe(0);

		const all = await me('DELETE', auth);
		expect(await all.json()).toEqual({ deleted: 2 });
		expect(await publicCounts(b.lineageId)).toEqual({ favorites: 0, previewed: 0, installed: 0 });
		expect(await count('SELECT count(*) AS n FROM activity WHERE user_id = ?', viewer.id)).toBe(0);
	});

	it("deletion never touches other users' rows and validates its filters", async () => {
		const owner = await member();
		const viewer = await member();
		const other = await member();
		const { lineageId } = await publish(owner.id);
		await track(lineageId, signedIn(other), installBody());
		expect(await (await me('DELETE', signedIn(viewer))).json()).toEqual({ deleted: 0 });
		expect(await publicCounts(lineageId)).toEqual({ favorites: 0, previewed: 0, installed: 1 });

		const badKind = await me('DELETE', signedIn(viewer), '?kind=favorited');
		expect(((await errorCode(badKind, 400)) as { code: string }).code).toBe('INVALID_BODY');
		expect((await me('DELETE', signedIn(viewer), '?lineageId=x')).status).toBe(400);
		expect((await me('DELETE', SIGNED_OUT)).status).toBe(401);
	});
});
