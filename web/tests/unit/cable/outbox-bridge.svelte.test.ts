import { describe, expect, test, vi } from 'vitest';
import { encodeS1 } from 'open-auri/share';
import { CABLE_WRITTEN_EVENT, NEUTRAL_CURVE } from '#lib/cable/service.ts';
import { isRealWrite, startOutboxBridge } from '#lib/cable/outbox-bridge.ts';
import { rememberOrigin, type CurveOrigin, type OriginsStorage } from '#lib/social/origins.ts';
import {
	createSocialOutbox,
	type EnqueueInput,
	type EnqueueResult,
	type OutboxStore
} from '#lib/social/outbox.ts';
import type { PendingEvent } from '#lib/state/outbox.svelte.ts';

function memoryStorage(): OriginsStorage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value)
	};
}

const bands = NEUTRAL_CURVE.bands.map((band) => ({ ...band }));
const preampDb = NEUTRAL_CURVE.preampDb;

function detail(status: string) {
	return {
		entry: { schema: 1, at: 1, name: 'Neutro', crc: 0x4fff, preampDb, bands, status, device: 'X' },
		crc: 0x4fff,
		preampDb,
		bands,
		deviceLabel: 'X',
		at: 1,
		levelDb: null
	};
}

interface MutableSession {
	signedIn: boolean;
	verified: boolean;
	accountId: string | null;
}

const signedInAna = (): MutableSession => ({ signedIn: true, verified: true, accountId: 'ana' });

async function setup(mode = 'real', session: MutableSession = signedInAna()) {
	const storage = memoryStorage();
	await rememberOrigin(
		{ s1: encodeS1({ bands, preampDb }), lineageId: 'lin_1', versionId: 'ver_1' },
		{ storage }
	);
	const events = new EventTarget();
	const enqueue = vi.fn(
		async (input: EnqueueInput): Promise<EnqueueResult> =>
			({ ok: true, item: input }) as unknown as EnqueueResult
	);
	const queued = vi.fn();
	const app = { cable: { events }, cableState: { mode } };
	const stop = startOutboxBridge({
		app,
		outbox: { enqueue },
		session,
		origins: { storage },
		onqueued: queued
	});
	const fire = (value: unknown, name = CABLE_WRITTEN_EVENT) =>
		events.dispatchEvent(new CustomEvent(name, { detail: value }));
	return { enqueue, queued, stop, fire, app, session };
}

function memoryStore() {
	const records = new Map<string, PendingEvent>();
	const store: OutboxStore = {
		list: () => Promise.resolve([...records.values()]),
		append(input) {
			const event: PendingEvent = {
				id: input.id ?? crypto.randomUUID(),
				type: input.type,
				payload: input.payload,
				createdAt: input.updatedAt ?? 0,
				updatedAt: input.updatedAt ?? 0
			};
			records.set(event.id, event);
			return Promise.resolve(event);
		},
		remove(id) {
			records.delete(id);
			return Promise.resolve();
		}
	};
	return { records, store };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('outbox bridge', () => {
	test('a real ok write of a community curve enqueues exactly one installed event', async () => {
		const { enqueue, queued, fire } = await setup();
		fire(detail('ok'));
		await vi.waitFor(() => expect(queued).toHaveBeenCalledOnce());
		expect(enqueue).toHaveBeenCalledOnce();
		expect(enqueue).toHaveBeenCalledWith(
			{ kind: 'installed', lineageId: 'lin_1' },
			{ actedAs: 'ana' }
		);
	});

	test('a real ok Modo YOLO write (marked yolo) counts as one installed event too', async () => {
		const { enqueue, queued, fire } = await setup();
		const base = detail('ok');
		fire({
			...base,
			entry: { ...base.entry, profile: 'yolo', waived: ['g:preamp'] },
			profile: 'yolo',
			waived: ['g:preamp']
		});
		await vi.waitFor(() => expect(queued).toHaveBeenCalledOnce());
		expect(enqueue).toHaveBeenCalledWith(
			{ kind: 'installed', lineageId: 'lin_1' },
			{ actedAs: 'ana' }
		);
	});

	test('anonymous or unverified writes never enqueue', async () => {
		const anonymous = await setup('real', { signedIn: false, verified: false, accountId: null });
		const unverified = await setup('real', { signedIn: true, verified: false, accountId: 'bia' });
		anonymous.fire(detail('ok'));
		unverified.fire(detail('ok'));
		await settle();
		expect(anonymous.enqueue).not.toHaveBeenCalled();
		expect(unverified.enqueue).not.toHaveBeenCalled();
		expect(anonymous.queued).not.toHaveBeenCalled();
	});

	test('with the real outbox: an account switch before the enqueue drops the event', async () => {
		const session = signedInAna();
		const { records, store } = memoryStore();
		const outbox = createSocialOutbox({ store, session, locks: null });
		let resolveLookup: (origin: CurveOrigin | null) => void = () => undefined;
		const lookup = vi.fn(
			() =>
				new Promise<CurveOrigin | null>((resolve) => {
					resolveLookup = resolve;
				})
		);
		const events = new EventTarget();
		const results: EnqueueResult[] = [];
		const logs: Record<string, string>[] = [];
		startOutboxBridge({
			app: { cable: { events }, cableState: { mode: 'real' } },
			outbox,
			session,
			lookup,
			onqueued: (result) => results.push(result),
			log: (_event, data) => logs.push(data)
		});
		events.dispatchEvent(new CustomEvent(CABLE_WRITTEN_EVENT, { detail: detail('ok') }));
		await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
		// Ana wrote; Bia signs in before the origin lookup answers.
		session.accountId = 'bia';
		resolveLookup({ lineageId: 'lin_1', versionId: 'ver_1', at: 1 });
		await vi.waitFor(() => expect(results).toHaveLength(1));
		expect(results[0]).toEqual({ ok: false, reason: 'signed-out' });
		expect(logs).toEqual([{ status: 'not-queued', reason: 'signed-out' }]);
		expect(records.size).toBe(0);
	});

	test('with the real outbox: the event is stamped with the writer', async () => {
		const session = signedInAna();
		const { records, store } = memoryStore();
		const outbox = createSocialOutbox({ store, session, locks: null });
		const events = new EventTarget();
		const results: EnqueueResult[] = [];
		startOutboxBridge({
			app: { cable: { events } },
			outbox,
			session,
			lookup: async () => ({ lineageId: 'lin_1', versionId: 'ver_1', at: 1 }),
			onqueued: (result) => results.push(result)
		});
		events.dispatchEvent(new CustomEvent(CABLE_WRITTEN_EVENT, { detail: detail('ok') }));
		await vi.waitFor(() => expect(results).toHaveLength(1));
		expect(results[0]?.ok && results[0].event.owner).toBe('ana');
		expect(records.size).toBe(1);
	});

	test('simulated writes never enqueue (detail status or simulated mode)', async () => {
		const first = await setup();
		first.fire(detail('simulated'));
		const second = await setup('simulated');
		second.fire(detail('ok'));
		await settle();
		expect(first.enqueue).not.toHaveBeenCalled();
		expect(second.enqueue).not.toHaveBeenCalled();
	});

	test('failed or interrupted attempts and other events never enqueue', async () => {
		const { enqueue, fire } = await setup();
		fire(detail('interrupted'));
		fire(detail('ok'), 'cable:status');
		fire({ entry: null, bands, preampDb });
		fire(null);
		await settle();
		expect(enqueue).not.toHaveBeenCalled();
	});

	test('a curve without a remembered origin is not attributed', async () => {
		const { enqueue, fire } = await setup();
		const other = bands.map((band, index) =>
			index === 0 ? { kind: 'PK' as const, freqHz: 1000, gainDb: -3, qFactor: 1 } : band
		);
		fire({ ...detail('ok'), bands: other, entry: { ...detail('ok').entry, bands: other } });
		await settle();
		expect(enqueue).not.toHaveBeenCalled();
	});

	test('after stop nothing is enqueued', async () => {
		const { enqueue, fire, stop } = await setup();
		stop();
		fire(detail('ok'));
		await settle();
		expect(enqueue).not.toHaveBeenCalled();
	});

	test('isRealWrite accepts only ok journal entries', () => {
		expect(isRealWrite(detail('ok'))).toBe(true);
		for (const status of ['simulated', 'interrupted', 'error']) {
			expect(isRealWrite(detail(status))).toBe(false);
		}
		expect(isRealWrite(undefined)).toBe(false);
	});
});
