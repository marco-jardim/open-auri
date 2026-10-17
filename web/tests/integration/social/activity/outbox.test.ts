// T4.4: POST /api/v1/me/activity/outbox: batch of offline events with partial acceptance,
// bounded age, replay of the whole batch, size limit and authorization.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	ACTIVITY_DAILY_QUOTA,
	eventClaimSubject,
	OUTBOX_MAX_ITEMS,
	recordOutbox
} from '#lib/server/social/activity.ts';
import { POST } from '../../../../src/routes/api/v1/me/activity/outbox/+server.ts';
import { DELETE as DELETE_ACTIVITY } from '../../../../src/routes/api/v1/me/activity/+server.ts';
import {
	activityRow,
	claimRows,
	count,
	ME_ROUTE,
	spendDailyQuota,
	errorCode,
	installBody,
	member,
	OUTBOX_ROUTE,
	previewBody,
	publicCounts,
	publish,
	routeEvent,
	seedUser,
	signedIn,
	SIGNED_OUT,
	type SeededUser
} from './helpers.ts';
import type { AuthLocals } from '#lib/server/auth/guards.ts';

const DAY = 24 * 60 * 60 * 1000;

interface OutboxResponse {
	results: { index: number; eventId: string | null; status: string; reason?: string }[];
}

function outbox(auth: AuthLocals, events: unknown) {
	return POST(
		routeEvent({
			method: 'POST',
			path: '/api/v1/me/activity/outbox',
			routeId: OUTBOX_ROUTE,
			locals: auth,
			body: { events }
		})
	);
}

async function results(user: SeededUser, events: unknown[]): Promise<OutboxResponse['results']> {
	const response = await outbox(signedIn(user), events);
	expect(response.status).toBe(200);
	return ((await response.json()) as OutboxResponse).results;
}

describe('activity outbox', () => {
	it('accepts each item on its own and rejects the bad ones with a reason', async () => {
		const owner = await member();
		const stranger = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const hidden = await publish(stranger.id, { visibility: 'private' });

		const fiveDaysAgo = Date.now() - 5 * DAY;
		const first = previewBody({ lineageId, at: fiveDaysAgo });
		const items = [
			first,
			installBody({ lineageId, at: Date.now() - 8 * DAY }),
			previewBody({ lineageId, durationMs: 3_000 }),
			{ kind: 'installed', lineageId },
			installBody({ lineageId: hidden.lineageId }),
			installBody({ lineageId, at: Date.now() - DAY }),
			'garbage'
		];
		const out = await results(viewer, items);

		expect(out.map((r) => [r.index, r.status, r.reason ?? null])).toEqual([
			[0, 'recorded', null],
			[1, 'rejected', 'out-of-window'],
			[2, 'rejected', 'too-short'],
			[3, 'rejected', 'invalid'],
			[4, 'rejected', 'not-found'],
			[5, 'recorded', null],
			[6, 'rejected', 'invalid']
		]);
		expect(out[0]?.eventId).toBe(first.eventId);
		expect(out[3]?.eventId).toBeNull();

		expect((await activityRow(viewer.id, lineageId, 'previewed'))?.first_at).toBe(fiveDaysAgo);
		expect((await activityRow(viewer.id, lineageId, 'installed'))?.count).toBe(1);
		expect(await activityRow(viewer.id, hidden.lineageId, 'installed')).toBeNull();
		expect(await publicCounts(lineageId)).toEqual({ favorites: 0, previewed: 1, installed: 1 });
	});

	it('replaying the same batch records nothing new (all duplicates)', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const items = [
			previewBody({ lineageId, at: Date.now() - 2 * DAY }),
			previewBody({ lineageId, at: Date.now() - DAY }),
			installBody({ lineageId })
		];
		expect((await results(viewer, items)).map((r) => r.status)).toEqual([
			'recorded',
			'recorded',
			'recorded'
		]);
		expect((await results(viewer, items)).map((r) => r.status)).toEqual([
			'duplicate',
			'duplicate',
			'duplicate'
		]);
		expect((await activityRow(viewer.id, lineageId, 'previewed'))?.count).toBe(2);
		expect((await activityRow(viewer.id, lineageId, 'installed'))?.count).toBe(1);
	});

	it('a repeated eventId inside one batch is a duplicate', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const item = installBody({ lineageId });
		expect((await results(viewer, [item, item])).map((r) => r.status)).toEqual([
			'recorded',
			'duplicate'
		]);
	});

	it(`refuses an empty batch and more than ${OUTBOX_MAX_ITEMS} items as a whole`, async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const tooMany = Array.from({ length: OUTBOX_MAX_ITEMS + 1 }, () => installBody({ lineageId }));
		const big = await outbox(signedIn(viewer), tooMany);
		expect(((await errorCode(big, 400)) as { code: string }).code).toBe('INVALID_BODY');
		const empty = await outbox(signedIn(viewer), []);
		expect(empty.status).toBe(400);
		expect(await count('SELECT count(*) AS n FROM activity WHERE user_id = ?', viewer.id)).toBe(0);
	});

	it('requires a signed-in, verified user', async () => {
		const owner = await member();
		const { lineageId } = await publish(owner.id);
		const anon = await outbox(SIGNED_OUT, [installBody({ lineageId })]);
		expect(anon.status).toBe(401);
		const unverified = await seedUser({ verified: false });
		const refused = await outbox(signedIn(unverified, { emailVerified: false }), [
			installBody({ lineageId })
		]);
		expect(((await errorCode(refused, 403)) as { code: string }).code).toBe('EMAIL_NOT_VERIFIED');
	});
});

describe('activity outbox: daily quota per item and claims (FX4.6)', () => {
	const SECRET = String(env.BETTER_AUTH_SECRET);

	it('items count against the daily quota of single events; past it they answer limited', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		await spendDailyQuota(viewer.id, ACTIVITY_DAILY_QUOTA - 2);

		const items = [
			installBody({ lineageId }),
			{ eventId: 'not-a-uuid' },
			previewBody({ lineageId }),
			installBody({ lineageId, at: Date.now() - 8 * DAY }),
			previewBody({ lineageId }),
			installBody({ lineageId })
		];
		const answer = await results(viewer, items);
		expect(answer.map((entry) => entry.status)).toEqual([
			'recorded',
			'rejected',
			'recorded',
			'rejected',
			'limited',
			'limited'
		]);
		expect(answer[4]?.reason).toBeUndefined();
		expect((await activityRow(viewer.id, lineageId, 'previewed'))?.count).toBe(1);

		// A limited item claimed nothing: once the quota is back it is recorded, not a duplicate.
		await spendDailyQuota(viewer.id, 0);
		const retry = await results(viewer, [items[4]]);
		expect(retry.map((entry) => entry.status)).toEqual(['recorded']);
	});

	it('the service needs the claim secret only once an item reaches the claim', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const rejectedOnly = await recordOutbox(env.DB, viewer.id, [{ eventId: 'x' }]);
		expect(rejectedOnly.map((entry) => entry.status)).toEqual(['rejected']);
		await expect(recordOutbox(env.DB, viewer.id, [installBody({ lineageId })])).rejects.toThrow(
			/claimSecret/
		);
		const recorded = await recordOutbox(env.DB, viewer.id, [installBody({ lineageId })], {
			claimSecret: SECRET
		});
		expect(recorded.map((entry) => entry.status)).toEqual(['recorded']);
	});

	it('"delete my activity" without a filter also deletes the event-id claims', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const event = installBody({ lineageId });
		expect((await results(viewer, [event])).map((entry) => entry.status)).toEqual(['recorded']);
		const subject = await eventClaimSubject(SECRET, viewer.id);
		expect(await claimRows(`:${subject}:`)).toBe(1);

		const remove = (query: string) =>
			DELETE_ACTIVITY(
				routeEvent({
					method: 'DELETE',
					path: `/api/v1/me/activity${query}`,
					routeId: ME_ROUTE,
					locals: signedIn(viewer)
				})
			);
		// A claim in the format before FX4.6 (raw user id) and another user's claim.
		const legacyKey = `u:act.ev:${crypto.randomUUID()}:${viewer.id}:691200`;
		const ownerSubject = await eventClaimSubject(SECRET, owner.id);
		const othersKey = `id:act.ev:${crypto.randomUUID()}:${ownerSubject}:691200`;
		for (const key of [legacyKey, othersKey]) {
			await env.DB.prepare(
				'INSERT INTO rate_limit_counters (key, window_start, count, expires_at) VALUES (?, 0, 1, ?)'
			)
				.bind(key, Math.floor(Date.now() / 1000) + 86_400)
				.run();
		}

		expect((await remove(`?lineageId=${lineageId}`)).status).toBe(200);
		expect(await claimRows(`:${subject}:`)).toBe(1);
		expect((await remove('')).status).toBe(200);
		expect(await claimRows(`:${subject}:`)).toBe(0);
		expect(await claimRows(legacyKey)).toBe(0);
		expect(await claimRows(othersKey)).toBe(1);
		expect(await count('SELECT count(*) AS n FROM activity WHERE user_id = ?', viewer.id)).toBe(0);
	});
});
