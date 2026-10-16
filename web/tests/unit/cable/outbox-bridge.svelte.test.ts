import { describe, expect, test, vi } from 'vitest';
import { encodeS1 } from 'open-auri/share';
import { CABLE_WRITTEN_EVENT, NEUTRAL_CURVE } from '#lib/cable/service.ts';
import { isRealWrite, startOutboxBridge } from '#lib/cable/outbox-bridge.ts';
import { rememberOrigin, type OriginsStorage } from '#lib/social/origins.ts';
import type { EnqueueInput, EnqueueResult } from '#lib/social/outbox.ts';

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

async function setup(mode = 'real') {
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
		origins: { storage },
		onqueued: queued
	});
	const fire = (value: unknown, name = CABLE_WRITTEN_EVENT) =>
		events.dispatchEvent(new CustomEvent(name, { detail: value }));
	return { enqueue, queued, stop, fire, app };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('outbox bridge', () => {
	test('a real ok write of a community curve enqueues exactly one installed event', async () => {
		const { enqueue, queued, fire } = await setup();
		fire(detail('ok'));
		await vi.waitFor(() => expect(queued).toHaveBeenCalledOnce());
		expect(enqueue).toHaveBeenCalledOnce();
		expect(enqueue).toHaveBeenCalledWith({ kind: 'installed', lineageId: 'lin_1' });
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
