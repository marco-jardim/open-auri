import { afterEach, expect, test, vi } from 'vitest';
import {
	createFlashStore,
	createJournalStore,
	createMeterRefStore,
	createOutboxStore,
	createStorage
} from '#lib/state/index.ts';
import { createTabs, MemoryStorage } from './fakes.ts';

const disposables: { dispose(): void }[] = [];

function own<T extends { dispose(): void }>(value: T): T {
	disposables.push(value);
	return value;
}

afterEach(() => {
	for (const disposable of disposables.splice(0).reverse()) disposable.dispose();
	vi.restoreAllMocks();
});

function storage() {
	return own(
		createStorage({
			local: new MemoryStorage(),
			session: new MemoryStorage(),
			indexedDB: null,
			channel: null
		})
	);
}

test('default standalone stores are SSR-safe and own their persistence subscriptions', async () => {
	const flash = own(createFlashStore());
	const journal = own(createJournalStore());
	const meter = own(createMeterRefStore());
	const outbox = own(createOutboxStore());
	await outbox.ready;
	expect(flash.error?.kind).toBe('unavailable');
	expect(journal.error).toBeNull();
	expect(meter.error).toBeNull();
	expect(outbox.loading).toBe(false);
	expect(outbox.error).toBeNull();
	expect(journal.append({})).toBe(false);
	expect(journal.error?.kind).toBe('invalid');
	expect(meter.set(-14)).toBe(true);
	expect(meter.error?.kind).toBe('unavailable');
});

test('meter reference rereads the current backend on clear events and ignores unrelated/session events', () => {
	const tabs = createTabs();
	const backend = own(createStorage(tabs.options(0)));
	const meter = own(createMeterRefStore({ storage: backend }));
	tabs.local.setItem('oa.meter.ref', '-14');
	tabs.emit(0, { area: 'session', key: 'oa.meter.ref', newValue: '-20' });
	tabs.emit(0, { area: 'local', key: 'unrelated', newValue: '-20' });
	expect(meter.value).toBe(-18);
	tabs.emit(0, { area: 'local', key: null, newValue: null });
	expect(meter.value).toBe(-14);
	tabs.local.removeItem('oa.meter.ref');
	tabs.emit(0, { area: 'local', key: 'oa.meter.ref', newValue: '-20' });
	expect(meter.value).toBe(-18);
});

test('flash observation rebases a backwards clock and keeps the conservative two-second wait', () => {
	const backend = storage();
	const flash = own(createFlashStore({ storage: backend, now: () => 1000 }));
	expect(flash.canWriteNow(500)).toEqual({ ok: false, waitMs: 2000 });
	expect(backend.read('local', 'oa.flash.lastWriteAt')).toBe('500');
	expect(flash.canWriteNow(2499)).toEqual({ ok: false, waitMs: 1 });
	expect(flash.canWriteNow(2500)).toEqual({ ok: true, waitMs: 0 });
});

test('outbox validation rejects malformed persisted JSON values but sorts valid equal-time events by ID', async () => {
	const backend = storage();
	const valid = { id: 'z', type: 'event', payload: null, createdAt: 1, updatedAt: 1 };
	vi.spyOn(backend, 'loadRecords').mockResolvedValue([
		{ ...valid, id: 3 },
		{ ...valid, id: '' },
		{ ...valid, type: false },
		{ ...valid, type: '' },
		{ ...valid, payload: NaN },
		{ ...valid, payload: new Date(0) },
		{ ...valid, payload: [undefined] },
		{ ...valid, createdAt: -1 },
		{ ...valid, updatedAt: 0 },
		valid,
		{ ...valid, id: 'a', payload: { nested: [true, 'text', 0, null] } }
	]);
	const outbox = own(createOutboxStore({ storage: backend }));
	expect(outbox.loading).toBe(true);
	await outbox.ready;
	expect(outbox.loading).toBe(false);
	expect(outbox.events.map((event) => event.id)).toEqual(['a', 'z']);
	expect(outbox.error?.kind).toBe('invalid');
});

test('outbox ignores stale refreshes and late completion after disposal', async () => {
	const backend = storage();
	let resolve!: (values: Record<string, unknown>[]) => void;
	const initial = new Promise<Record<string, unknown>[]>((done) => {
		resolve = done;
	});
	vi.spyOn(backend, 'loadRecords').mockReturnValueOnce(initial).mockResolvedValue([]);
	const outbox = own(createOutboxStore({ storage: backend }));
	await outbox.refresh();
	resolve([{ id: 'stale', type: 'event', payload: null, createdAt: 1, updatedAt: 1 }]);
	await outbox.ready;
	expect(outbox.events).toEqual([]);
	outbox.dispose();
	await outbox.refresh();
	expect(outbox.events).toEqual([]);
});

test('outbox append rejects nonfinite/sparse payloads and preserves nested valid JSON by value', async () => {
	const outbox = own(
		createOutboxStore({ storage: storage(), id: () => 'generated', now: () => 5 })
	);
	await outbox.ready;
	expect(await outbox.append({ type: 'bad', payload: Infinity })).toBeNull();
	expect(await outbox.append({ type: 'bad', payload: new Array<number>(2) })).toBeNull();
	const payload = { nested: [true, false, null, 'text', 2] };
	const event = await outbox.append({ type: 'valid', payload });
	payload.nested.push('changed');
	expect(event).toMatchObject({
		id: 'generated',
		createdAt: 5,
		updatedAt: 5,
		payload: { nested: [true, false, null, 'text', 2] }
	});
	expect((await outbox.list())[0]).toEqual(event);
});
