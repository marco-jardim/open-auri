/**
 * Live (no-flash) preview session of the cable service (issues #67 S4 and #70 S7): live applies
 * reach the cable's RAM only, never the journal, the flash counters, `cable:written` or the
 * in-flight marker; holds, pacing, Salvar serialization and the end of a session.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { FakeHID, FakeHIDDevice, type FakeFirmware } from 'open-auri/transport';
import { gateForWrite, levelDb } from 'open-auri/safety';
import { LIVE_AFTER_COMMIT_MS, LIVE_DEBOUNCE_MS, LIVE_MIN_INTERVAL_MS } from 'open-auri/policy';
import { CABLE_WRITE_LOCK, createCableService } from '../../../src/lib/cable/service.ts';
import { NATIVE_HID_BRAND } from '../../../src/lib/cable/native/brand.ts';
import { onWriteProgress } from '../../../src/lib/cable/write-flag.ts';
import type { Band, LiveCurve, Written } from '../../../src/lib/cable/types.ts';
import {
	CONFIRMED,
	T0,
	TRUSTED_CLICK,
	memoryFlash,
	memoryJournal,
	off,
	setup
} from './harness.ts';
import { memoryInflight, memoryLocks } from './locks-fake.ts';

type Harness = Awaited<ReturnType<typeof setup>>;

const OFF_BANDS: Band[] = Array.from({ length: 10 }, off);

function curve(preampDb: number): LiveCurve {
	return { bands: OFF_BANDS, preampDb };
}

function crcOf(preampDb: number): number {
	const verdict = gateForWrite(OFF_BANDS, preampDb, { experimental: false });
	expect(verdict.ok).toBe(true);
	return Number(verdict.metrics.payloadCrc);
}

function levelOf(preampDb: number): number {
	return levelDb(OFF_BANDS, preampDb);
}

/** CRC-16 of a 220-byte payload the fake firmware holds (null: factory curve). */
function payloadCrc(payload: Uint8Array | null): number | null {
	if (payload === null) return null;
	return (payload[218] ?? 0) | ((payload[219] ?? 0) << 8);
}

function liveCrc(firmware: FakeFirmware): number | null {
	return payloadCrc(firmware.live);
}

function start(h: Harness, preampDb = -12) {
	return h.service.startLive({
		curve: curve(preampDb),
		confirmations: { volumeLowered: true },
		gesture: h.service.createGesture(TRUSTED_CLICK)
	});
}

function save(h: Harness, preampDb: number) {
	return h.service.write({
		bands: OFF_BANDS,
		preampDb,
		experimental: false,
		confirmations: CONFIRMED,
		gesture: h.service.createGesture(TRUSTED_CLICK),
		name: 'Salvo'
	});
}

/** Nothing a live apply must never touch was touched. */
function expectNoWriteBookkeeping(h: Harness) {
	expect(h.journal.entries).toEqual([]);
	expect(h.flash.records).toEqual([]);
	expect(h.flash.touches).toEqual([]);
	expect(h.written).toEqual([]);
	expect(h.inflight.writes).toEqual([]);
	expect(h.device.firmware.commitCount).toBe(0);
}

function locksOf(h: Harness) {
	if (h.locks === null) throw new Error('the harness has Web Locks by default');
	return h.locks;
}

const macrotask = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

let cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup) dispose();
	cleanup = [];
});

async function live(options: Parameters<typeof setup>[0] = {}): Promise<Harness> {
	const h = await setup(options);
	cleanup.push(() => h.service.dispose());
	return h;
}

describe('startLive', () => {
	test('requires a fresh gesture: nothing is sent', async () => {
		const h = await live();
		const outcome = await h.service.startLive({
			curve: curve(-12),
			confirmations: { volumeLowered: true },
			gesture: null
		});
		expect(outcome).toMatchObject({ status: 'refused', reason: 'gesture' });
		expect(h.device.attempts).toBe(0);
		expect(h.service.getState().live).toBeNull();
	});

	test('requires the live checklist (volume); no spacing and no keep-connected items', async () => {
		// A write just ended (spacing not satisfied for a flash write): live does not care.
		const h = await live({ flash: { lastWriteAt: T0 } });
		const refused = await h.service.startLive({
			curve: curve(-12),
			confirmations: { volumeLowered: false },
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(refused).toMatchObject({ status: 'refused', reason: 'checklist' });
		if (refused.status !== 'refused') throw new Error('expected a refusal');
		const ids = refused.checklist?.items.map((item) => item.id);
		expect(ids).toContain('volume');
		expect(ids).toContain('gate');
		expect(ids).not.toContain('spacing');
		expect(ids).not.toContain('connection');
		expect(h.device.attempts).toBe(0);

		const outcome = await start(h);
		expect(outcome.status).toBe('accepted');
	});

	test('a gate-failing start curve is refused before any I/O', async () => {
		const h = await live();
		const outcome = await h.service.startLive({
			curve: curve(0),
			confirmations: { volumeLowered: true },
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(outcome).toMatchObject({ status: 'refused', reason: 'checklist' });
		expect(h.device.attempts).toBe(0);
	});

	test('applies at once to the cable RAM only: no journal, flash, written event or marker', async () => {
		const h = await live();
		let flagChanges = 0;
		const stop = onWriteProgress(() => {
			flagChanges += 1;
		});
		try {
			const outcome = await start(h, -12);
			expect(outcome.status).toBe('accepted');
		} finally {
			stop();
		}
		expect(flagChanges).toBeGreaterThanOrEqual(2);
		expect(h.device.sent).toHaveLength(9);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-12));
		expect(h.device.firmware.committed).toBeNull();
		expect(h.device.firmware.appliedCount).toBe(1);
		expectNoWriteBookkeeping(h);
		expect(locksOf(h).requests).toEqual([{ name: CABLE_WRITE_LOCK, granted: true }]);
		expect(locksOf(h).held.size).toBe(0);
		const state = h.service.getState();
		expect(state.liveCapable).toBe(true);
		expect(state.writing).toBe(false);
		expect(state.live).toMatchObject({
			deviceLabel: 'USB DSP Audio',
			status: 'live',
			pending: false,
			hold: null,
			applies: 1,
			total: 1,
			lastError: null
		});
		expect(state.live?.ackLevelDb).toBeCloseTo(levelOf(-12), 9);
		expect(state.live?.applied?.crc).toBe(crcOf(-12));
		expect(state.live?.applied?.levelDb).toBeCloseTo(levelOf(-12), 9);
	});

	test('a second start while a session is active is refused', async () => {
		const h = await live();
		await start(h);
		expect(await start(h, -13)).toMatchObject({ status: 'refused', reason: 'busy' });
	});
});

describe('queueLive pacing', () => {
	test('false without an active session', async () => {
		const h = await live();
		expect(h.service.queueLive(curve(-12))).toBe(false);
		expect(h.device.attempts).toBe(0);
	});

	test('rapid edits: one apply in flight, then only the newest one', async () => {
		const h = await live();
		const starting = start(h, -12);
		expect(h.service.getState().live?.status).toBe('starting');
		// The start apply is in flight: these coalesce into one pending slot.
		expect(h.service.queueLive(curve(-11.5))).toBe(true);
		expect(h.service.queueLive(curve(-11))).toBe(true);
		expect(h.service.queueLive(curve(-10.5))).toBe(true);
		expect(h.service.getState().live?.pending).toBe(true);
		await starting;
		await h.service.whenLiveIdle();
		expect(h.device.sent).toHaveLength(18);
		expect(h.device.firmware.appliedCount).toBe(2);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-10.5));
		const state = h.service.getState().live;
		expect(state?.applies).toBe(2);
		expect(state?.pending).toBe(false);
		expect(state?.applied?.crc).toBe(crcOf(-10.5));
		// Start to start: never sooner than LIVE_MIN_INTERVAL_MS; the debounce ran from the edit.
		const sent = h.device.sent;
		const second = sent[9]?.at ?? 0;
		expect(second - (sent[0]?.at ?? 0)).toBeGreaterThanOrEqual(LIVE_MIN_INTERVAL_MS);
		expect(second).toBeGreaterThanOrEqual(LIVE_DEBOUNCE_MS);
		expectNoWriteBookkeeping(h);
	});

	test('edits after the session settled are debounced into one apply', async () => {
		const h = await live();
		await start(h, -12);
		const before = h.clock.now();
		h.service.queueLive(curve(-11.8));
		h.service.queueLive(curve(-11.6));
		await h.service.whenLiveIdle();
		expect(h.device.firmware.appliedCount).toBe(2);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-11.6));
		expect((h.device.sent[9]?.at ?? 0) - before).toBeGreaterThanOrEqual(LIVE_DEBOUNCE_MS);
	});

	test('a busy write lock keeps the edit pending (no hold) and it is applied once free', async () => {
		const h = await live();
		await start(h, -12);
		locksOf(h).held.add(CABLE_WRITE_LOCK);
		h.service.queueLive(curve(-11));
		await macrotask(20);
		expect(h.device.attempts).toBe(9);
		expect(h.service.getState().live).toMatchObject({ pending: true, hold: null });
		locksOf(h).held.delete(CABLE_WRITE_LOCK);
		await h.service.whenLiveIdle();
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-11));
		expect(h.service.getState().live?.applies).toBe(2);
	});
});

describe('holds', () => {
	test('loudness: measured from the confirmed level, released by confirmLive', async () => {
		const h = await live();
		await start(h, -12);
		// +2.5 dB: sent.
		h.service.queueLive(curve(-9.5));
		await h.service.whenLiveIdle();
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-9.5));
		// +3.5 dB from the confirmed -12 (only +1 from the last apply): held, no I/O.
		h.service.queueLive(curve(-8.5));
		await h.service.whenLiveIdle();
		expect(h.device.attempts).toBe(18);
		let state = h.service.getState().live;
		expect(state?.status).toBe('held');
		expect(state?.hold?.reason).toBe('loudness');
		expect(state?.hold?.deltaDb).toBeCloseTo(levelOf(-8.5) - levelOf(-12), 9);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-9.5));

		expect(await h.service.confirmLive({ gesture: null })).toMatchObject({
			status: 'refused',
			reason: 'gesture'
		});
		const confirmed = await h.service.confirmLive({
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(confirmed.status).toBe('accepted');
		state = h.service.getState().live;
		expect(state?.status).toBe('live');
		expect(state?.hold).toBeNull();
		expect(state?.ackLevelDb).toBeCloseTo(levelOf(-8.5), 9);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-8.5));
		expectNoWriteBookkeeping(h);
	});

	test('a quieter newer edit releases a loudness hold by itself', async () => {
		const h = await live();
		await start(h, -12);
		h.service.queueLive(curve(-6));
		await h.service.whenLiveIdle();
		expect(h.service.getState().live?.hold?.reason).toBe('loudness');
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		expect(h.service.getState().live).toMatchObject({ status: 'live', hold: null });
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-11));
	});

	test('gate: held with its reasons, no I/O, never confirmable', async () => {
		const h = await live();
		await start(h, -12);
		h.service.queueLive(curve(0));
		await h.service.whenLiveIdle();
		expect(h.device.attempts).toBe(9);
		const state = h.service.getState().live;
		expect(state?.status).toBe('held');
		expect(state?.hold?.reason).toBe('gate');
		expect(state?.hold?.gateReasons?.length).toBeGreaterThan(0);
		expect(
			await h.service.confirmLive({ gesture: h.service.createGesture(TRUSTED_CLICK) })
		).toMatchObject({ status: 'refused', reason: 'gate' });
		expect(h.device.attempts).toBe(9);
		// A passing newer edit is evaluated again and sent.
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		expect(h.service.getState().live).toMatchObject({ status: 'live', hold: null });
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-11));
	});

	test('confirmLive without a hold is refused', async () => {
		const h = await live();
		await start(h, -12);
		expect(
			await h.service.confirmLive({ gesture: h.service.createGesture(TRUSTED_CLICK) })
		).toMatchObject({ status: 'refused', reason: 'no-hold' });
	});
});

describe('apply failures', () => {
	test('report 8 attempted but failed: unknown state, held until confirmed', async () => {
		const h = await live();
		await start(h, -12);
		// Attempts 0..8 were the start apply; attempt 17 is report 8 of the next one.
		h.device.faults.throwAtReport = 17;
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		let state = h.service.getState().live;
		expect(state?.status).toBe('unknown');
		expect(state?.hold?.reason).toBe('unknown-state');
		expect(state?.lastError).toBeInstanceOf(DOMException);
		expect(h.device.attempts).toBe(18);
		// Newer edits wait behind the unknown state (no I/O, never retried automatically).
		h.service.queueLive(curve(-11.5));
		await h.service.whenLiveIdle();
		expect(h.device.attempts).toBe(18);
		expect(h.service.getState().live?.status).toBe('unknown');
		const confirmed = await h.service.confirmLive({
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(confirmed.status).toBe('accepted');
		state = h.service.getState().live;
		expect(state?.status).toBe('live');
		expect(state?.hold).toBeNull();
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-11.5));
		expectNoWriteBookkeeping(h);
	});

	test('interrupted before report 8: the cable keeps the previous curve, no retry', async () => {
		const h = await live();
		await start(h, -12);
		h.device.faults.throwAtReport = 12;
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		const state = h.service.getState().live;
		expect(state?.status).toBe('live');
		expect(state?.hold).toBeNull();
		expect(state?.applied?.crc).toBe(crcOf(-12));
		expect(state?.lastError).toBeInstanceOf(DOMException);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-12));
		expect(h.device.firmware.appliedCount).toBe(1);
		await macrotask(10);
		expect(h.device.attempts).toBe(13);
	});
});

describe('end of a session', () => {
	test('an unplug during the session ends it; nothing is re-applied', async () => {
		const h = await live();
		await start(h, -12);
		h.hid.disconnect(h.device);
		const state = h.service.getState().live;
		expect(state).toMatchObject({ status: 'ended', endedReason: 'disconnected' });
		expect(h.service.queueLive(curve(-11))).toBe(false);
		await h.service.whenLiveIdle();
		expect(h.device.attempts).toBe(9);
	});

	test('an unplug during an apply ends the session', async () => {
		const h = await live();
		await start(h, -12);
		h.device.faults.disconnectAtReport = 12;
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		expect(h.service.getState().live).toMatchObject({
			status: 'ended',
			endedReason: 'disconnected'
		});
	});

	test('replug: the cable plays the saved curve again and the session has ended', async () => {
		const h = await live();
		await start(h, -12);
		const saved = await save(h, -13);
		expect(saved.status).toBe('ok');
		h.service.queueLive(curve(-12.5));
		await h.service.whenLiveIdle();
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-12.5));
		expect(payloadCrc(h.device.firmware.committed)).toBe(crcOf(-13));
		const fresh = h.hid.replug(h.device);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-13));
		expect(h.service.getState().live).toMatchObject({
			status: 'ended',
			endedReason: 'disconnected'
		});
		await h.service.whenLiveIdle();
		await macrotask(10);
		expect(fresh.attempts).toBe(0);
	});

	test('stopLive without revert leaves the live curve; with revert applies the saved one', async () => {
		const h = await live();
		await start(h, -12);
		const stopped = await h.service.stopLive({ revert: false });
		expect(stopped.status).toBe('accepted');
		expect(h.service.getState().live).toMatchObject({ status: 'ended', endedReason: 'stopped' });
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-12));
		expect(await h.service.stopLive({ revert: false })).toMatchObject({ reason: 'no-session' });

		await start(h, -11);
		const reverted = await h.service.stopLive({
			revert: true,
			gesture: h.service.createGesture(TRUSTED_CLICK),
			saved: curve(-14)
		});
		expect(reverted.status).toBe('accepted');
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-14));
		expect(h.service.getState().live).toMatchObject({ status: 'ended', endedReason: 'reverted' });
		expectNoWriteBookkeeping(h);
	});

	test('revertLive: refused without a saved curve, else applies the last save', async () => {
		const h = await live();
		await start(h, -12);
		expect(
			await h.service.revertLive({ gesture: h.service.createGesture(TRUSTED_CLICK) })
		).toMatchObject({ status: 'refused', reason: 'no-saved-curve' });
		expect(await h.service.revertLive({ gesture: null })).toMatchObject({ reason: 'gesture' });
		await save(h, -13);
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-11));
		const reverted = await h.service.revertLive({
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(reverted.status).toBe('accepted');
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-13));
		expect(h.service.getState().live?.ackLevelDb).toBeCloseTo(levelOf(-13), 9);
	});

	test('dispose stops the scheduler and leaves no lock held', async () => {
		const h = await setup();
		const starting = start(h, -12);
		h.service.queueLive(curve(-11));
		h.service.dispose();
		await starting;
		await macrotask(20);
		expect(locksOf(h).held.has(CABLE_WRITE_LOCK)).toBe(false);
		expect(h.clock.pending()).toBe(0);
		expect(h.device.firmware.appliedCount).toBeLessThanOrEqual(1);
	});
});

describe('Salvar during a live session', () => {
	test('waits for the apply in flight, commits once and journals exactly one entry', async () => {
		const h = await live();
		const starting = start(h, -12);
		// The start apply is in flight: the write must wait for it, not fail.
		const outcome = await save(h, -12);
		await starting;
		expect(outcome.status).toBe('ok');
		expect((outcome as Written).result.committed).toBe(true);
		expect(h.device.sent).toHaveLength(19);
		expect(h.device.firmware.commitCount).toBe(1);
		expect(payloadCrc(h.device.firmware.committed)).toBe(liveCrc(h.device.firmware));
		expect(payloadCrc(h.device.firmware.committed)).toBe(crcOf(-12));
		expect(h.journal.entries).toHaveLength(1);
		expect(h.written).toHaveLength(1);
		expect(h.flash.records).toHaveLength(1);
		const state = h.service.getState().live;
		expect(state?.status).toBe('live');
		expect(state?.applied?.crc).toBe(crcOf(-12));
		expect(state?.ackLevelDb).toBeCloseTo(levelOf(-12), 9);
	});

	test('the committed curve becomes the live reference and the next apply waits 2 s', async () => {
		const h = await live();
		await start(h, -12);
		await h.service.whenLiveIdle();
		const saved = await save(h, -10);
		expect(saved.status).toBe('ok');
		const state = h.service.getState().live;
		expect(state?.applied?.crc).toBe(crcOf(-10));
		expect(state?.ackLevelDb).toBeCloseTo(levelOf(-10), 9);
		h.service.queueLive(curve(-9));
		await h.service.whenLiveIdle();
		const sent = h.device.sent;
		expect(sent).toHaveLength(28);
		const commitAt = sent[18]?.at ?? 0;
		expect((sent[19]?.at ?? 0) - commitAt).toBeGreaterThanOrEqual(LIVE_AFTER_COMMIT_MS);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-9));
		expect(payloadCrc(h.device.firmware.committed)).toBe(crcOf(-10));
		expect(h.journal.entries).toHaveLength(1);
		expect(h.written).toHaveLength(1);
	});

	test('the X9 queue is refused while a session is active', async () => {
		const h = await live();
		await start(h, -12);
		const outcome = await h.service.writeQueue({
			bands: OFF_BANDS,
			preampDb: -12,
			experimental: false,
			confirmations: CONFIRMED,
			gesture: h.service.createGesture(TRUSTED_CLICK),
			devices: [h.device]
		});
		expect(outcome).toMatchObject({ status: 'refused', reason: 'busy' });
	});
});

describe('S7: loudness of a write against what the cable plays', () => {
	test('the checklist compares with the live level during a session', async () => {
		const h = await live({ lastWrittenLevelDb: -30, sessionWriteCount: 1 });
		const request = {
			bands: OFF_BANDS,
			preampDb: -11,
			experimental: false,
			confirmations: CONFIRMED
		};
		expect(h.service.checklist(request).loudness.deltaDb).toBeCloseTo(levelOf(-11) + 30, 9);
		expect(h.service.checklist(request).loudness.reasons).toContain('jump');
		await start(h, -12);
		const during = h.service.checklist(request).loudness;
		expect(during.deltaDb).toBeCloseTo(levelOf(-11) - levelOf(-12), 9);
		expect(during.reasons).not.toContain('jump');
		await h.service.stopLive({ revert: false });
		expect(h.service.checklist(request).loudness.deltaDb).toBeCloseTo(levelOf(-11) + 30, 9);
	});
});

describe('capability', () => {
	test('kill switch: not live-capable and startLive refused', async () => {
		const h = await live({ livePolicy: { enabled: false } });
		expect(h.service.getState().liveCapable).toBe(false);
		expect(await start(h)).toMatchObject({ status: 'refused', reason: 'unavailable' });
		expect(h.device.attempts).toBe(0);
	});

	test('simulated mode: the in-memory cable plays it, flash counters untouched', async () => {
		const h = await live({ hid: null });
		expect(h.service.mode).toBe('simulated');
		expect(h.service.getState().liveCapable).toBe(true);
		const before = h.service.counters();
		const outcome = await start(h, -12);
		expect(outcome.status).toBe('accepted');
		expect(h.service.getState().live).toMatchObject({ status: 'live', applies: 1 });
		const device = h.service.getState().device as unknown as FakeHIDDevice;
		expect(liveCrc(device.firmware)).toBe(crcOf(-12));
		expect(device.firmware.commitCount).toBe(0);
		expect(h.service.counters()).toEqual(before);
		expect(h.journal.entries).toEqual([]);
	});

	function nativeService(extra: { nativeLiveApply?: boolean } = {}) {
		const hid = new FakeHID({ devices: [new FakeHIDDevice()] });
		Object.defineProperty(hid, NATIVE_HID_BRAND, { value: true });
		const service = createCableService({
			hid,
			journal: memoryJournal(),
			flash: memoryFlash(),
			now: () => T0,
			lastWrittenLevelDb: () => null,
			sessionWriteCount: () => 0,
			userActivation: () => ({ isActive: true }),
			locks: memoryLocks(),
			inflight: memoryInflight(),
			...extra
		});
		cleanup.push(() => service.dispose());
		return service;
	}

	test('native without the liveApply capability is not live-capable', async () => {
		const service = nativeService();
		await service.connect();
		expect(service.getState().liveCapable).toBe(false);
		const outcome = await service.startLive({
			curve: curve(-12),
			confirmations: { volumeLowered: true, androidUntested: true },
			gesture: service.createGesture(TRUSTED_CLICK)
		});
		expect(outcome).toMatchObject({ status: 'refused', reason: 'unavailable' });
	});

	test('native with the capability is live-capable', () => {
		expect(nativeService({ nativeLiveApply: true }).getState().liveCapable).toBe(true);
	});
});
