/**
 * FX2.1: cross-tab write exclusion (Web Locks + persisted in-flight marker), flash attempts
 * recorded before I/O, stale-marker recovery, journal-derived last written level, counters.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FakeHIDDevice, WRITE_SPACING_MS } from 'open-auri/transport';
import { NEUTRAL_BANDS } from 'open-auri/dsp';
import { levelDb } from 'open-auri/safety';
import { localDateKey } from 'open-auri/policy';
import {
	CABLE_WRITE_LOCK,
	INFLIGHT_STALE_MS,
	cableAliveLock,
	createCableService,
	parseInflightMarker
} from '../../../src/lib/cable/service.ts';
import { lastWrittenLevelDbOf, writtenLevelDb } from '../../../src/lib/cable/checklist.ts';
import type {
	CableService,
	Clock,
	InflightMarker,
	JournalEntry,
	WriteLock,
	WriteRequest
} from '../../../src/lib/cable/index.ts';
import {
	CONFIRMED,
	T0,
	TRUSTED_CLICK,
	memoryFlash,
	memoryJournal,
	padrao,
	setup,
	type SetupOptions
} from './harness.ts';
import {
	killHolder,
	memoryInflight,
	memoryLocks,
	type MemoryInflight,
	type MemoryLocks
} from './locks-fake.ts';

type Harness = Awaited<ReturnType<typeof setup>>;

const disposables: { dispose(): void }[] = [];

afterEach(() => {
	for (const disposable of disposables.splice(0)) disposable.dispose();
	vi.restoreAllMocks();
});

async function tab(options: SetupOptions = {}): Promise<Harness> {
	const h = await setup(options);
	disposables.push(h.service);
	return h;
}

function own(service: CableService): CableService {
	disposables.push(service);
	return service;
}

function request(service: CableService, overrides: Partial<WriteRequest> = {}): WriteRequest {
	return {
		bands: padrao.eqBands,
		preampDb: padrao.preampDb,
		experimental: false,
		confirmations: CONFIRMED,
		gesture: service.createGesture(TRUSTED_CLICK),
		name: 'Padrão',
		...overrides
	};
}

function marker(overrides: Partial<InflightMarker> = {}): InflightMarker {
	return {
		at: T0 - 60_000,
		crc: 0x1970,
		name: 'Padrão',
		preampDb: padrao.preampDb,
		bands: padrao.eqBands.map((band) => ({ ...band })),
		device: 'USB DSP Audio',
		tabId: 'closed-tab',
		...overrides
	};
}

function interruptedEntry(from: InflightMarker): JournalEntry {
	return {
		schema: 1,
		at: from.at,
		name: from.name,
		crc: from.crc,
		preampDb: from.preampDb,
		bands: from.bands,
		status: 'interrupted',
		device: from.device
	};
}

function stored(value: string | null): InflightMarker | null {
	return value === null ? null : parseInflightMarker(value);
}

/** Nothing reached any cable and nothing was recorded. */
function expectUntouched(h: Harness) {
	expect(h.device.attempts).toBe(0);
	expect(h.device.sent).toEqual([]);
	expect(h.journal.entries).toEqual([]);
	expect(h.flash.records).toEqual([]);
	expect(h.written).toEqual([]);
}

describe('cross-tab write lock', () => {
	test('another tab holding the lock: refused busy before any marker, flash or byte', async () => {
		const locks = memoryLocks(new Set([CABLE_WRITE_LOCK]));
		const h = await tab({ locks });
		const gesture = h.service.createGesture(TRUSTED_CLICK);
		const outcome = await h.service.write(request(h.service, { gesture }));
		expect(outcome).toMatchObject({ status: 'refused', reason: 'busy' });
		expectUntouched(h);
		expect(h.inflight.writes).toEqual([]);
		expect(locks.requests).toEqual([{ name: CABLE_WRITE_LOCK, granted: false }]);
		expect(h.service.getState().writing).toBe(false);
		// The gesture was spent by the refused attempt: it cannot be replayed once the lock frees.
		locks.held.clear();
		expect(await h.service.write(request(h.service, { gesture }))).toMatchObject({
			status: 'refused',
			reason: 'gesture'
		});
		expectUntouched(h);
	});

	test('the queue is refused the same way', async () => {
		const locks = memoryLocks(new Set([CABLE_WRITE_LOCK]));
		const h = await tab({ locks });
		const outcome = await h.service.writeQueue({ ...request(h.service), devices: [h.device] });
		expect(outcome).toMatchObject({ status: 'refused', reason: 'busy' });
		expectUntouched(h);
		expect(h.service.getState()).toMatchObject({ writing: false, queue: null });
	});

	test('two tabs: B is refused while A writes, and writes normally after A settles', async () => {
		const held = new Set<string>();
		const inflight = memoryInflight();
		const a = await tab({ locks: memoryLocks(held), inflight, tabId: 'tab-a' });
		const b = await tab({ locks: memoryLocks(held), inflight, tabId: 'tab-b' });
		const first = a.service.write(request(a.service));
		// A holds the lock and its marker is persisted before its first byte.
		expect(held.has(CABLE_WRITE_LOCK)).toBe(true);
		expect(stored(inflight.value)).toMatchObject({ tabId: 'tab-a', crc: 0x1970 });
		const second = await b.service.write(request(b.service));
		expect(second).toMatchObject({ status: 'refused', reason: 'busy' });
		expectUntouched(b);
		expect(stored(inflight.value)?.tabId).toBe('tab-a');
		expect((await first).status).toBe('ok');
		// The write lock is free; A keeps only its liveness lock (until it is disposed or dies).
		expect([...held]).toEqual([cableAliveLock('tab-a')]);
		expect(inflight.value).toBeNull();
		expect((await b.service.write(request(b.service))).status).toBe('ok');
		expect(b.device.sent).toHaveLength(10);
		expect(inflight.value).toBeNull();
	});

	test('the checklist is evaluated again inside the lock with fresh flash state', async () => {
		const h = await tab();
		// Another tab finished a write while this one waited for the lock.
		const sync = vi.fn((at: number) => h.flash.record(at - 500));
		Object.assign(h.flash, { sync });
		const outcome = await h.service.write(request(h.service));
		expect(sync).toHaveBeenCalledOnce();
		expect(outcome).toMatchObject({ status: 'refused', reason: 'checklist' });
		if (outcome.status === 'refused') {
			expect(outcome.checklist?.spacing).toEqual({ ok: false, waitMs: 1500 });
		}
		expect(h.device.attempts).toBe(0);
		expect(h.inflight.writes).toEqual([]);
		expect(h.flash.records).toEqual([T0 - 500]);
	});

	test('a failing lock manager refuses without writing and releases the write state', async () => {
		const locks = memoryLocks();
		locks.request = () => Promise.reject(new Error('Web Locks unavailable'));
		const h = await tab({ locks });
		const outcome = await h.service.write(request(h.service));
		expect(outcome).toMatchObject({ status: 'refused', reason: 'error' });
		expectUntouched(h);
		expect(h.service.getState().writing).toBe(false);
		expect(h.service.abort()).toBe(false);
	});

	test('without Web Locks, a fresh marker from another tab refuses busy and is left alone', async () => {
		const live = JSON.stringify(marker({ at: T0 - 1000, tabId: 'live-tab' }));
		const inflight = memoryInflight(live);
		const h = await tab({ locks: null, inflight });
		expect(h.service.getState().rescue).toBeNull();
		expect(await h.service.write(request(h.service))).toMatchObject({
			status: 'refused',
			reason: 'busy'
		});
		expectUntouched(h);
		expect(inflight.value).toBe(live);
		expect(inflight.writes).toEqual([]);
	});

	test('without Web Locks, an abandoned marker is journaled interrupted; that attempt is refused', async () => {
		const h = await tab({ locks: null });
		const abandoned = marker({ at: T0 - INFLIGHT_STALE_MS - 1 });
		h.inflight.value = JSON.stringify(abandoned);
		expect(await h.service.write(request(h.service))).toMatchObject({
			status: 'refused',
			reason: 'interrupted-elsewhere'
		});
		expect(h.device.attempts).toBe(0);
		expect(h.journal.entries).toMatchObject([interruptedEntry(abandoned)]);
		expect(h.service.getState().rescue).toEqual({
			at: abandoned.at,
			deviceLabel: 'USB DSP Audio',
			reportsSent: null,
			fresh: true
		});
		expect(h.inflight.value).toBeNull();
		expect((await h.service.write(request(h.service))).status).toBe('ok');
		expect(h.service.getState().rescue).toBeNull();
	});

	test('holding the lock, any marker from another tab is from a closed tab: recovered, refused', async () => {
		const h = await tab();
		const closed = marker({ at: T0 - 100 });
		h.inflight.value = JSON.stringify(closed);
		expect(await h.service.write(request(h.service))).toMatchObject({
			status: 'refused',
			reason: 'interrupted-elsewhere'
		});
		expect(h.device.attempts).toBe(0);
		expect(h.flash.records).toEqual([]);
		expect(h.journal.entries).toMatchObject([interruptedEntry(closed)]);
		expect(h.service.getState().rescue?.at).toBe(closed.at);
		expect(h.inflight.value).toBeNull();
		// The checklist now carries the unknown-state warning, then the next confirmed write proceeds.
		const checklist = h.service.checklist(request(h.service));
		expect(checklist.loudness.reasons).toContain('unknown-state');
		expect((await h.service.write(request(h.service))).status).toBe('ok');
	});
});

describe('in-flight marker', () => {
	test('persisted before the first byte with the gated snapshot, removed after settle', async () => {
		const h = await tab({ tabId: 'this-tab' });
		const send = h.device.sendReport.bind(h.device);
		const seen: (string | null)[] = [];
		vi.spyOn(h.device, 'sendReport').mockImplementation((reportId, data) => {
			seen.push(h.inflight.value);
			return send(reportId, data);
		});
		expect((await h.service.write(request(h.service))).status).toBe('ok');
		expect(seen).toHaveLength(10);
		expect(new Set(seen).size).toBe(1);
		expect(stored(seen[0] ?? null)).toEqual({
			at: T0,
			crc: 0x1970,
			name: 'Padrão',
			preampDb: padrao.preampDb,
			bands: padrao.eqBands,
			device: 'USB DSP Audio',
			tabId: 'this-tab'
		});
		expect(h.inflight.value).toBeNull();
		expect(h.inflight.writes).toHaveLength(2);
		expect(h.inflight.writes[1]).toBeNull();
	});

	test('never written for refusals before the lock work, removed on interruption and abort', async () => {
		const refused = await tab();
		await refused.service.write(
			request(refused.service, { confirmations: { ...CONFIRMED, volumeLowered: false } })
		);
		expect(refused.inflight.writes).toEqual([]);

		const interrupted = await tab({ deviceOptions: { disconnectAtReport: 2 } });
		expect((await interrupted.service.write(request(interrupted.service))).status).toBe(
			'interrupted'
		);
		expect(interrupted.inflight.value).toBeNull();
		expect(interrupted.inflight.writes).toHaveLength(2);

		const aborted = await tab();
		const running = aborted.service.write(request(aborted.service));
		expect(aborted.inflight.value).not.toBeNull();
		expect(aborted.service.abort()).toBe(true);
		const outcome = await running;
		if (outcome.status === 'refused') expect(outcome.reason).toBe('aborted');
		else expect(outcome.result.committed).toBe(false);
		expect(aborted.inflight.value).toBeNull();
		expect(aborted.service.getState().writing).toBe(false);
	});

	test('aborted while waiting for the lock: refused before marker, flash or byte', async () => {
		const base = memoryLocks();
		// Like the browser: the lock callback runs in a later task, not inside write().
		const slow: MemoryLocks = {
			...base,
			async request<T>(
				name: string,
				options: { ifAvailable: true },
				callback: (lock: WriteLock | null) => Promise<T>
			): Promise<T> {
				await Promise.resolve();
				return base.request(name, options, callback);
			}
		};
		const h = await tab({ locks: slow });
		const running = h.service.write(request(h.service));
		expect(h.service.getState().writing).toBe(true);
		expect(h.inflight.writes).toEqual([]);
		expect(h.service.abort()).toBe(true);
		expect(await running).toMatchObject({ status: 'refused', reason: 'aborted' });
		expectUntouched(h);
		expect(h.inflight.writes).toEqual([]);
		expect(h.service.getState().writing).toBe(false);
	});

	test('a marker that cannot be persisted: refused without Web Locks, tolerated with them', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const unguarded = await tab({ locks: null });
		unguarded.inflight.failWrites = true;
		expect(await unguarded.service.write(request(unguarded.service))).toMatchObject({
			status: 'refused',
			reason: 'error'
		});
		expectUntouched(unguarded);

		const locked = await tab();
		locked.inflight.failWrites = true;
		expect((await locked.service.write(request(locked.service))).status).toBe('ok');
		expect(locked.device.sent).toHaveLength(10);
	});

	test('simulated writes leave no marker', async () => {
		const h = await tab({ hid: null });
		expect((await h.service.write(request(h.service))).status).toBe('simulated');
		expect(h.inflight.writes).toEqual([]);
	});

	test('queue: the marker names the cable being written and is removed at the end', async () => {
		const h = await tab();
		const second = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		const devicesAtSend: string[] = [];
		for (const device of [h.device, second]) {
			const send = device.sendReport.bind(device);
			vi.spyOn(device, 'sendReport').mockImplementation((reportId, data) => {
				devicesAtSend.push(stored(h.inflight.value)?.device ?? 'none');
				return send(reportId, data);
			});
		}
		const outcome = await h.service.writeQueue({
			...request(h.service),
			devices: [h.device, second]
		});
		expect(outcome.status).toBe('done');
		expect(new Set(devicesAtSend.slice(0, 10))).toEqual(new Set(['USB DSP Audio']));
		expect(new Set(devicesAtSend.slice(10))).toEqual(new Set(['USB DSP Audio #2']));
		expect(h.inflight.value).toBeNull();
	});
});

describe('stale marker on load', () => {
	test('lock free: the marker becomes an interrupted entry and the rescue state', async () => {
		const closed = marker();
		const inflight = memoryInflight(JSON.stringify(closed));
		const h = await tab({ inflight, connect: false });
		expect(h.journal.entries).toMatchObject([interruptedEntry(closed)]);
		expect(h.service.getState().rescue).toEqual({
			at: closed.at,
			deviceLabel: 'USB DSP Audio',
			reportsSent: null,
			fresh: true
		});
		expect(inflight.value).toBeNull();
		expect(h.flash.records).toEqual([]);
		expect(h.device.attempts).toBe(0);
		// A later load finds nothing left to recover (no duplicate entry).
		const again = await tab({ inflight, connect: false });
		expect(again.journal.entries).toEqual([]);
	});

	test('lock free and marker only 100 ms old: its tab is gone, so it is recovered too', async () => {
		const closed = marker({ at: T0 - 100 });
		const h = await tab({ inflight: memoryInflight(JSON.stringify(closed)), connect: false });
		expect(h.journal.last()).toMatchObject(interruptedEntry(closed));
		expect(h.journal.entries).toHaveLength(1);
	});

	test('lock held by a live tab: the marker is left alone', async () => {
		const live = JSON.stringify(marker({ at: T0 - 100 }));
		const inflight = memoryInflight(live);
		const h = await tab({
			inflight,
			locks: memoryLocks(new Set([CABLE_WRITE_LOCK])),
			connect: false
		});
		expect(h.journal.entries).toEqual([]);
		expect(h.service.getState().rescue).toBeNull();
		expect(inflight.value).toBe(live);
	});

	test('without Web Locks only a marker older than the stale timeout is recovered', async () => {
		const fresh = JSON.stringify(marker({ at: T0 - 1000 }));
		const young = await tab({ locks: null, inflight: memoryInflight(fresh), connect: false });
		expect(young.journal.entries).toEqual([]);
		expect(young.inflight.value).toBe(fresh);

		const old = marker({ at: T0 - INFLIGHT_STALE_MS - 1 });
		const h = await tab({
			locks: null,
			inflight: memoryInflight(JSON.stringify(old)),
			connect: false
		});
		expect(h.journal.entries).toMatchObject([interruptedEntry(old)]);
		expect(h.service.getState().rescue?.at).toBe(old.at);
	});

	test('an unreadable marker is removed and still raises the rescue notice', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const inflight = memoryInflight('{not json');
		const h = await tab({ inflight, connect: false });
		expect(h.journal.entries).toEqual([]);
		expect(h.service.getState().rescue).toEqual({
			at: T0,
			deviceLabel: null,
			reportsSent: null,
			fresh: true
		});
		expect(inflight.value).toBeNull();
	});

	test('simulated mode journals the real interruption without a rescue notice', async () => {
		const closed = marker();
		const h = await tab({ hid: null, inflight: memoryInflight(JSON.stringify(closed)) });
		expect(h.journal.entries).toMatchObject([interruptedEntry(closed)]);
		expect(h.service.getState().rescue).toBeNull();
	});
});

describe('flash attempts are recorded before I/O', () => {
	test('a transport refusal before any I/O is not counted (and its marker is removed)', async () => {
		const a = await tab({ locks: null });
		const journal = memoryJournal();
		const flash = memoryFlash();
		const inflight = memoryInflight();
		// Another realm-less "tab" on the very same device, without Web Locks.
		const b = own(
			createCableService({
				hid: a.hid,
				journal,
				flash,
				now: () => a.time.value,
				lastWrittenLevelDb: () => null,
				sessionWriteCount: () => 0,
				clock: a.clock,
				userActivation: () => ({ isActive: true }),
				locks: null,
				inflight
			})
		);
		await b.connect();
		expect(b.getState().device).toBe(a.device);
		const first = a.service.write(request(a.service));
		const refused = await b.write(request(b));
		// writeCurve threw ConcurrentWriteError before touching the device.
		expect(refused).toMatchObject({ status: 'refused', reason: 'busy' });
		expect(flash.records).toEqual([]);
		expect(journal.entries).toEqual([]);
		expect(inflight.value).toBeNull();
		expect(inflight.writes).toHaveLength(2);
		expect((await first).status).toBe('ok');
		expect(a.flash.records).toEqual([T0]);
		expect(a.device.sent).toHaveLength(10);
	});

	test('each cable of a queue is counted right before its first byte', async () => {
		const h = await tab();
		const second = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		const sentAtRecord: number[][] = [];
		const record = h.flash.record.bind(h.flash);
		h.flash.record = (at) => {
			sentAtRecord.push([h.device.sent.length, second.sent.length]);
			record(at);
		};
		const outcome = await h.service.writeQueue({
			...request(h.service),
			devices: [h.device, second]
		});
		expect(outcome.status).toBe('done');
		expect(sentAtRecord).toEqual([
			[0, 0],
			[10, 0]
		]);
	});
});

describe('the 2 s spacing runs from the end of the previous write', () => {
	/** Each report sent by `device` takes `stepMs` of service time (deps.now). */
	function slowReports(h: Harness, device: FakeHIDDevice, stepMs: number) {
		const send = device.sendReport.bind(device);
		vi.spyOn(device, 'sendReport').mockImplementation(async (reportId, data) => {
			await send(reportId, data);
			h.time.value += stepMs;
		});
	}

	test('counted once before the first byte; lastWriteAt is the settle time', async () => {
		const h = await tab();
		slowReports(h, h.device, 50);
		expect((await h.service.write(request(h.service))).status).toBe('ok');
		// 9 data reports + commit, 50 ms each.
		expect(h.flash.records).toEqual([T0]);
		expect(h.flash.touches).toEqual([T0 + 500]);
		expect(h.flash.get()).toMatchObject({
			total: 1,
			session: 1,
			day: { date: localDateKey(T0), count: 1 },
			lastWriteAt: T0 + 500
		});
		expect(h.service.counters()).toEqual({ session: 1, day: 1, total: 1 });
	});

	test('2 s after the start but < 2 s after the end is refused by the checklist spacing', async () => {
		const h = await tab();
		slowReports(h, h.device, 50);
		expect((await h.service.write(request(h.service))).status).toBe('ok');
		h.time.value = T0 + 2000;
		const early = await h.service.write(request(h.service));
		expect(early).toMatchObject({ status: 'refused', reason: 'checklist' });
		if (early.status === 'refused') {
			expect(early.checklist?.spacing).toEqual({ ok: false, waitMs: 500 });
		}
		expect(h.device.sent).toHaveLength(10);
		expect(h.flash.records).toEqual([T0]);
		h.time.value = T0 + 2500;
		expect((await h.service.write(request(h.service))).status).toBe('ok');
		expect(h.flash.records).toEqual([T0, T0 + 2500]);
		expect(h.flash.get().total).toBe(2);
	});

	test('an interrupted write also restarts the spacing from its last byte', async () => {
		const h = await tab({ deviceOptions: { disconnectAtReport: 3 } });
		slowReports(h, h.device, 50);
		expect((await h.service.write(request(h.service))).status).toBe('interrupted');
		expect(h.device.sent).toHaveLength(3);
		expect(h.flash.records).toEqual([T0]);
		// Touched once, when the interrupted sequence ended (after the last accepted report).
		const end = h.time.value;
		expect(end).toBeGreaterThanOrEqual(T0 + 150);
		expect(h.flash.touches).toEqual([end]);
		expect(h.flash.get()).toMatchObject({ total: 1, lastWriteAt: end });
	});

	test('a pre-I/O refusal neither counts nor touches', async () => {
		const h = await tab();
		await h.service.write(
			request(h.service, { confirmations: { ...CONFIRMED, keepConnected: false } })
		);
		expect(h.flash.records).toEqual([]);
		expect(h.flash.touches).toEqual([]);
	});

	test('queue: each cable is counted once and touched at its own end', async () => {
		const h = await tab();
		const second = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		slowReports(h, h.device, 50);
		slowReports(h, second, 50);
		const outcome = await h.service.writeQueue({
			...request(h.service),
			devices: [h.device, second]
		});
		expect(outcome.status).toBe('done');
		expect(h.flash.records).toEqual([T0, T0 + 500]);
		expect(h.flash.touches).toEqual([T0 + 500, T0 + 1000]);
		expect(h.flash.get()).toMatchObject({ total: 2, lastWriteAt: T0 + 1000 });
	});

	test('simulated mode measures the spacing from the end as well', async () => {
		const h = await tab({ hid: null });
		const device = h.service.getState().device;
		if (!(device instanceof FakeHIDDevice)) throw new Error('missing simulated device');
		slowReports(h, device, 50);
		expect((await h.service.write(request(h.service))).status).toBe('simulated');
		expect(h.service.counters()).toEqual({ session: 1, day: 1, total: 1 });
		h.time.value = T0 + 2000;
		const early = await h.service.write(request(h.service));
		expect(early).toMatchObject({ status: 'refused', reason: 'checklist' });
		if (early.status === 'refused') {
			expect(early.checklist?.spacing).toEqual({ ok: false, waitMs: 500 });
		}
		h.time.value = T0 + 2500;
		expect((await h.service.write(request(h.service))).status).toBe('simulated');
		expect(h.service.counters()).toEqual({ session: 2, day: 2, total: 2 });
		// The real bookkeeping is never used in simulated mode.
		expect(h.flash.records).toEqual([]);
		expect(h.flash.touches).toEqual([]);
	});
});

describe('last written level comes from the journal', () => {
	const entry = (status: JournalEntry['status'], preampDb: number, at: number): JournalEntry => ({
		schema: 1,
		at,
		name: '',
		crc: 0x4fff,
		preampDb,
		bands: NEUTRAL_BANDS.map((band) => ({ ...band })),
		status,
		device: 'USB DSP Audio'
	});

	test('the newest ok entry; interrupted and simulated entries are skipped', () => {
		expect(lastWrittenLevelDbOf([])).toBeNull();
		expect(lastWrittenLevelDbOf([entry('simulated', -4, 1)])).toBeNull();
		const ok = entry('ok', -4, 1);
		expect(
			lastWrittenLevelDbOf([ok, entry('interrupted', -1, 2), entry('simulated', -2, 3)])
		).toBeCloseTo(levelDb(NEUTRAL_BANDS, -4), 9);
		expect(writtenLevelDb(ok)).toBeCloseTo(levelDb(NEUTRAL_BANDS, -4), 9);
	});

	test('a new service instance (reload or another tab) keeps the loudness jump warning', async () => {
		const journal = memoryJournal();
		const deps = (time: { value: number }) => ({
			journal,
			flash: memoryFlash(),
			now: () => time.value,
			lastWrittenLevelDb: () => lastWrittenLevelDbOf(journal.entries),
			sessionWriteCount: () => 0,
			userActivation: () => ({ isActive: true }),
			locks: memoryLocks(),
			inflight: memoryInflight()
		});
		const h = await tab();
		const first = own(createCableService({ ...deps(h.time), hid: h.hid, clock: h.clock }));
		await first.connect();
		const quiet = { bands: NEUTRAL_BANDS, preampDb: -4, name: 'Quiet' };
		expect((await first.write(request(first, quiet))).status).toBe('ok');
		first.dispose();

		const reloaded = own(createCableService({ ...deps(h.time), hid: h.hid, clock: h.clock }));
		const checklist = reloaded.checklist({
			bands: NEUTRAL_BANDS,
			preampDb: -0.5,
			experimental: false,
			confirmations: CONFIRMED
		});
		expect(checklist.loudness.reasons).toContain('jump');
		expect(checklist.loudness.deltaDb).toBeCloseTo(
			levelDb(NEUTRAL_BANDS, -0.5) - levelDb(NEUTRAL_BANDS, -4),
			6
		);
	});
});

describe('flash counters have one source', () => {
	test('simulated: the service counters equal the checklist counters after a write', async () => {
		const h = await tab({ hid: null });
		const before = h.service.checklist(request(h.service)).counters;
		expect(h.service.counters()).toEqual(before);
		expect(before).toEqual({ session: 0, day: 0, total: 0 });
		expect((await h.service.write(request(h.service))).status).toBe('simulated');
		const after = h.service.checklist(request(h.service)).counters;
		expect(h.service.counters()).toEqual(after);
		expect(after).toEqual({ session: 1, day: 1, total: 1 });
		// The real bookkeeping is untouched.
		expect(h.flash.records).toEqual([]);
	});

	test('real: the service counters equal the checklist counters and the shared store', async () => {
		const h = await tab({ flash: { day: { date: localDateKey(T0), count: 4 }, total: 9 } });
		expect((await h.service.write(request(h.service))).status).toBe('ok');
		const checklist = h.service.checklist(request(h.service));
		expect(h.service.counters()).toEqual(checklist.counters);
		expect(h.service.counters()).toEqual({ session: 1, day: 5, total: 10 });
	});
});

/** Holds the 2 s spacing between two queued cables open until `release()`. */
function gappedClock() {
	let release: (() => void) | null = null;
	let entered: (() => void) | null = null;
	const inGap = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const wrap = (clock: Clock): Clock => ({
		now: () => clock.now(),
		sleep(ms, signal) {
			if (ms !== WRITE_SPACING_MS) return clock.sleep(ms, signal);
			entered?.();
			return new Promise<void>((resolve) => {
				release = resolve;
			}).then(() => clock.sleep(ms, signal));
		}
	});
	return { wrap, inGap, release: () => release?.() };
}

describe('X9 queue settles each cable as it ends (R2-03)', () => {
	test('a committed cable is journaled and announced before the spacing to the next one', async () => {
		const gap = gappedClock();
		const h = await tab({ wrapClock: gap.wrap, tabId: 'queue-tab' });
		const second = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		const running = h.service.writeQueue({ ...request(h.service), devices: [h.device, second] });
		await gap.inGap;
		expect(h.journal.entries.map((entry) => [entry.status, entry.device])).toEqual([
			['ok', 'USB DSP Audio']
		]);
		expect(h.written.map((detail) => detail.deviceLabel)).toEqual(['USB DSP Audio']);
		expect(h.service.getState().queue?.items.map((item) => item.status)).toEqual(['ok', 'pending']);
		// The marker no longer names a cable being written.
		expect(stored(h.inflight.value)).toMatchObject({
			tabId: 'queue-tab',
			device: 'USB DSP Audio',
			between: true
		});
		expect(second.sent).toEqual([]);
		gap.release();
		const outcome = await running;
		expect(outcome.status).toBe('done');
		if (outcome.status !== 'done') return;
		expect(outcome.items.map((item) => item.status)).toEqual(['ok', 'ok']);
		expect(outcome.items[0]?.entry).toMatchObject({ status: 'ok', device: 'USB DSP Audio' });
		// Settled once each: no duplicate journal entry or event for the first cable.
		expect(h.journal.entries.map((entry) => entry.status)).toEqual(['ok', 'ok']);
		expect(h.written.map((detail) => detail.deviceLabel)).toEqual([
			'USB DSP Audio',
			'USB DSP Audio #2'
		]);
		expect(second.sent).toHaveLength(10);
		expect(h.inflight.value).toBeNull();
	});

	test('the second cable is marked as written while it is being written', async () => {
		const gap = gappedClock();
		const h = await tab({ wrapClock: gap.wrap });
		const second = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		const markers: (InflightMarker | null)[] = [];
		const send = second.sendReport.bind(second);
		vi.spyOn(second, 'sendReport').mockImplementation((reportId, data) => {
			markers.push(stored(h.inflight.value));
			return send(reportId, data);
		});
		const running = h.service.writeQueue({ ...request(h.service), devices: [h.device, second] });
		await gap.inGap;
		gap.release();
		expect((await running).status).toBe('done');
		expect(markers).toHaveLength(10);
		for (const seen of markers) {
			expect(seen?.device).toBe('USB DSP Audio #2');
			expect(seen?.between).toBeUndefined();
		}
	});

	test('a tab closed during the spacing leaves no committed cable to recover as interrupted', async () => {
		const held = new Set<string>();
		const inflight = memoryInflight();
		const gap = gappedClock();
		const writer = await tab({
			wrapClock: gap.wrap,
			tabId: 'writer',
			locks: memoryLocks(held),
			inflight
		});
		const second = new FakeHIDDevice({ clock: writer.clock });
		writer.hid.addDevice(second);
		void writer.service.writeQueue({
			...request(writer.service),
			devices: [writer.device, second]
		});
		await gap.inGap;
		expect(writer.journal.entries.map((entry) => entry.status)).toEqual(['ok']);
		expect(writer.written).toHaveLength(1);
		// The writer tab dies in the gap: the browser releases its locks; the marker stays.
		killHolder(held, CABLE_WRITE_LOCK);
		killHolder(held, cableAliveLock('writer'));
		const reloaded = await tab({
			tabId: 'reloaded',
			locks: memoryLocks(held),
			inflight,
			connect: false
		});
		expect(reloaded.journal.entries).toEqual([]);
		expect(reloaded.service.getState().rescue).toBeNull();
		expect(inflight.value).toBeNull();
		expect(second.sent).toEqual([]);
	});

	test('a write that finds a dead between-cables marker clears it and proceeds', async () => {
		const h = await tab();
		h.inflight.value = JSON.stringify(marker({ at: T0 - 100, between: true }));
		const outcome = await h.service.write(request(h.service));
		expect(outcome.status).toBe('ok');
		expect(h.journal.entries.map((entry) => entry.status)).toEqual(['ok']);
		expect(h.service.getState().rescue).toBeNull();
		expect(h.inflight.value).toBeNull();
	});
});

describe('a marker that cannot follow the queue to the next cable refuses it (#16)', () => {
	/** Once `full` is set, every marker write fails except removals (like a full quota). */
	function quota(inflight: MemoryInflight) {
		const write = inflight.write.bind(inflight);
		const state = { full: false };
		inflight.write = (value) => (state.full && value !== null ? false : write(value));
		return state;
	}

	/** The `disconnect` listeners the transport attached to and removed from `h.hid`. */
	function disconnectListeners(h: Harness) {
		const added = vi.spyOn(h.hid, 'addEventListener');
		const removed = vi.spyOn(h.hid, 'removeEventListener');
		const of = (calls: unknown[][]) =>
			calls.filter((call) => call[0] === 'disconnect').map((call) => call[1]);
		return { added: () => of(added.mock.calls), removed: () => of(removed.mock.calls) };
	}

	test('the next cable is refused before any byte, uncounted, and no between marker is left', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const gap = gappedClock();
		const h = await tab({ wrapClock: gap.wrap, tabId: 'queue-tab' });
		const second = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		const storage = quota(h.inflight);
		const listeners = disconnectListeners(h);
		const running = h.service.writeQueue({ ...request(h.service), devices: [h.device, second] });
		await gap.inGap;
		expect(stored(h.inflight.value)).toMatchObject({ tabId: 'queue-tab', between: true });
		// The update that would point the marker at the second cable fails.
		storage.full = true;
		gap.release();
		const outcome = await running;
		expect(outcome.status).toBe('done');
		if (outcome.status !== 'done') return;
		expect(outcome.items.map((item) => item.status)).toEqual(['ok', 'failed']);
		expect(outcome.items[1]?.error).toBeInstanceOf(Error);
		// No HID report (not even open) reached the second cable, and it was not counted.
		expect(second.attempts).toBe(0);
		expect(second.sent).toEqual([]);
		expect(h.device.sent).toHaveLength(10);
		expect(h.flash.records).toEqual([T0]);
		expect(h.flash.touches).toHaveLength(1);
		expect(h.journal.entries.map((entry) => [entry.status, entry.device])).toEqual([
			['ok', 'USB DSP Audio']
		]);
		expect(h.written).toHaveLength(1);
		// The `between` marker was removed instead of being left behind a write.
		expect(h.inflight.value).toBeNull();
		expect(h.inflight.writes.at(-1)).toBeNull();
		// The refused start attached no listener; the first cable's was removed.
		expect(listeners.added()).toHaveLength(1);
		for (const listener of listeners.added()) expect(listeners.removed()).toContain(listener);
		expect(h.service.getState()).toMatchObject({ writing: false });
	});

	test('when the marker cannot be removed either, the next cable is still refused', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const gap = gappedClock();
		const h = await tab({ wrapClock: gap.wrap, tabId: 'queue-tab' });
		const second = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		const running = h.service.writeQueue({ ...request(h.service), devices: [h.device, second] });
		await gap.inGap;
		h.inflight.failWrites = true;
		gap.release();
		const outcome = await running;
		expect(outcome.status).toBe('done');
		if (outcome.status !== 'done') return;
		expect(outcome.items.map((item) => item.status)).toEqual(['ok', 'failed']);
		expect(second.attempts).toBe(0);
		expect(second.sent).toEqual([]);
		expect(h.flash.records).toEqual([T0]);
		// Nothing is being written, which is exactly what the stored marker still says.
		expect(stored(h.inflight.value)).toMatchObject({
			tabId: 'queue-tab',
			device: 'USB DSP Audio',
			between: true
		});
	});
});

describe('a between-cables marker that cannot be stored never names a committed cable (#5)', () => {
	/** Fails the marker writes `fails` picks; every other write goes through. */
	function failing(inflight: MemoryInflight, fails: (value: string | null) => boolean) {
		const write = inflight.write.bind(inflight);
		inflight.write = (value) => (fails(value) ? false : write(value));
	}
	const betweenMarker = (value: string | null) => stored(value)?.between === true;

	test('the marker is removed: a tab closed during the spacing records no interruption', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const held = new Set<string>();
		const inflight = memoryInflight();
		failing(inflight, betweenMarker);
		const gap = gappedClock();
		const writer = await tab({
			wrapClock: gap.wrap,
			tabId: 'writer',
			locks: memoryLocks(held),
			inflight
		});
		const second = new FakeHIDDevice({ clock: writer.clock });
		writer.hid.addDevice(second);
		void writer.service.writeQueue({
			...request(writer.service),
			devices: [writer.device, second]
		});
		await gap.inGap;
		expect(writer.journal.entries.map((entry) => entry.status)).toEqual(['ok']);
		// The marker that still named the committed cable as being written was removed.
		expect(inflight.value).toBeNull();
		expect(inflight.writes.at(-1)).toBeNull();
		// The writer tab dies in the gap: the browser releases its locks.
		killHolder(held, CABLE_WRITE_LOCK);
		killHolder(held, cableAliveLock('writer'));
		const reloaded = await tab({
			tabId: 'reloaded',
			locks: memoryLocks(held),
			inflight,
			connect: false
		});
		expect(reloaded.journal.entries).toEqual([]);
		expect(reloaded.service.getState().rescue).toBeNull();
		expect(second.sent).toEqual([]);
	});

	test('with the write lock still held, the next cable goes and is marked while written', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const gap = gappedClock();
		const h = await tab({ wrapClock: gap.wrap, tabId: 'queue-tab' });
		const second = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		failing(h.inflight, betweenMarker);
		const markers: (InflightMarker | null)[] = [];
		const send = second.sendReport.bind(second);
		vi.spyOn(second, 'sendReport').mockImplementation((reportId, data) => {
			markers.push(stored(h.inflight.value));
			return send(reportId, data);
		});
		const running = h.service.writeQueue({ ...request(h.service), devices: [h.device, second] });
		await gap.inGap;
		expect(h.inflight.value).toBeNull();
		gap.release();
		const outcome = await running;
		expect(outcome.status).toBe('done');
		if (outcome.status !== 'done') return;
		expect(outcome.items.map((item) => item.status)).toEqual(['ok', 'ok']);
		expect(second.sent).toHaveLength(10);
		expect(markers).toHaveLength(10);
		for (const seen of markers) {
			expect(seen).toMatchObject({ tabId: 'queue-tab', device: 'USB DSP Audio #2' });
			expect(seen?.between).toBeUndefined();
		}
		expect(h.inflight.value).toBeNull();
	});

	test('when the marker can be neither updated nor removed, the next cable is refused before any byte', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const gap = gappedClock();
		const h = await tab({ wrapClock: gap.wrap, tabId: 'queue-tab' });
		const second = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		// Only the next cable's own marker could still be stored: the refusal must not rely on it.
		failing(h.inflight, (value) => value === null || betweenMarker(value));
		const before = h.inflight.writes.length;
		const running = h.service.writeQueue({ ...request(h.service), devices: [h.device, second] });
		await gap.inGap;
		gap.release();
		const outcome = await running;
		expect(outcome.status).toBe('done');
		if (outcome.status !== 'done') return;
		expect(outcome.items.map((item) => item.status)).toEqual(['ok', 'failed']);
		expect(outcome.items[1]?.error).toBeInstanceOf(Error);
		expect(second.attempts).toBe(0);
		expect(second.sent).toEqual([]);
		expect(h.flash.records).toEqual([T0]);
		expect(h.journal.entries.map((entry) => [entry.status, entry.device])).toEqual([
			['ok', 'USB DSP Audio']
		]);
		// Only the first cable's marker was ever stored: nothing was marked for the second one.
		expect(h.inflight.writes.slice(before).map(stored)).toEqual([
			expect.objectContaining({ tabId: 'queue-tab', device: 'USB DSP Audio' })
		]);
		expect(h.service.getState()).toMatchObject({ writing: false });
	});

	test('without Web Locks the removed marker left the spacing unguarded: the next cable is refused', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const gap = gappedClock();
		const h = await tab({ wrapClock: gap.wrap, tabId: 'queue-tab', locks: null });
		const second = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		failing(h.inflight, betweenMarker);
		const running = h.service.writeQueue({ ...request(h.service), devices: [h.device, second] });
		await gap.inGap;
		expect(h.inflight.value).toBeNull();
		gap.release();
		const outcome = await running;
		expect(outcome.status).toBe('done');
		if (outcome.status !== 'done') return;
		expect(outcome.items.map((item) => item.status)).toEqual(['ok', 'failed']);
		expect(second.attempts).toBe(0);
		expect(second.sent).toEqual([]);
		expect(h.flash.records).toEqual([T0]);
		expect(h.inflight.value).toBeNull();
	});
});

describe('other tabs surface an interruption by waiting for the writer tab (R2-07, #15)', () => {
	/**
	 * Another tab writing: it holds the write lock and its liveness lock, and its marker was
	 * just stored (a storage event here).
	 */
	function liveWriter(
		held: Set<string>,
		inflight: ReturnType<typeof memoryInflight>,
		tabId = 'writer'
	) {
		const writing = marker({ at: T0, tabId });
		held.add(CABLE_WRITE_LOCK);
		held.add(cableAliveLock(tabId));
		inflight.value = JSON.stringify(writing);
		inflight.announce();
		return writing;
	}

	/** The writer tab dies: the browser releases every lock it held. */
	function die(held: Set<string>, tabId = 'writer') {
		killHolder(held, CABLE_WRITE_LOCK);
		killHolder(held, cableAliveLock(tabId));
	}

	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

	test('the writer dies: the waiting tab records the interruption and raises the notice', async () => {
		const held = new Set<string>();
		const inflight = memoryInflight();
		const locks = memoryLocks(held);
		const h = await tab({ tabId: 'watcher', locks, inflight, connect: false });
		const writing = liveWriter(held, inflight);
		await Promise.resolve();
		// It waits on the writer tab's liveness lock, never on the write lock.
		expect(locks.waits).toEqual([{ name: cableAliveLock('writer'), granted: false }]);
		expect(h.journal.entries).toEqual([]);
		expect(h.service.getState().rescue).toBeNull();
		// A second storage event while waiting does not queue another wait.
		inflight.announce();
		expect(locks.waits).toHaveLength(1);
		die(held);
		await vi.waitFor(() => expect(h.journal.entries).toHaveLength(1));
		expect(h.journal.entries).toMatchObject([interruptedEntry(writing)]);
		expect(h.service.getState().rescue).toEqual({
			at: writing.at,
			deviceLabel: 'USB DSP Audio',
			reportsSent: null,
			fresh: true
		});
		expect(inflight.value).toBeNull();
		// Waiting and recording never wrote: no write lock request, no flash, no byte.
		expect(locks.requests).toEqual([]);
		expect(h.flash.records).toEqual([]);
		expect(h.device.attempts).toBe(0);
		await vi.waitFor(() => expect(held.size).toBe(0));
	});

	test('the writer finishes normally: the wait is dropped and nothing is recorded', async () => {
		const held = new Set<string>();
		const inflight = memoryInflight();
		const locks = memoryLocks(held);
		const h = await tab({ tabId: 'watcher', locks, inflight, connect: false });
		liveWriter(held, inflight);
		expect(locks.waits).toEqual([{ name: cableAliveLock('writer'), granted: false }]);
		// A writer removes its marker before it releases the write lock; its tab lives on.
		inflight.value = null;
		inflight.announce();
		killHolder(held, CABLE_WRITE_LOCK);
		await tick();
		// That wait was aborted: closing the writer tab later records nothing either.
		killHolder(held, cableAliveLock('writer'));
		await tick();
		expect(locks.waits).toEqual([{ name: cableAliveLock('writer'), granted: false }]);
		expect(held.size).toBe(0);
		expect(h.journal.entries).toEqual([]);
		expect(h.service.getState().rescue).toBeNull();
	});

	test('granted after a normal finish whose storage event was missed: nothing is recorded', async () => {
		const held = new Set<string>();
		const inflight = memoryInflight();
		const locks = memoryLocks(held);
		const h = await tab({ tabId: 'watcher', locks, inflight, connect: false });
		liveWriter(held, inflight);
		inflight.value = null;
		die(held);
		await vi.waitFor(() => expect(locks.waits[0]?.granted).toBe(true));
		await vi.waitFor(() => expect(held.size).toBe(0));
		expect(h.journal.entries).toEqual([]);
		expect(h.service.getState().rescue).toBeNull();
	});

	test('a tab loaded while another writes waits for it as well', async () => {
		const held = new Set<string>([CABLE_WRITE_LOCK, cableAliveLock('writer')]);
		const live = marker({ at: T0 - 100, tabId: 'writer' });
		const inflight = memoryInflight(JSON.stringify(live));
		const locks = memoryLocks(held);
		const h = await tab({ tabId: 'late', locks, inflight, connect: false });
		expect(h.journal.entries).toEqual([]);
		expect(locks.waits).toEqual([{ name: cableAliveLock('writer'), granted: false }]);
		die(held);
		await vi.waitFor(() => expect(h.journal.entries).toMatchObject([interruptedEntry(live)]));
		expect(h.service.getState().rescue?.fresh).toBe(true);
	});

	test('own markers are ignored and disposal stops the wait', async () => {
		const held = new Set<string>();
		const inflight = memoryInflight();
		const locks = memoryLocks(held);
		const h = await tab({ tabId: 'watcher', locks, inflight, connect: false });
		held.add(CABLE_WRITE_LOCK);
		inflight.value = JSON.stringify(marker({ tabId: 'watcher' }));
		inflight.announce();
		expect(locks.waits).toEqual([]);
		held.add(cableAliveLock('writer'));
		inflight.value = JSON.stringify(marker({ tabId: 'writer' }));
		inflight.announce();
		await Promise.resolve();
		expect(locks.waits).toHaveLength(1);
		h.service.dispose();
		die(held);
		await tick();
		expect(locks.waits[0]?.granted).toBe(false);
		expect(h.journal.entries).toEqual([]);
		expect(h.service.getState().rescue).toBeNull();
	});

	test('an observer never queues on the write lock: the next writer gets it once the first ends', async () => {
		const held = new Set<string>();
		const inflight = memoryInflight();
		const a = await tab({ tabId: 'tab-a', locks: memoryLocks(held), inflight });
		const observer = await tab({
			tabId: 'observer',
			locks: memoryLocks(held),
			inflight,
			connect: false
		});
		const b = await tab({ tabId: 'tab-b', locks: memoryLocks(held), inflight });
		const first = a.service.write(request(a.service));
		expect(stored(inflight.value)).toMatchObject({ tabId: 'tab-a' });
		// The other tabs see A's marker (a storage event) and wait for A's tab.
		inflight.announce();
		expect(observer.locks?.waits).toEqual([{ name: cableAliveLock('tab-a'), granted: false }]);
		expect(await b.service.write(request(b.service))).toMatchObject({
			status: 'refused',
			reason: 'busy'
		});
		expect((await first).status).toBe('ok');
		// The observer still waits (A's tab lives on); the write lock is free for B at once.
		expect(held.has(CABLE_WRITE_LOCK)).toBe(false);
		expect(observer.locks?.waits[0]?.granted).toBe(false);
		expect((await b.service.write(request(b.service))).status).toBe('ok');
		expect(b.device.sent).toHaveLength(10);
		for (const each of [a, observer, b]) {
			expect(each.locks?.waits.map((wait) => wait.name)).not.toContain(CABLE_WRITE_LOCK);
		}
		expect(observer.journal.entries).toEqual([]);
		expect(observer.service.getState().rescue).toBeNull();
	});

	test('a writer tab that dies mid-write is recorded by the tab waiting for it', async () => {
		const held = new Set<string>();
		const inflight = memoryInflight();
		// The third report never completes: the tab is closed while the write is in progress.
		const writer = await tab({
			tabId: 'tab-a',
			locks: memoryLocks(held),
			inflight,
			deviceOptions: { hangAtReport: 2 }
		});
		const observer = await tab({
			tabId: 'observer',
			locks: memoryLocks(held),
			inflight,
			connect: false
		});
		void writer.service.write(request(writer.service));
		const writing = stored(inflight.value);
		expect(writing).toMatchObject({ tabId: 'tab-a', device: 'USB DSP Audio', crc: 0x1970 });
		inflight.announce();
		expect(observer.locks?.waits).toEqual([{ name: cableAliveLock('tab-a'), granted: false }]);
		await vi.waitFor(() => expect(writer.device.sent).toHaveLength(2));
		expect(observer.journal.entries).toEqual([]);
		die(held, 'tab-a');
		await vi.waitFor(() => expect(observer.journal.entries).toHaveLength(1));
		if (writing === null) throw new Error('missing marker');
		expect(observer.journal.entries).toMatchObject([interruptedEntry(writing)]);
		expect(observer.service.getState().rescue).toMatchObject({
			deviceLabel: 'USB DSP Audio',
			fresh: true
		});
		expect(inflight.value).toBeNull();
		expect(observer.locks?.requests).toEqual([]);
		expect(observer.device.attempts).toBe(0);
	});

	test('the wait follows the stored marker to the tab that writes now', async () => {
		const held = new Set<string>();
		const inflight = memoryInflight();
		const locks = memoryLocks(held);
		const h = await tab({ tabId: 'watcher', locks, inflight, connect: false });
		liveWriter(held, inflight, 'tab-a');
		// A finished and B writes: the next storage event shows B's marker.
		const writingB = liveWriter(held, inflight, 'tab-b');
		expect(locks.waits).toEqual([
			{ name: cableAliveLock('tab-a'), granted: false },
			{ name: cableAliveLock('tab-b'), granted: false }
		]);
		// A's tab closing now records nothing: that wait was dropped.
		killHolder(held, cableAliveLock('tab-a'));
		await tick();
		expect(locks.waits[0]?.granted).toBe(false);
		expect(h.journal.entries).toEqual([]);
		die(held, 'tab-b');
		await vi.waitFor(() => expect(h.journal.entries).toMatchObject([interruptedEntry(writingB)]));
	});

	test('a writer holding no liveness lock is not taken for dead while it holds the write lock', async () => {
		const held = new Set<string>([CABLE_WRITE_LOCK]);
		const inflight = memoryInflight();
		const locks = memoryLocks(held);
		const h = await tab({ tabId: 'watcher', locks, inflight, connect: false });
		// E.g. a tab still running a version without liveness locks.
		const live = JSON.stringify(marker({ at: T0, tabId: 'old-writer' }));
		inflight.value = live;
		inflight.announce();
		await vi.waitFor(() => expect(locks.waits[0]?.granted).toBe(true));
		await tick();
		expect(h.journal.entries).toEqual([]);
		expect(h.service.getState().rescue).toBeNull();
		expect(inflight.value).toBe(live);
		expect(held.has(CABLE_WRITE_LOCK)).toBe(true);
	});
});
