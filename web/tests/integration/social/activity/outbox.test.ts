// T4.4: POST /api/v1/me/activity/outbox: batch of offline events with partial acceptance,
// bounded age, replay of the whole batch, size limit and authorization.
import { describe, expect, it } from 'vitest';
import { OUTBOX_MAX_ITEMS } from '#lib/server/social/activity.ts';
import { POST } from '../../../../src/routes/api/v1/me/activity/outbox/+server.ts';
import {
	activityRow,
	count,
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
