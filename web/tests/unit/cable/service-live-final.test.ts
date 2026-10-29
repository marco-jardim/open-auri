/**
 * Final adversarial QA of the live (no-flash) preview (#62/#67/#69/#71/#72): a revert and an
 * unknown-state "Reaplicar" honour the loudness hold; an ended session whose curve the cable kept
 * follows a later unplug or save; an orphan preview is cleared by a replug or "Já desconectei";
 * live "Salvar" targets the session's cable; the session cable's own saved curve.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { FakeHIDDevice, type FakeFirmware } from 'open-auri/transport';
import { gateForWrite, levelDb } from 'open-auri/safety';
import { browserFlat, liveSavable, liveUnsaved } from '#lib/components/cable/live.ts';
import type { Band, JournalEntry, LiveCurve } from '../../../src/lib/cable/types.ts';
import { CONFIRMED, T0, TRUSTED_CLICK, off, setup, type SetupOptions } from './harness.ts';
import { memoryInflight, memoryLocks, type MemoryInflight } from './locks-fake.ts';

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

function liveCrc(firmware: FakeFirmware): number | null {
	const payload = firmware.live;
	if (payload === null) return null;
	return (payload[218] ?? 0) | ((payload[219] ?? 0) << 8);
}

/** An `ok` journal entry: the cable `device` holds `preampDb` (flat) in flash. */
function savedEntry(preampDb: number, device = 'USB DSP Audio'): JournalEntry {
	return {
		schema: 1,
		at: T0 - 60_000,
		name: 'Salvo',
		crc: crcOf(preampDb),
		preampDb,
		bands: OFF_BANDS,
		status: 'ok',
		device
	};
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

function gesture(h: Harness) {
	return h.service.createGesture(TRUSTED_CLICK);
}

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

let cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup) dispose();
	cleanup = [];
});

async function live(options: SetupOptions = {}): Promise<Harness> {
	const h = await setup(options);
	cleanup.push(() => h.service.dispose());
	return h;
}

/** Tabs of one origin: shared lock `held` set, live marker and in-flight marker. */
function origin() {
	const held = new Set<string>();
	const liveMarker: MemoryInflight = memoryInflight();
	const inflight = memoryInflight();
	return {
		liveMarker,
		tab(tabId: string, options: SetupOptions = {}) {
			return live({ locks: memoryLocks(held), liveMarker, inflight, tabId, ...options });
		}
	};
}

describe('1: a revert honours the loudness hold', () => {
	test('a louder saved curve (-2) while live at -12 is held, sent only after confirmLive', async () => {
		const journal = [savedEntry(-2)];
		const h = await live({ journal });
		await start(h, -12);
		const attempts = h.device.attempts;

		const reverted = await h.service.revertLive({ gesture: gesture(h), saved: curve(-2) });
		expect(reverted).toMatchObject({
			status: 'refused',
			reason: 'revert-failed',
			revertFailure: 'held'
		});
		let state = h.service.getState().live;
		expect(state?.status).toBe('held');
		expect(state?.hold).toMatchObject({ reason: 'loudness', curve: 'saved' });
		expect(state?.hold?.deltaDb).toBeCloseTo(levelOf(-2) - levelOf(-12), 9);

		// Turning the preview off with a revert is refused the same way: the session goes on.
		const stopped = await h.service.stopLive({
			revert: true,
			gesture: gesture(h),
			saved: curve(-2)
		});
		expect(stopped).toMatchObject({ reason: 'revert-failed', revertFailure: 'held' });
		await h.service.whenLiveIdle();
		state = h.service.getState().live;
		expect(state?.endedReason).toBeUndefined();
		expect(state?.ackLevelDb).toBeCloseTo(levelOf(-12), 9);
		// Nothing was sent.
		expect(h.device.attempts).toBe(attempts);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-12));

		const confirmed = await h.service.confirmLive({ gesture: gesture(h) });
		expect(confirmed.status).toBe('accepted');
		state = h.service.getState().live;
		expect(state).toMatchObject({ status: 'live', hold: null });
		expect(state?.ackLevelDb).toBeCloseTo(levelOf(-2), 9);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-2));
		// The saved curve plays again: the preview marker is gone.
		expect(h.liveMarker.value).toBeNull();
		expect(h.journal.entries).toEqual(journal);
		expect(h.device.firmware.commitCount).toBe(0);

		// Now at the confirmed level, turning off with a revert goes through.
		const ended = await h.service.stopLive({
			revert: true,
			gesture: gesture(h),
			saved: curve(-2)
		});
		expect(ended.status).toBe('accepted');
		expect(h.service.getState().live).toMatchObject({
			status: 'ended',
			endedReason: 'reverted'
		});
	});

	test('a quieter saved curve is still reverted at once', async () => {
		const h = await live({ journal: [savedEntry(-14)] });
		await start(h, -12);
		const reverted = await h.service.revertLive({ gesture: gesture(h), saved: curve(-14) });
		expect(reverted.status).toBe('accepted');
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-14));
	});
});

describe('2: "Reaplicar" after an unknown state honours the loudness hold', () => {
	test('report 8 failed, then a louder edit: reapply turns into a loudness hold', async () => {
		const h = await live();
		await start(h, -12);
		h.device.faults.throwAtReport = 17;
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		expect(h.service.getState().live?.hold?.reason).toBe('unknown-state');
		// The newest edit (+6 dB) waits behind the unknown state.
		h.service.queueLive(curve(-6));
		await h.service.whenLiveIdle();
		const attempts = h.device.attempts;

		const reapplied = await h.service.confirmLive({ gesture: gesture(h) });
		expect(reapplied).toMatchObject({ status: 'refused', reason: 'loudness' });
		await h.service.whenLiveIdle();
		let state = h.service.getState().live;
		expect(state?.hold).toMatchObject({ reason: 'loudness' });
		expect(state?.hold?.curve).toBeUndefined();
		expect(state?.hold?.deltaDb).toBeCloseTo(levelOf(-6) - levelOf(-12), 9);
		expect(state?.ackLevelDb).toBeCloseTo(levelOf(-12), 9);
		expect(h.device.attempts).toBe(attempts);

		const confirmed = await h.service.confirmLive({ gesture: gesture(h) });
		expect(confirmed.status).toBe('accepted');
		state = h.service.getState().live;
		expect(state).toMatchObject({ status: 'live', hold: null });
		expect(state?.ackLevelDb).toBeCloseTo(levelOf(-6), 9);
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-6));
	});

	test('a reapply within 3 dB is sent at once', async () => {
		const h = await live();
		await start(h, -12);
		h.device.faults.throwAtReport = 17;
		h.service.queueLive(curve(-11));
		await h.service.whenLiveIdle();
		const confirmed = await h.service.confirmLive({ gesture: gesture(h) });
		expect(confirmed.status).toBe('accepted');
		expect(liveCrc(h.device.firmware)).toBe(crcOf(-11));
	});

	test("another tab's in-flight marker, then a louder edit: reapply is a loudness hold", async () => {
		const o = origin();
		const a = await o.tab('tab-a');
		await start(a, -12);
		a.inflight.value = JSON.stringify({
			at: 0,
			crc: 1,
			name: 'x',
			preampDb: -12,
			bands: OFF_BANDS,
			device: 'USB DSP Audio',
			tabId: 'closed-tab'
		});
		a.service.queueLive(curve(-11));
		await a.service.whenLiveIdle();
		expect(a.service.getState().live?.hold?.reason).toBe('unknown-state');
		a.service.queueLive(curve(-6));
		await a.service.whenLiveIdle();
		const attempts = a.device.attempts;
		expect(await a.service.confirmLive({ gesture: gesture(a) })).toMatchObject({
			status: 'refused',
			reason: 'loudness'
		});
		await a.service.whenLiveIdle();
		expect(a.device.attempts).toBe(attempts);
		expect(a.service.getState().live?.hold?.reason).toBe('loudness');
		expect((await a.service.confirmLive({ gesture: gesture(a) })).status).toBe('accepted');
		expect(liveCrc(a.device.firmware)).toBe(crcOf(-6));
	});
});

describe('3: an ended session whose curve the cable kept', () => {
	test('stopped, then unplugged: ended as disconnected, no chip, browser EQ back, no Save', async () => {
		const h = await live({ journal: [savedEntry(-14)] });
		await start(h, -12);
		await h.service.stopLive({ revert: false });
		let state = h.service.getState();
		expect(state.live).toMatchObject({ status: 'ended', endedReason: 'stopped' });
		expect(liveUnsaved(state.live, null)).toBe(true);
		expect(browserFlat(state, null)).toBe(true);
		expect(liveSavable(state)).toBe(true);

		let emits = 0;
		const stop = h.service.subscribe(() => (emits += 1));
		const before = emits;
		h.hid.disconnect(h.device);
		stop();
		expect(emits).toBeGreaterThan(before);
		state = h.service.getState();
		expect(state.live).toMatchObject({ status: 'ended', endedReason: 'disconnected' });
		expect(liveUnsaved(state.live, null)).toBe(false);
		expect(browserFlat(state, null)).toBe(false);
		expect(liveSavable(state)).toBe(false);
		expect(h.liveMarker.value).toBeNull();
	});

	test('forgotten, then unplugged: ended as disconnected too', async () => {
		const h = await live();
		await start(h, -12);
		expect(await h.service.disconnect(h.device)).toBe(true);
		let state = h.service.getState();
		expect(state.live).toMatchObject({ status: 'ended', endedReason: 'forgotten' });
		expect(liveUnsaved(state.live, null)).toBe(true);
		// Not connected to the page any more: nothing to save it to.
		expect(liveSavable(state)).toBe(false);
		h.hid.disconnect(h.device);
		state = h.service.getState();
		expect(state.live).toMatchObject({ endedReason: 'disconnected' });
		expect(liveUnsaved(state.live, null)).toBe(false);
	});

	test('stopped, then saved to that cable: it plays the saved curve, no chip', async () => {
		const h = await live({ journal: [savedEntry(-14)] });
		await start(h, -12);
		await h.service.stopLive({ revert: false });
		h.time.value += 5_000;
		expect((await save(h, -13)).status).toBe('ok');
		const state = h.service.getState();
		expect(state.live?.applied?.crc).toBe(crcOf(-13));
		expect(state.live?.savedCrc).toBe(crcOf(-13));
		expect(liveUnsaved(state.live, curve(-13))).toBe(false);
		expect(browserFlat(state, curve(-13))).toBe(false);
	});

	test('stopped, then the same curve saved to another cable: the chip stays', async () => {
		const h = await live({ journal: [savedEntry(-14)] });
		const other = new FakeHIDDevice({ clock: h.clock, productName: 'Outro cabo' });
		h.hid.addDevice(other);
		await h.service.restore();
		await start(h, -12);
		await h.service.stopLive({ revert: false });
		expect(h.service.selectDevice(other)).toBe(true);
		h.time.value += 5_000;
		expect((await save(h, -12)).status).toBe('ok');
		const state = h.service.getState();
		// The kept cable still plays the -12 preview; its own saved curve is still -14.
		expect(state.live?.applied?.crc).toBe(crcOf(-12));
		expect(state.live?.savedCrc).toBe(crcOf(-14));
		// The page's last written curve is -12 (the other cable's): it is not this cable's.
		expect(liveUnsaved(state.live, curve(-12))).toBe(true);
		expect(browserFlat(state, curve(-12))).toBe(true);
		// The target is the other cable: "Salvar a curva que está tocando" is not offered.
		expect(liveSavable(state)).toBe(false);
		expect(h.service.selectDevice(h.device)).toBe(true);
		expect(liveSavable(h.service.getState())).toBe(true);
	});
});

describe('4: orphan preview', () => {
	async function orphaned(options: SetupOptions = {}) {
		const o = origin();
		const a = await o.tab('tab-a');
		await start(a, -12);
		await a.service.stopLive({ revert: false });
		a.service.dispose();
		await macrotask();
		const c = await o.tab('tab-c', options);
		expect(c.service.getState().liveOrphan).toMatchObject({ crc: crcOf(-12) });
		expect(o.liveMarker.value).not.toBeNull();
		return { o, c };
	}

	test('a replug (connect event) clears it, even when its unplug was not seen', async () => {
		const { o, c } = await orphaned({ connect: false });
		// The cable is not connected to this page: the browser EQ stays on.
		expect(browserFlat(c.service.getState(), null)).toBe(false);
		// Unplugged and plugged in again: this page only sees the connect.
		const fresh = c.hid.replug(c.device);
		expect(c.service.getState().liveOrphan).toBeNull();
		expect(o.liveMarker.value).toBeNull();
		expect(c.service.getState().deviceLabels).toContain('USB DSP Audio');
		expect(browserFlat(c.service.getState(), null)).toBe(false);
		expect(fresh.attempts).toBe(0);
	});

	test('flat only while its cable is connected', async () => {
		const { c } = await orphaned();
		expect(browserFlat(c.service.getState(), null)).toBe(true);
	});

	test('"Já desconectei" clears the notice and the marker; nothing is sent', async () => {
		const { o, c } = await orphaned({ lastWrittenLevelDb: -30, sessionWriteCount: 1 });
		const request = {
			bands: OFF_BANDS,
			preampDb: -11,
			experimental: false,
			confirmations: CONFIRMED
		};
		expect(c.service.checklist(request).loudness.deltaDb).toBeNull();
		c.service.dismissLiveOrphan();
		expect(c.service.getState().liveOrphan).toBeNull();
		expect(o.liveMarker.value).toBeNull();
		expect(browserFlat(c.service.getState(), null)).toBe(false);
		expect(c.device.attempts).toBe(0);
		// The loudness of a write is compared with the last written level again.
		expect(c.service.checklist(request).loudness.deltaDb).toBeCloseTo(levelOf(-11) + 30, 9);
	});
});

describe('5/6: the session cable', () => {
	test("liveSavedCurve is the session cable's own saved curve, not another cable's", async () => {
		const h = await live({ journal: [savedEntry(-14), savedEntry(-13, 'Outro cabo')] });
		expect(h.service.liveSavedCurve()).toBeNull();
		await start(h, -12);
		expect(h.service.liveSavedCurve()).toMatchObject({ preampDb: -14 });
		await h.service.stopLive({ revert: false });
		// Also for the ended session.
		expect(h.service.liveSavedCurve()).toMatchObject({ preampDb: -14 });
		expect(h.service.getState().live?.savedCrc).toBe(crcOf(-14));
	});

	test('selectLiveCable makes the active session cable the write target again', async () => {
		const h = await live();
		const other = new FakeHIDDevice({ clock: h.clock, productName: 'Outro cabo' });
		h.hid.addDevice(other);
		await h.service.restore();
		expect(h.service.selectLiveCable()).toBe(false);
		await start(h, -12);
		expect(h.service.selectDevice(other)).toBe(true);
		expect(h.service.getState().deviceLabel).toBe('Outro cabo');
		expect(h.service.selectLiveCable()).toBe(true);
		expect(h.service.getState().deviceLabel).toBe('USB DSP Audio');
		// Salvar now commits the playing curve to the session's cable, not the other one.
		expect((await save(h, -12)).status).toBe('ok');
		expect(h.journal.entries.at(-1)).toMatchObject({
			device: 'USB DSP Audio',
			crc: crcOf(-12)
		});
		expect(other.firmware.commitCount).toBe(0);
		await h.service.stopLive({ revert: false });
		expect(h.service.selectLiveCable()).toBe(false);
	});
});
