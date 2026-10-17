import { describe, expect, it, vi } from 'vitest';
import type { JsonValue, PendingEvent } from '#lib/state/outbox.svelte.ts';
import {
	BACKOFF_BASE_MS,
	OUTBOX_ACTOR_MISMATCH,
	OUTBOX_BATCH_MAX,
	OUTBOX_MAX_AGE_MS,
	isActorMismatch,
	SOCIAL_OUTBOX_LOCK,
	SOCIAL_OUTBOX_TYPE,
	SocialApiError,
	createSocialOutbox,
	type OutboxItemInput,
	type OutboxLockManager,
	type OutboxResult,
	type OutboxStore,
	type SocialOutboxOptions
} from '#lib/social/index.ts';

const T0 = 1_760_000_000_000;

/** In-memory stand-in for `createOutboxStore` (same newer-`updatedAt`-wins rule). */
function memoryStore() {
	const records = new Map<string, PendingEvent>();
	const store: OutboxStore = {
		list: () => Promise.resolve([...records.values()].map((event) => structuredClone(event))),
		append(input: { id?: string; type: string; payload: JsonValue; updatedAt?: number }) {
			const at = input.updatedAt ?? T0;
			const id = input.id ?? crypto.randomUUID();
			const previous = records.get(id);
			if (previous && previous.updatedAt >= at) return Promise.resolve(previous);
			const event: PendingEvent = {
				id,
				type: input.type,
				payload: structuredClone(input.payload),
				createdAt: previous?.createdAt ?? at,
				updatedAt: at
			};
			records.set(id, event);
			return Promise.resolve(event);
		},
		remove(id: string) {
			records.delete(id);
			return Promise.resolve();
		}
	};
	return { records, store };
}

function sequentialIds() {
	let next = 0;
	return () => {
		next += 1;
		return `00000000-0000-4000-8000-${next.toString(16).padStart(12, '0')}`;
	};
}

type Responder = (events: OutboxItemInput[]) => Promise<{ results: OutboxResult[] }>;

const recordAll: Responder = (events) =>
	Promise.resolve({
		results: events.map((event, index) => ({
			index,
			eventId: event.eventId,
			status: 'recorded' as const
		}))
	});

function fakeApi(respond: Responder = recordAll) {
	const batches: OutboxItemInput[][] = [];
	const api = {
		postActivityOutbox: vi.fn((events: OutboxItemInput[]) => {
			batches.push(events);
			return respond(events);
		})
	};
	return { api, batches };
}

function setup(overrides: Partial<SocialOutboxOptions> = {}) {
	const memory = memoryStore();
	let clock = T0;
	const session: { signedIn: boolean; verified: boolean; accountId: string | null } = {
		signedIn: true,
		verified: true,
		accountId: 'user-a'
	};
	const logs: string[][] = [];
	const options: SocialOutboxOptions = {
		store: memory.store,
		session,
		locks: null,
		now: () => clock,
		online: () => true,
		randomId: sequentialIds(),
		random: () => 1,
		log: (message, detail) => logs.push([message, detail]),
		...overrides
	};
	return {
		...memory,
		session,
		logs,
		options,
		outbox: createSocialOutbox(options),
		advance(ms: number) {
			clock += ms;
		},
		get now() {
			return clock;
		}
	};
}

describe('enqueue', () => {
	it('refuses previews shorter than 10 s without storing anything', async () => {
		const { outbox, records } = setup();
		const result = await outbox.enqueue({ kind: 'previewed', lineageId: 'L1', durationMs: 9_999 });
		expect(result).toEqual({ ok: false, reason: 'too-short' });
		expect(records.size).toBe(0);
	});

	it('stores previewed and installed events with an eventId and at', async () => {
		const { outbox, records } = setup();
		const preview = await outbox.enqueue({
			kind: 'previewed',
			lineageId: 'L1',
			durationMs: 12_345.7,
			shareId: 'S1'
		});
		const install = await outbox.enqueue({ kind: 'installed', lineageId: 'L2' });
		expect(preview).toEqual({
			ok: true,
			event: {
				eventId: '00000000-0000-4000-8000-000000000001',
				owner: 'user-a',
				lineageId: 'L1',
				kind: 'previewed',
				at: T0,
				durationMs: 12_345,
				shareId: 'S1',
				attempts: 0,
				nextAttemptAt: T0
			}
		});
		expect(install.ok && install.event.durationMs).toBeUndefined();
		const stored = [...records.values()];
		expect(stored.map((event) => [event.id, event.type])).toEqual([
			['00000000-0000-4000-8000-000000000001', SOCIAL_OUTBOX_TYPE],
			['00000000-0000-4000-8000-000000000002', SOCIAL_OUTBOX_TYPE]
		]);
	});

	it('uses crypto.randomUUID by default', async () => {
		const { options } = setup();
		const { store, session } = options;
		const outbox = createSocialOutbox({ store, session, locks: null });
		const result = await outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		expect(result.ok && result.event.eventId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
	});

	it('never throws and logs without PII when storage fails', async () => {
		const { options, logs } = setup();
		const store: OutboxStore = {
			...options.store,
			append: () => Promise.reject(new DOMException('quota', 'QuotaExceededError'))
		};
		const outbox = createSocialOutbox({ ...options, store });
		const result = await outbox.enqueue({ kind: 'installed', lineageId: 'secret-lineage' });
		expect(result).toEqual({ ok: false, reason: 'storage' });
		expect(logs).toEqual([['social outbox: enqueue failed', 'QuotaExceededError']]);
		expect(JSON.stringify(logs)).not.toContain('secret-lineage');
	});

	it('refuses anonymous and unverified actors without storing anything', async () => {
		const anonymous = setup({ session: { signedIn: false, verified: false, accountId: null } });
		const unverified = setup({ session: { signedIn: true, verified: false, accountId: 'u' } });
		const noId = setup({ session: { signedIn: true, verified: true, accountId: null } });
		const preview = { kind: 'previewed', lineageId: 'L1', durationMs: 20_000 } as const;
		expect(await anonymous.outbox.enqueue(preview)).toEqual({ ok: false, reason: 'signed-out' });
		expect(await anonymous.outbox.enqueue({ kind: 'installed', lineageId: 'L1' })).toEqual({
			ok: false,
			reason: 'signed-out'
		});
		expect(await unverified.outbox.enqueue(preview)).toEqual({ ok: false, reason: 'unverified' });
		expect(await noId.outbox.enqueue(preview)).toEqual({ ok: false, reason: 'signed-out' });
		expect(anonymous.records.size + unverified.records.size + noId.records.size).toBe(0);
	});

	it('reads the session at the moment of the action and stamps that account', async () => {
		const context = setup();
		context.session.signedIn = false;
		context.session.accountId = null;
		expect((await context.outbox.enqueue({ kind: 'installed', lineageId: 'L1' })).ok).toBe(false);
		context.session.signedIn = true;
		context.session.accountId = 'user-b';
		const result = await context.outbox.enqueue({ kind: 'installed', lineageId: 'L2' });
		expect(result.ok && result.event.owner).toBe('user-b');
		const [stored] = [...context.records.values()];
		expect(stored?.payload).toMatchObject({ v: 2, owner: 'user-b', lineageId: 'L2' });
	});

	it('refuses an event whose actor is no longer the signed-in account (actedAs)', async () => {
		const context = setup();
		const input = { kind: 'installed', lineageId: 'L1' } as const;
		expect(await context.outbox.enqueue(input, { actedAs: 'user-b' })).toEqual({
			ok: false,
			reason: 'signed-out'
		});
		expect(await context.outbox.enqueue(input, { actedAs: null })).toEqual({
			ok: false,
			reason: 'signed-out'
		});
		expect(context.records.size).toBe(0);
		expect((await context.outbox.enqueue(input, { actedAs: 'user-a' })).ok).toBe(true);
	});

	it('rejects invalid ids', async () => {
		const { outbox } = setup();
		expect(await outbox.enqueue({ kind: 'installed', lineageId: '' })).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(
			await outbox.enqueue({ kind: 'installed', lineageId: 'L1', shareId: 'x'.repeat(200) })
		).toEqual({ ok: false, reason: 'invalid' });
	});
});

describe('persistence', () => {
	it('survives a new outbox over the same store (reload)', async () => {
		const first = setup();
		await first.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		const reloaded = createSocialOutbox({ ...first.options, randomId: sequentialIds() });
		expect((await reloaded.pending()).map((item) => item.lineageId)).toEqual(['L1']);
	});

	it('ignores other outbox types and drops unreadable social items', async () => {
		const { outbox, store, records, batches, api } = { ...setup(), ...fakeApi() };
		await store.append({ id: 'other', type: 'something.else', payload: { x: 1 } });
		await store.append({ id: 'broken', type: SOCIAL_OUTBOX_TYPE, payload: { v: 2 } });
		const report = await outbox.flush(api);
		expect(report).toMatchObject({ status: 'done', dropped: 1, sent: 0 });
		expect(batches).toHaveLength(0);
		expect([...records.keys()]).toEqual(['other']);
	});
});

describe('flush', () => {
	it('drops events older than 7 days without sending them', async () => {
		const context = setup();
		const { api } = fakeApi();
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		context.advance(OUTBOX_MAX_AGE_MS + 1);
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'L2' });
		const report = await context.outbox.flush(api);
		expect(report).toMatchObject({ status: 'done', dropped: 1, sent: 1, removed: 1, kept: 0 });
		expect(api.postActivityOutbox).toHaveBeenCalledTimes(1);
		expect(context.records.size).toBe(0);
	});

	it('sends oldest first in batches of at most 50', async () => {
		const context = setup();
		const { api, batches } = fakeApi();
		for (let index = 0; index < 120; index += 1) {
			context.advance(1);
			await context.outbox.enqueue({ kind: 'installed', lineageId: `L${index}` });
		}
		const report = await context.outbox.flush(api);
		expect(batches.map((batch) => batch.length)).toEqual([OUTBOX_BATCH_MAX, OUTBOX_BATCH_MAX, 20]);
		expect(batches[0]?.[0]).toEqual({
			lineageId: 'L0',
			kind: 'installed',
			eventId: '00000000-0000-4000-8000-000000000001',
			at: T0 + 1
		});
		expect(report).toMatchObject({ status: 'done', sent: 120, removed: 120, kept: 0 });
		expect(context.records.size).toBe(0);
	});

	it('removes recorded, duplicate and rejected items and backs off the unanswered ones', async () => {
		const context = setup();
		const statuses = ['recorded', 'duplicate', 'rejected'] as const;
		const { api } = fakeApi((events) =>
			Promise.resolve({
				results: statuses.map((status, index) => ({
					index,
					eventId: events[index]?.eventId ?? null,
					status,
					...(status === 'rejected' ? { reason: 'not-found' as const } : {})
				}))
			})
		);
		for (const lineageId of ['L1', 'L2', 'L3', 'L4']) {
			await context.outbox.enqueue({ kind: 'previewed', lineageId, durationMs: 10_000 });
		}
		const report = await context.outbox.flush(api);
		expect(report).toMatchObject({ status: 'done', sent: 4, removed: 3, kept: 1 });
		const left = await context.outbox.pending();
		expect(left.map((item) => [item.lineageId, item.attempts, item.nextAttemptAt])).toEqual([
			['L4', 1, context.now + BACKOFF_BASE_MS]
		]);
	});

	it('ignores a result whose eventId does not match its index', async () => {
		const context = setup();
		const otherId = '00000000-0000-4000-8000-0000000000ff';
		const { api } = fakeApi(() =>
			Promise.resolve({ results: [{ index: 0, eventId: otherId, status: 'recorded' as const }] })
		);
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		const report = await context.outbox.flush(api);
		expect(report).toMatchObject({ removed: 0, kept: 1 });
	});

	it('treats a replayed event answered duplicate as delivered', async () => {
		const context = setup();
		const { api } = fakeApi((events) =>
			Promise.resolve({
				results: events.map((event, index) => ({
					index,
					eventId: event.eventId,
					status: 'duplicate' as const
				}))
			})
		);
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		expect(await context.outbox.flush(api)).toMatchObject({ removed: 1, kept: 0 });
		expect(context.records.size).toBe(0);
	});

	it('retries with exponential backoff after a network failure', async () => {
		const context = setup();
		let fail = true;
		const { api } = fakeApi((events) =>
			fail ? Promise.reject(new SocialApiError(0, 'NETWORK')) : recordAll(events)
		);
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });

		expect(await context.outbox.flush(api)).toMatchObject({
			status: 'error',
			error: 'NETWORK',
			kept: 1
		});
		let [item] = await context.outbox.pending();
		expect([item?.attempts, item?.nextAttemptAt]).toEqual([1, context.now + BACKOFF_BASE_MS]);

		// Not due yet: nothing is sent.
		expect(await context.outbox.flush(api)).toMatchObject({ status: 'done', sent: 0, kept: 1 });
		expect(api.postActivityOutbox).toHaveBeenCalledTimes(1);

		context.advance(BACKOFF_BASE_MS);
		await context.outbox.flush(api);
		[item] = await context.outbox.pending();
		expect([item?.attempts, item?.nextAttemptAt]).toEqual([2, context.now + 2 * BACKOFF_BASE_MS]);

		fail = false;
		context.advance(2 * BACKOFF_BASE_MS);
		expect(await context.outbox.flush(api)).toMatchObject({ status: 'done', removed: 1 });
		expect(await context.outbox.pending()).toEqual([]);
	});

	it('applies jitter and honours retry-after', async () => {
		const context = setup({ random: () => 0 });
		const { api } = fakeApi(() =>
			Promise.reject(new SocialApiError(429, 'RATE_LIMITED', undefined, { retryAfterMs: 120_000 }))
		);
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		await context.outbox.flush(api);
		const [item] = await context.outbox.pending();
		expect(item?.nextAttemptAt).toBe(context.now + 120_000);

		const jitter = setup({ random: () => 0 });
		const failing = fakeApi(() => Promise.reject(new SocialApiError(500, 'INTERNAL')));
		await jitter.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		await jitter.outbox.flush(failing.api);
		const [late] = await jitter.outbox.pending();
		expect(late?.nextAttemptAt).toBe(jitter.now + BACKOFF_BASE_MS / 2);
	});

	it('keeps items without counting an attempt when the session is refused', async () => {
		const context = setup();
		const { api } = fakeApi(() => Promise.reject(new SocialApiError(401, 'AUTH_REQUIRED')));
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		expect(await context.outbox.flush(api)).toMatchObject({
			status: 'error',
			error: 'AUTH_REQUIRED',
			kept: 1
		});
		const [item] = await context.outbox.pending();
		expect(item?.attempts).toBe(0);
	});

	it('does nothing when signed out, unverified or offline', async () => {
		const signedOut = setup();
		const unverified = setup();
		const offline = setup({ online: () => false });
		const { api } = fakeApi();
		for (const context of [signedOut, unverified, offline]) {
			await context.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		}
		signedOut.session.signedIn = false;
		signedOut.session.accountId = null;
		unverified.session.verified = false;
		expect((await signedOut.outbox.flush(api)).status).toBe('signed-out');
		expect((await unverified.outbox.flush(api)).status).toBe('unverified');
		expect((await offline.outbox.flush(api)).status).toBe('offline');
		expect(api.postActivityOutbox).not.toHaveBeenCalled();
		expect(offline.records.size).toBe(1);
	});

	it('shares one running flush inside a tab', async () => {
		const context = setup();
		const { api } = fakeApi();
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		const first = context.outbox.flush(api);
		const second = context.outbox.flush(api);
		expect(second).toBe(first);
		await first;
		expect(api.postActivityOutbox).toHaveBeenCalledTimes(1);
	});

	it('stops at an abort and keeps the items', async () => {
		const context = setup();
		const { api } = fakeApi(() => Promise.reject(new DOMException('aborted', 'AbortError')));
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		const controller = new AbortController();
		const report = await context.outbox.flush(api, { signal: controller.signal });
		expect(report).toMatchObject({ status: 'aborted', kept: 1 });
		const [item] = await context.outbox.pending();
		expect(item?.attempts).toBe(0);
	});
});

describe('account ownership', () => {
	it("never sends A's queued events as B and leaves them for purge", async () => {
		const context = setup();
		const { api, batches } = fakeApi();
		await context.outbox.enqueue({ kind: 'previewed', lineageId: 'LA', durationMs: 15_000 });
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'LA' });
		// A signs out without flushing; B signs in on the same browser within 7 days.
		context.session.accountId = 'user-b';
		context.advance(60_000);
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'LB' });
		expect((await context.outbox.pending()).map((item) => item.lineageId)).toEqual(['LB']);
		const report = await context.outbox.flush(api);
		expect(report).toMatchObject({ status: 'done', sent: 1, removed: 1, dropped: 0, kept: 2 });
		expect(batches.flat().map((event) => event.lineageId)).toEqual(['LB']);
		// The flush removes nothing it did not send (#25): clearing A's events is purge's job.
		expect(context.records.size).toBe(2);
		expect(await context.outbox.purge('user-b')).toBe(2);
		expect(context.records.size).toBe(0);
	});

	it("a stale tab never deletes another account's events before the server refuses it", async () => {
		const context = setup();
		const mismatch = new SocialApiError(409, 'CONFLICT', { reason: OUTBOX_ACTOR_MISMATCH });
		const { api, batches } = fakeApi(() => Promise.reject(mismatch));
		// Another tab switched the cookie to B, and B queued an event offline.
		context.session.accountId = 'user-b';
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'LB' });
		// This tab still holds A in memory and has A's own event queued.
		context.session.accountId = 'user-a';
		context.advance(1);
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'LA' });
		const report = await context.outbox.flush(api);
		expect(report).toMatchObject({
			status: 'actor-mismatch',
			sent: 0,
			removed: 0,
			dropped: 0,
			kept: 2
		});
		expect(batches.flat().map((event) => event.lineageId)).toEqual(['LA']);
		expect(context.records.size).toBe(2);
		// Once the tab re-reads the session, B's offline event is still there for B to send.
		context.session.accountId = 'user-b';
		expect((await context.outbox.pending()).map((item) => item.lineageId)).toEqual(['LB']);
	});

	it("keeps A's events for A until A signs in again", async () => {
		const context = setup();
		const { api, batches } = fakeApi();
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'LA' });
		context.session.signedIn = false;
		context.session.accountId = null;
		expect((await context.outbox.flush(api)).status).toBe('signed-out');
		expect(await context.outbox.pending()).toEqual([]);
		expect(context.records.size).toBe(1);
		context.session.signedIn = true;
		context.session.accountId = 'user-a';
		expect(await context.outbox.flush(api)).toMatchObject({ status: 'done', removed: 1 });
		expect(batches.flat().map((event) => event.lineageId)).toEqual(['LA']);
	});

	it('stops a running flush when the session changes between batches', async () => {
		const context = setup();
		const { api, batches } = fakeApi(async (events) => {
			context.session.accountId = 'user-b';
			return recordAll(events);
		});
		for (let index = 0; index < OUTBOX_BATCH_MAX + 5; index += 1) {
			context.advance(1);
			await context.outbox.enqueue({ kind: 'installed', lineageId: `L${index}` });
		}
		const report = await context.outbox.flush(api);
		expect(report).toMatchObject({ status: 'signed-out', sent: OUTBOX_BATCH_MAX, kept: 5 });
		expect(batches).toHaveLength(1);
	});

	it('binds every batch to its owner with `actor` (FX4.10)', async () => {
		const context = setup();
		const { api } = fakeApi();
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		await context.outbox.flush(api);
		expect(api.postActivityOutbox).toHaveBeenCalledWith(expect.any(Array), { actor: 'user-a' });
		const controller = new AbortController();
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'L2' });
		await context.outbox.flush(api, { signal: controller.signal });
		expect(api.postActivityOutbox).toHaveBeenLastCalledWith(expect.any(Array), {
			actor: 'user-a',
			signal: controller.signal
		});
	});

	it("keeps the owner's items without backoff when the server answers actor-mismatch", async () => {
		const context = setup();
		const mismatch = new SocialApiError(409, 'CONFLICT', { reason: OUTBOX_ACTOR_MISMATCH });
		const { api } = fakeApi(() => Promise.reject(mismatch));
		expect(isActorMismatch(mismatch)).toBe(true);
		expect(isActorMismatch(new SocialApiError(409, 'CONFLICT'))).toBe(false);
		expect(isActorMismatch(new SocialApiError(409, 'CONFLICT', { reason: 'other' }))).toBe(false);
		for (let index = 0; index < OUTBOX_BATCH_MAX + 5; index += 1) {
			context.advance(1);
			await context.outbox.enqueue({ kind: 'installed', lineageId: `L${index}` });
		}
		const report = await context.outbox.flush(api);
		expect(report).toMatchObject({
			status: 'actor-mismatch',
			sent: 0,
			removed: 0,
			kept: OUTBOX_BATCH_MAX + 5
		});
		// One request only; nothing removed or postponed: the items wait for their owner.
		expect(api.postActivityOutbox).toHaveBeenCalledTimes(1);
		const pending = await context.outbox.pending();
		expect(pending).toHaveLength(OUTBOX_BATCH_MAX + 5);
		expect(pending.every((item) => item.attempts === 0 && item.owner === 'user-a')).toBe(true);
	});

	it('drops stored items without an owner (v1, before FX4.2) instead of sending them', async () => {
		const context = setup();
		const { api, batches } = fakeApi();
		const legacy = '00000000-0000-4000-8000-0000000000aa';
		await context.store.append({
			id: legacy,
			type: SOCIAL_OUTBOX_TYPE,
			payload: {
				v: 1,
				eventId: legacy,
				lineageId: 'L1',
				kind: 'installed',
				at: T0,
				attempts: 0,
				nextAttemptAt: T0
			}
		});
		expect(await context.outbox.flush(api)).toMatchObject({ status: 'done', dropped: 1, sent: 0 });
		expect(batches).toHaveLength(0);
		expect(context.records.size).toBe(0);
	});

	it('purges everything on sign-out and other accounts on a switch', async () => {
		const context = setup();
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'LA' });
		context.session.accountId = 'user-b';
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'LB' });
		await context.store.append({ id: 'other', type: 'something.else', payload: { x: 1 } });

		// Switch to B: A's events go, B's stay.
		expect(await context.outbox.purge()).toBe(1);
		expect((await context.outbox.pending()).map((item) => item.lineageId)).toEqual(['LB']);

		// Explicit keep, then sign-out: nothing social stays queued.
		await context.outbox.purge('user-b');
		expect(context.records.size).toBe(2);
		context.session.signedIn = false;
		context.session.accountId = null;
		expect(await context.outbox.purge()).toBe(1);
		expect([...context.records.keys()]).toEqual(['other']);
	});

	it('logs a purge failure without throwing', async () => {
		const context = setup();
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		const store: OutboxStore = {
			...context.store,
			remove: () => Promise.reject(new DOMException('gone', 'InvalidStateError'))
		};
		const outbox = createSocialOutbox({ ...context.options, store });
		expect(await outbox.purge(null)).toBe(0);
		expect(context.logs).toEqual([['social outbox: purge failed', 'InvalidStateError']]);
	});
});

describe('cross-tab lock', () => {
	function fakeLocks() {
		const held = new Set<string>();
		const requests: { name: string; options: { ifAvailable: true } }[] = [];
		const locks: OutboxLockManager = {
			async request<T>(
				name: string,
				options: { ifAvailable: true },
				callback: (lock: object | null) => Promise<T>
			): Promise<T> {
				requests.push({ name, options });
				if (held.has(name)) return callback(null);
				held.add(name);
				try {
					return await callback({ name });
				} finally {
					held.delete(name);
				}
			}
		};
		return { locks, requests };
	}

	it('lets a single tab flush; the other answers busy', async () => {
		const { locks, requests } = fakeLocks();
		const tabA = setup({ locks });
		const tabB = createSocialOutbox({ ...tabA.options, locks });
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { api } = fakeApi(async (events) => {
			await gate;
			return recordAll(events);
		});
		await tabA.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });

		const flushing = tabA.outbox.flush(api);
		await vi.waitFor(() => expect(api.postActivityOutbox).toHaveBeenCalledTimes(1));
		expect(await tabB.flush(api)).toMatchObject({ status: 'busy', sent: 0 });
		release();
		expect(await flushing).toMatchObject({ status: 'done', removed: 1 });
		expect(api.postActivityOutbox).toHaveBeenCalledTimes(1);
		expect(requests).toEqual([
			{ name: SOCIAL_OUTBOX_LOCK, options: { ifAvailable: true } },
			{ name: SOCIAL_OUTBOX_LOCK, options: { ifAvailable: true } }
		]);
	});

	it('reports a lock failure instead of throwing', async () => {
		const locks: OutboxLockManager = {
			request: () => Promise.reject(new TypeError('locks broken'))
		};
		const context = setup({ locks });
		const { api } = fakeApi();
		await context.outbox.enqueue({ kind: 'installed', lineageId: 'L1' });
		expect(await context.outbox.flush(api)).toMatchObject({ status: 'error', error: 'TypeError' });
		expect(context.logs).toEqual([['social outbox: flush failed', 'TypeError']]);
	});
});
