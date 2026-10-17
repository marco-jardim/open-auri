// T4.4: POST /api/v1/curves/[id]/activity: authorization, preview length, time window, dedupe,
// eventId replay, owner exclusion and share attribution.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	ACTIVITY_DAILY_QUOTA,
	checkEvent,
	eventClaimSubject,
	FUTURE_SKEW_MS,
	OUTBOX_MAX_AGE_MS,
	recordActivityEvent
} from '#lib/server/social/activity.ts';
import { POST } from '../../../../src/routes/api/v1/curves/[id]/activity/+server.ts';
import {
	activityEvent,
	activityRow,
	ACTIVITY_ROUTE,
	ban,
	claimRows,
	count,
	errorCode,
	installBody,
	member,
	previewBody,
	publicActivity,
	publicCounts,
	publish,
	routeEvent,
	seedUser,
	share,
	signedIn,
	SIGNED_OUT,
	spendDailyQuota
} from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
/** The secret the routes use (env.secrets.betterAuthSecret). */
const SECRET = String(env.BETTER_AUTH_SECRET);

describe('activity intake: authorization', () => {
	it('signed out → 401, unverified → 403, banned → 403', async () => {
		const owner = await member();
		const { lineageId } = await publish(owner.id);

		const anon = await POST(activityEvent(lineageId, SIGNED_OUT, previewBody()));
		expect(((await errorCode(anon, 401)) as { code: string }).code).toBe('AUTH_REQUIRED');

		const unverified = await seedUser({ verified: false });
		const notVerified = await POST(
			activityEvent(lineageId, signedIn(unverified, { emailVerified: false }), previewBody())
		);
		expect(((await errorCode(notVerified, 403)) as { code: string }).code).toBe(
			'EMAIL_NOT_VERIFIED'
		);
		expect(await count('SELECT count(*) AS n FROM activity WHERE user_id = ?', unverified.id)).toBe(
			0
		);

		const banned = await seedUser({ banned: true });
		const refused = await POST(
			activityEvent(lineageId, signedIn(banned, { banned: true }), previewBody())
		);
		expect(((await errorCode(refused, 403)) as { code: string }).code).toBe('BANNED');
	});

	it('refuses a foreign or missing Origin', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const response = await POST(
			routeEvent({
				method: 'POST',
				path: `/api/v1/curves/${lineageId}/activity`,
				routeId: ACTIVITY_ROUTE,
				params: { id: lineageId },
				locals: signedIn(viewer),
				body: previewBody(),
				origin: 'https://evil.example'
			})
		);
		expect(((await errorCode(response, 403)) as { code: string }).code).toBe('BAD_ORIGIN');
	});

	it("someone else's private lineage and a missing one both answer 404", async () => {
		const owner = await member();
		const viewer = await member();
		const priv = await publish(owner.id, { visibility: 'private' });

		const hidden = await POST(activityEvent(priv.lineageId, signedIn(viewer), previewBody()));
		expect(((await errorCode(hidden, 404)) as { code: string }).code).toBe('NOT_FOUND');
		const missing = await POST(
			activityEvent('lin-missing-000000', signedIn(viewer), installBody())
		);
		expect(((await errorCode(missing, 404)) as { code: string }).code).toBe('NOT_FOUND');
		const bad = await POST(activityEvent('x', signedIn(viewer), installBody()));
		expect(bad.status).toBe(404);
		expect(await activityRow(viewer.id, priv.lineageId, 'previewed')).toBeNull();
	});

	it('unlisted lineages (by link) and the owner own private lineage are accepted', async () => {
		const owner = await member();
		const viewer = await member();
		const unlisted = await publish(owner.id, { visibility: 'unlisted' });
		const priv = await publish(owner.id, { visibility: 'private' });

		const byLink = await POST(activityEvent(unlisted.lineageId, signedIn(viewer), installBody()));
		expect(byLink.status).toBe(201);
		const own = await POST(activityEvent(priv.lineageId, signedIn(owner), installBody()));
		expect(own.status).toBe(201);
	});

	it('a banned lineage owner makes the lineage unreadable for others (404)', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		await ban(owner.id);
		const response = await POST(activityEvent(lineageId, signedIn(viewer), installBody()));
		expect(response.status).toBe(404);
	});
});

describe('activity intake: body rules', () => {
	it('previewed needs durationMs >= 10 000 (missing or shorter is refused)', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const auth = signedIn(viewer);

		const short = await POST(activityEvent(lineageId, auth, previewBody({ durationMs: 9_999 })));
		const shortError = (await errorCode(short, 400)) as {
			code: string;
			details: { issues: { path: string[]; code: string }[] };
		};
		expect(shortError.code).toBe('INVALID_BODY');
		expect(shortError.details.issues[0]).toEqual({
			path: ['durationMs'],
			code: 'preview_too_short'
		});

		const none = await POST(
			activityEvent(lineageId, auth, { kind: 'previewed', eventId: crypto.randomUUID() })
		);
		expect(none.status).toBe(400);
		expect(await activityRow(viewer.id, lineageId, 'previewed')).toBeNull();

		const exact = await POST(activityEvent(lineageId, auth, previewBody({ durationMs: 10_000 })));
		expect(exact.status).toBe(201);
	});

	it('refuses schema failures: unknown kind, non-UUID eventId, non-integer at', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const auth = signedIn(viewer);
		for (const body of [
			installBody({ kind: 'favorited' }),
			installBody({ eventId: 'not-a-uuid' }),
			installBody({ at: 1.5 }),
			installBody({ durationMs: -1 })
		]) {
			const response = await POST(activityEvent(lineageId, auth, body));
			expect(((await errorCode(response, 400)) as { code: string }).code).toBe('INVALID_BODY');
		}
	});

	it('time window: at <= now + 60 s and >= now - 7 days; default is now', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const auth = signedIn(viewer);

		const inFuture = installBody({ at: Date.now() + 5 * 60_000 });
		const future = await POST(activityEvent(lineageId, auth, inFuture));
		const futureError = (await errorCode(future, 400)) as {
			details: { issues: { path: string[]; code: string }[] };
		};
		expect(futureError.details.issues[0]).toEqual({ path: ['at'], code: 'at_out_of_window' });

		const tooOld = installBody({ at: Date.now() - 8 * DAY });
		const old = await POST(activityEvent(lineageId, auth, tooOld));
		expect(old.status).toBe(400);
		expect(await activityRow(viewer.id, lineageId, 'installed')).toBeNull();

		const sixDaysAgo = Date.now() - 6 * DAY;
		const ok = await POST(activityEvent(lineageId, auth, installBody({ at: sixDaysAgo })));
		expect(ok.status).toBe(201);
		const body = (await ok.json()) as { status: string; activity: { firstAt: number } };
		expect(body.status).toBe('recorded');
		expect(body.activity.firstAt).toBe(sixDaysAgo);

		const before = Date.now();
		await POST(activityEvent(lineageId, auth, installBody()));
		const row = await activityRow(viewer.id, lineageId, 'installed');
		expect(row?.first_at).toBe(sixDaysAgo);
		expect(row?.last_at).toBeGreaterThanOrEqual(before);
	});

	it('checkEvent boundaries', () => {
		const now = 1_800_000_000_000;
		const base = { kind: 'installed' as const, eventId: crypto.randomUUID() };
		expect(checkEvent({ ...base, at: now + FUTURE_SKEW_MS }, now)).toEqual({
			ok: true,
			at: now + FUTURE_SKEW_MS
		});
		expect(checkEvent({ ...base, at: now + FUTURE_SKEW_MS + 1 }, now)).toEqual({
			ok: false,
			reason: 'out-of-window'
		});
		expect(checkEvent({ ...base, at: now - OUTBOX_MAX_AGE_MS }, now).ok).toBe(true);
		expect(checkEvent({ ...base, at: now - OUTBOX_MAX_AGE_MS - 1 }, now).ok).toBe(false);
		expect(checkEvent(base, now)).toEqual({ ok: true, at: now });
		expect(checkEvent({ ...base, kind: 'previewed', durationMs: 9_999 }, now)).toEqual({
			ok: false,
			reason: 'too-short'
		});
		expect(checkEvent({ ...base, eventId: 'nope' }, now)).toEqual({ ok: false, reason: 'invalid' });
	});
});

describe('activity intake: dedupe, replay, owner', () => {
	it('repeated events keep one row (count grows) and one distinct user in public counts', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const auth = signedIn(viewer);

		for (let i = 0; i < 3; i += 1) {
			expect((await POST(activityEvent(lineageId, auth, previewBody()))).status).toBe(201);
		}
		expect((await activityRow(viewer.id, lineageId, 'previewed'))?.count).toBe(3);
		expect(await publicCounts(lineageId)).toEqual({ favorites: 0, previewed: 1, installed: 0 });

		const other = await member();
		await POST(activityEvent(lineageId, signedIn(other), installBody()));
		expect(await publicCounts(lineageId)).toEqual({ favorites: 0, previewed: 1, installed: 1 });
	});

	it('a replayed eventId answers duplicate and records nothing', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const auth = signedIn(viewer);
		const body = previewBody();

		expect((await POST(activityEvent(lineageId, auth, body))).status).toBe(201);
		const again = await POST(activityEvent(lineageId, auth, body));
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual({ status: 'duplicate' });
		const upper = await POST(
			activityEvent(lineageId, auth, { ...body, eventId: String(body.eventId).toUpperCase() })
		);
		expect(await upper.json()).toEqual({ status: 'duplicate' });
		expect((await activityRow(viewer.id, lineageId, 'previewed'))?.count).toBe(1);
	});

	it('event ids are per user: the same id from another user is not a duplicate', async () => {
		const owner = await member();
		const a = await member();
		const b = await member();
		const { lineageId } = await publish(owner.id);
		const body = installBody();
		expect((await POST(activityEvent(lineageId, signedIn(a), body))).status).toBe(201);
		expect((await POST(activityEvent(lineageId, signedIn(b), body))).status).toBe(201);
	});

	it("the owner's own events are recorded but never counted", async () => {
		const owner = await member();
		const { lineageId } = await publish(owner.id);
		expect((await POST(activityEvent(lineageId, signedIn(owner), previewBody()))).status).toBe(201);
		expect((await POST(activityEvent(lineageId, signedIn(owner), installBody()))).status).toBe(201);
		expect(await activityRow(owner.id, lineageId, 'installed')).not.toBeNull();
		expect(await publicCounts(lineageId)).toEqual({ favorites: 0, previewed: 0, installed: 0 });
	});
});

describe('activity intake: share attribution', () => {
	const attributed = (shareId: string, userId: string) =>
		count(
			'SELECT count(*) AS n FROM share_event_users WHERE share_id = ? AND user_id = ?',
			shareId,
			userId
		);

	it('records the attributed event once per kind for a share of the same lineage', async () => {
		const owner = await member();
		const sharer = await member();
		const viewer = await member();
		await publicActivity(viewer.id);
		const { lineageId } = await publish(owner.id);
		const shareId = await share(lineageId, sharer.id);
		const auth = signedIn(viewer);

		await POST(activityEvent(lineageId, auth, previewBody({ shareId })));
		await POST(activityEvent(lineageId, auth, previewBody({ shareId })));
		await POST(activityEvent(lineageId, auth, installBody({ shareId })));
		expect(await attributed(shareId, viewer.id)).toBe(2);
	});

	it('ignores a share of another lineage, an unknown share and the sharer own events', async () => {
		const owner = await member();
		const sharer = await member();
		const viewer = await member();
		await publicActivity(viewer.id);
		const first = await publish(owner.id);
		const second = await publish(owner.id);
		const otherShare = await share(second.lineageId, sharer.id);
		const ownShare = await share(first.lineageId, viewer.id);

		const response = await POST(
			activityEvent(first.lineageId, signedIn(viewer), previewBody({ shareId: otherShare }))
		);
		expect(response.status).toBe(201);
		await POST(
			activityEvent(first.lineageId, signedIn(viewer), installBody({ shareId: ownShare }))
		);
		await POST(
			activityEvent(first.lineageId, signedIn(viewer), installBody({ shareId: 'shr-unknown-000' }))
		);
		expect(await attributed(otherShare, viewer.id)).toBe(0);
		expect(await attributed(ownShare, viewer.id)).toBe(0);
	});

	it('service: shareAttributed reports whether the funnel moved', async () => {
		const owner = await member();
		const sharer = await member();
		const viewer = await member();
		await publicActivity(viewer.id);
		const { lineageId } = await publish(owner.id);
		const shareId = await share(lineageId, sharer.id);
		const first = await recordActivityEvent(
			env.DB,
			viewer.id,
			lineageId,
			{ kind: 'installed', eventId: crypto.randomUUID(), shareId },
			{ claimSecret: SECRET }
		);
		expect(first).toMatchObject({ status: 'recorded', shareAttributed: true });
		const second = await recordActivityEvent(
			env.DB,
			viewer.id,
			lineageId,
			{ kind: 'installed', eventId: crypto.randomUUID(), shareId },
			{ claimSecret: SECRET }
		);
		expect(second).toMatchObject({ status: 'recorded', shareAttributed: false });
	});

	it('FX4.6: a private-activity actor is never attributed (the share cannot reveal them)', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const shareId = await share(lineageId, owner.id);
		const auth = signedIn(viewer);

		expect((await POST(activityEvent(lineageId, auth, previewBody({ shareId })))).status).toBe(201);
		expect((await POST(activityEvent(lineageId, auth, installBody({ shareId })))).status).toBe(201);
		expect(await attributed(shareId, viewer.id)).toBe(0);
		// The activity itself is recorded and counted publicly as one distinct user.
		expect(await publicCounts(lineageId)).toEqual({ favorites: 0, previewed: 1, installed: 1 });

		await publicActivity(viewer.id);
		const later = await recordActivityEvent(
			env.DB,
			viewer.id,
			lineageId,
			{ kind: 'installed', eventId: crypto.randomUUID(), shareId },
			{ claimSecret: SECRET }
		);
		expect(later).toMatchObject({ status: 'recorded', shareAttributed: true });
	});
});

describe('activity intake: event-id claims (FX4.6)', () => {
	it('claim keys hold a keyed hash of the user id, never the id itself', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		const body = installBody();
		expect((await POST(activityEvent(lineageId, signedIn(viewer), body))).status).toBe(201);

		const eventId = String(body.eventId).toLowerCase();
		const subject = await eventClaimSubject(SECRET, viewer.id);
		expect(subject).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await claimRows(`id:act.ev:${eventId}:${subject}:`)).toBe(1);
		expect(await claimRows(`act.ev:${eventId}:${viewer.id}`)).toBe(0);
		expect(await claimRows(`act.ev:${eventId}`)).toBe(1);
		expect(await eventClaimSubject(SECRET, viewer.id)).toBe(subject);
		expect(await eventClaimSubject(SECRET, owner.id)).not.toBe(subject);
		await expect(eventClaimSubject('short', viewer.id)).rejects.toThrow(RangeError);
	});
});

describe('activity intake: daily quota shared with the outbox (FX4.6)', () => {
	it('a spent daily quota answers 429 on the single-event route', async () => {
		const owner = await member();
		const viewer = await member();
		const { lineageId } = await publish(owner.id);
		await spendDailyQuota(viewer.id, ACTIVITY_DAILY_QUOTA);
		const response = await POST(activityEvent(lineageId, signedIn(viewer), installBody()));
		expect(((await errorCode(response, 429)) as { code: string }).code).toBe('RATE_LIMITED');
		expect(await activityRow(viewer.id, lineageId, 'installed')).toBeNull();
	});
});
