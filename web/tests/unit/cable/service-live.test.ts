/**
 * Live (no-flash) preview session of the cable service (issues #67 S4 and #70 S7): live applies
 * reach the cable's RAM only, never the journal, the flash counters, `cable:written` or the
 * in-flight marker; holds, pacing, Salvar serialization and the end of a session.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { FakeHID, FakeHIDDevice, type FakeFirmware } from 'open-auri/transport';
import { gateForWrite, levelDb } from 'open-auri/safety';
import { LIVE_AFTER_COMMIT_MS, LIVE_DEBOUNCE_MS, LIVE_MIN_INTERVAL_MS } from 'open-auri/policy';
import {
	CABLE_LIVE_LOCK,
	CABLE_WRITE_LOCK,
	LIVE_BUSY_BACKOFF_MS,
	LIVE_BUSY_MAX_ATTEMPTS,
	createCableService
} from '../../../src/lib/cable/service.ts';
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
import { memoryInflight, memoryLocks, type MemoryLocks } from './locks-fake.ts';

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

/**
 * The next `times` write-lock requests find it busy (another tab holds it); records when each
 * busy attempt happened on the transport clock.
 */
function busyWrites(h: Harness, times: number) {
	const base = locksOf(h);
	const original = base.request.bind(base);
	const at: number[] = [];
	let left = times;
	const request: MemoryLocks['request'] = (name, options, callback) => {
		if (name === CABLE_WRITE_LOCK && options.ifAvailable === true && left > 0) {
			left -= 1;
			at.push(h.clock.now());
			return callback(null);
		}
		return original(name, options, callback);
	};
	Object.assign(base, { request });
	return { at };
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
		// S5: the session lock and this tab's liveness lock, then the write lock for the apply.
		expect(locksOf(h).requests).toEqual([
			{ name: CABLE_LIVE_LOCK, granted: true },
			{ name: expect.stringMatching(/^oa-cable-alive:/) as unknown as string, granted: true },
			{ name: CABLE_WRITE_LOCK, granted: true }
		]);
		expect(locksOf(h).held.has(CABLE_WRITE_LOCK)).toBe(false);
		expect(locksOf(h).held.has(CABLE_LIVE_LOCK)).toBe(true);
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

	test('a busy write lock keeps the edit pending (no hold), backs off and applies once free', async () => {
		const h = await live();
		await start(h, -12);
		const busy = busyWrites(h, 2);
		const statuses: string[] = [];
		const stop = h.service.subscribe((state) => statuses.push(state.live?.status ?? 'none'));
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		stop();
		expect(busy.at).toHaveLength(2);
		const third = h.device.sent[9]?.at ?? 0;
		// 300 ms after the first busy attempt, then 600 ms after the second.
		expect((busy.at[1] ?? 0) - (busy.at[0] ?? 0)).toBeGreaterThanOrEqual(LIVE_BUSY_BACKOFF_MS);
		expect(third - (busy.at[1] ?? 0)).toBeGreaterThanOrEqual(2 * LIVE_BUSY_BACKOFF_MS);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-11));
		expect(h.service.getState().live).toMatchObject({ applies: 2, hold: null, lastError: null });
		// No "live" flicker between the attempts: it stays "applying" until the apply settled.
		const firstApplying = statuses.indexOf('applying');
		expect(firstApplying).toBeGreaterThanOrEqual(0);
		expect(statuses.slice(firstApplying, -1)).not.toContain('live');
		expect(statuses.at(-1)).toBe('live');
	});

	test('a lock that stays busy: capped, the edit is dropped with lastError busy', async () => {
		const h = await live();
		await start(h, -12);
		const busy = busyWrites(h, Number.POSITIVE_INFINITY);
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		expect(busy.at).toHaveLength(LIVE_BUSY_MAX_ATTEMPTS);
		expect(h.device.attempts).toBe(9);
		expect(h.service.getState().live).toMatchObject({
			status: 'live',
			pending: false,
			hold: null,
			lastError: 'busy'
		});
		// A confirmed curve's promise settles as refused busy instead of hanging.
		const reverted = await h.service.revertLive({
			gesture: h.service.createGesture(TRUSTED_CLICK),
			saved: curve(-14)
		});
		expect(reverted).toMatchObject({
			status: 'refused',
			reason: 'revert-failed',
			revertFailure: 'busy'
		});
	});

	test('startLive on a lock that stays busy settles refused busy; the session never started', async () => {
		const h = await live();
		busyWrites(h, Number.POSITIVE_INFINITY);
		expect(await start(h, -12)).toMatchObject({ status: 'refused', reason: 'busy' });
		expect(h.service.getState().live).toBeNull();
		expect(locksOf(h).held.has(CABLE_LIVE_LOCK)).toBe(false);
		expect(h.device.attempts).toBe(0);
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
		expect(locksOf(h).held.has(CABLE_LIVE_LOCK)).toBe(false);
		expect(h.clock.pending()).toBe(0);
		expect(h.device.firmware.appliedCount).toBeLessThanOrEqual(1);
		// The -11 edit was never sent: at most the start curve's 9 reports.
		expect(h.device.sent.length).toBeLessThanOrEqual(9);
		expect(liveCrc(h.device.firmware)).not.toBe(crcOf(-11));
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

	test('a real cable without Web Locks is not live-capable (S5)', async () => {
		const h = await live({ locks: null });
		expect(h.service.mode).toBe('real');
		expect(h.service.getState().liveCapable).toBe(false);
		expect(await start(h)).toMatchObject({ status: 'refused', reason: 'unavailable' });
		expect(h.device.attempts).toBe(0);
	});
});

function hsCurve(preampDb = -12): LiveCurve {
	return {
		bands: [{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 }, ...OFF_BANDS.slice(1)],
		preampDb
	};
}

describe('QA fixes (#67/#70)', () => {
	test('1: an experimental edit is held unless the start checklist confirmed it', async () => {
		const h = await live();
		// Experimental gate option on, but the start curve needs no experimental confirmation.
		const started = await h.service.startLive({
			curve: { ...curve(-12), experimental: true },
			confirmations: { volumeLowered: true },
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(started.status).toBe('accepted');
		h.service.queueLive(hsCurve());
		await h.service.whenLiveIdle();
		expect(h.device.attempts).toBe(9);
		expect(h.service.getState().live).toMatchObject({
			status: 'held',
			hold: { reason: 'experimental' }
		});
		// The confirmation must come with it.
		expect(
			await h.service.confirmLive({ gesture: h.service.createGesture(TRUSTED_CLICK) })
		).toMatchObject({ status: 'refused', reason: 'checklist' });
		expect(h.device.attempts).toBe(9);
		const confirmed = await h.service.confirmLive({
			gesture: h.service.createGesture(TRUSTED_CLICK),
			confirmations: { experimental: true }
		});
		expect(confirmed.status).toBe('accepted');
		await h.service.whenLiveIdle();
		expect(h.service.getState().live).toMatchObject({ status: 'live', hold: null, applies: 2 });
		const expected = gateForWrite(hsCurve().bands, -12, { experimental: true });
		expect(liveCrc(h.device.firmware)).toBe(Number(expected.metrics.payloadCrc));
	});

	test('1: a start checklist that confirmed experimental filters lets later ones through', async () => {
		const h = await live();
		await h.service.startLive({
			curve: { ...hsCurve(), experimental: true },
			confirmations: { volumeLowered: true, experimental: true },
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		h.service.queueLive(hsCurve(-12.5));
		await h.service.whenLiveIdle();
		expect(h.service.getState().live).toMatchObject({ status: 'live', hold: null, applies: 2 });
	});

	test('2: stopLive with a held revert is not "reverted": the session goes on', async () => {
		const h = await live();
		await start(h, -12);
		// The saved curve fails the session's gate (HS without the experimental option): held.
		const outcome = await h.service.stopLive({
			revert: true,
			gesture: h.service.createGesture(TRUSTED_CLICK),
			saved: hsCurve()
		});
		expect(outcome).toMatchObject({
			status: 'refused',
			reason: 'revert-failed',
			revertFailure: 'held'
		});
		const state = h.service.getState().live;
		expect(state?.status).toBe('held');
		expect(state?.endedReason).toBeUndefined();
		expect(state?.ackLevelDb).toBeCloseTo(levelOf(-12), 9);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-12));
	});

	test('2: a revert whose report 8 failed is "unknown", not reverted; ack level unchanged', async () => {
		const h = await live();
		await start(h, -12);
		h.device.faults.throwAtReport = 17;
		const outcome = await h.service.stopLive({
			revert: true,
			gesture: h.service.createGesture(TRUSTED_CLICK),
			saved: curve(-14)
		});
		expect(outcome).toMatchObject({ reason: 'revert-failed', revertFailure: 'unknown' });
		expect(h.service.getState().live).toMatchObject({ status: 'unknown' });
		expect(h.service.getState().live?.ackLevelDb).toBeCloseTo(levelOf(-12), 9);
	});

	test('3: after an X9 queue (or another tab\'s write) the first apply waits 2 s', async () => {
		const h = await live();
		const queued = await h.service.writeQueue({
			bands: OFF_BANDS,
			preampDb: -13,
			experimental: false,
			confirmations: CONFIRMED,
			gesture: h.service.createGesture(TRUSTED_CLICK),
			devices: [h.device]
		});
		expect(queued.status).toBe('done');
		const ended = h.clock.now();
		await start(h, -12);
		expect((h.device.sent[10]?.at ?? 0) - ended).toBeGreaterThanOrEqual(LIVE_AFTER_COMMIT_MS);
	});

	test('3: the shared flash state of another tab delays the apply too', async () => {
		const h = await live();
		// Another tab's write sequence just ended (shared flash bookkeeping).
		h.flash.touch(T0);
		const before = h.clock.now();
		await start(h, -12);
		expect((h.device.sent[0]?.at ?? 0) - before).toBeGreaterThanOrEqual(LIVE_AFTER_COMMIT_MS);
	});

	test('4: S7 uses the live level only for the cable a write would go to', async () => {
		const h = await live({ lastWrittenLevelDb: -30, sessionWriteCount: 1 });
		await start(h, -12);
		const other = new FakeHIDDevice({ clock: h.clock, productName: 'Outro cabo' });
		h.hid.addDevice(other);
		await h.service.restore();
		const request = { bands: OFF_BANDS, preampDb: -11, experimental: false, confirmations: CONFIRMED };
		expect(h.service.checklist(request).loudness.deltaDb).toBeCloseTo(
			levelOf(-11) - levelOf(-12),
			9
		);
		expect(h.service.selectDevice(other)).toBe(true);
		expect(h.service.checklist(request).loudness.deltaDb).toBeCloseTo(levelOf(-11) + 30, 9);
	});

	test('settle error: the state becomes unknown and is held', async () => {
		const flags = { failSettle: false };
		const h = await live({
			wrapClock: (clock) => ({
				now: () => clock.now(),
				sleep: (ms, signal) =>
					flags.failSettle && signal === undefined
						? Promise.reject(new Error('clock broke'))
						: clock.sleep(ms, signal)
			})
		});
		await start(h, -12);
		flags.failSettle = true;
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		flags.failSettle = false;
		const state = h.service.getState().live;
		expect(state).toMatchObject({ status: 'unknown', hold: { reason: 'unknown-state' } });
		expect(state?.lastError).toBeInstanceOf(Error);
	});

	test('disconnect during the settle ends the session and removes the marker', async () => {
		const flags = { unplug: false };
		let h: Harness | null = null;
		h = await live({
			wrapClock: (clock) => ({
				now: () => clock.now(),
				sleep: (ms, signal) => {
					if (flags.unplug && signal === undefined && h !== null) {
						flags.unplug = false;
						h.hid.disconnect(h.device);
					}
					return clock.sleep(ms, signal);
				}
			})
		});
		await start(h, -12);
		expect(h.liveMarker.value).not.toBeNull();
		flags.unplug = true;
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		expect(h.service.getState().live).toMatchObject({
			status: 'ended',
			endedReason: 'disconnected'
		});
		expect(h.liveMarker.value).toBeNull();
	});

	test('Salvar interrupted after report 8: the live state becomes unknown', async () => {
		const h = await live();
		await start(h, -12);
		// Attempts 9..17 are the save's data reports, 18 its commit.
		h.device.faults.throwAtReport = 18;
		const saved = await save(h, -12.5);
		expect(saved.status).toBe('interrupted');
		expect(h.service.getState().live).toMatchObject({
			status: 'unknown',
			hold: { reason: 'unknown-state' }
		});
	});

	test('10: a held edit is evaluated again after Salvar, unless it is the saved curve', async () => {
		const h = await live();
		await start(h, -12);
		h.service.queueLive(curve(-8));
		await h.service.whenLiveIdle();
		expect(h.service.getState().live?.hold?.reason).toBe('loudness');
		// Saved something else: the held -8 is queued again and held against the new level.
		expect((await save(h, -12.5)).status).toBe('ok');
		await h.service.whenLiveIdle();
		expect(h.service.getState().live?.hold?.reason).toBe('loudness');

		// Saved the held curve itself (after the flash spacing): nothing to re-apply.
		h.time.value += 5_000;
		expect((await save(h, -8)).status).toBe('ok');
		const sent = h.device.sent.length;
		await h.service.whenLiveIdle();
		expect(h.service.getState().live).toMatchObject({ status: 'live', hold: null });
		expect(h.device.sent).toHaveLength(sent);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-8));
	});

	test('Modo YOLO turned off mid-session: the next YOLO curve is held (gate)', async () => {
		const options = { yoloSession: true };
		const h = await live(options);
		const started = await h.service.startLive({
			curve: { ...curve(-12), profile: 'yolo' },
			confirmations: { volumeLowered: true, yoloWrite: true },
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(started.status).toBe('accepted');
		options.yoloSession = false;
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		expect(h.device.attempts).toBe(9);
		expect(h.service.getState().live).toMatchObject({
			status: 'held',
			hold: { reason: 'gate', gateReasons: [] }
		});
	});

	test('8: a first attempt that fails before report 8 leaves "starting"', async () => {
		const h = await live();
		h.device.faults.throwAtReport = 3;
		const outcome = await start(h, -12);
		expect(outcome.status).toBe('accepted');
		expect(h.service.getState().live).toMatchObject({ status: 'live', applied: null });
		expect(h.service.getState().live?.lastError).toBeInstanceOf(DOMException);
	});

	test('8: an unknown state stays unknown after a confirmed apply that failed early', async () => {
		const h = await live();
		await start(h, -12);
		h.device.faults.throwAtReport = 17;
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		expect(h.service.getState().live?.status).toBe('unknown');
		h.device.faults.throwAtReport = 20;
		await h.service.confirmLive({ gesture: h.service.createGesture(TRUSTED_CLICK) });
		await h.service.whenLiveIdle();
		expect(h.service.getState().live).toMatchObject({
			status: 'unknown',
			hold: { reason: 'unknown-state' }
		});
	});

	test('11: the revert target is per cable; a save to another cable is not one', async () => {
		const h = await live();
		const other = new FakeHIDDevice({ clock: h.clock, productName: 'Outro cabo' });
		h.hid.addDevice(other);
		await h.service.restore();
		expect(h.service.selectDevice(other)).toBe(true);
		expect((await save(h, -13)).status).toBe('ok');
		expect(h.service.selectDevice(h.device)).toBe(true);
		await start(h, -12);
		expect(
			await h.service.revertLive({ gesture: h.service.createGesture(TRUSTED_CLICK) })
		).toMatchObject({ status: 'refused', reason: 'no-saved-curve' });
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-12));
	});
});
