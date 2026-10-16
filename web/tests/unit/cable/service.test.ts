import { describe, expect, test } from 'vitest';
import { FakeHID, FakeHIDDevice } from 'open-auri/transport';
import { NEUTRAL_BANDS } from 'open-auri/dsp';
import { levelDb } from 'open-auri/safety';
import { localDateKey } from 'open-auri/policy';
import {
	NEUTRAL_CURVE,
	SIMULATED_LABEL_SUFFIX,
	createCableService,
	detectCableSupport
} from '../../../src/lib/cable/service.ts';
import type { Band, JournalEntry, Written } from '../../../src/lib/cable/types.ts';
import { COMMIT, CONFIRMED, T0, TRUSTED_CLICK, bytesOf, off, padrao, setup } from './harness.ts';

type Harness = Awaited<ReturnType<typeof setup>>;

function writePadrao(h: Harness, extra: { confirmations?: typeof CONFIRMED } = {}) {
	return h.service.write({
		bands: padrao.eqBands,
		preampDb: padrao.preampDb,
		experimental: false,
		confirmations: extra.confirmations ?? CONFIRMED,
		gesture: h.service.createGesture(TRUSTED_CLICK),
		name: 'Padrão'
	});
}

/** Nothing reached the cable and nothing was recorded. */
function expectNothingWritten(h: Harness) {
	expect(h.device.attempts).toBe(0);
	expect(h.device.sent).toEqual([]);
	expect(h.journal.entries).toEqual([]);
	expect(h.flash.records).toEqual([]);
	expect(h.written).toEqual([]);
}

describe('support detection', () => {
	test('real only with navigator.hid in a secure context', () => {
		expect(detectCableSupport({ navigator: { hid: {} }, isSecureContext: true })).toBe('real');
		expect(detectCableSupport({ navigator: { hid: {} }, isSecureContext: false })).toBe(
			'simulated'
		);
		expect(detectCableSupport({ navigator: {}, isSecureContext: true })).toBe('simulated');
		expect(detectCableSupport({})).toBe('simulated');
	});
});

describe('real write', () => {
	test('padrao: bytes on the cable equal the fixture reports plus the commit', async () => {
		const h = await setup();
		expect(h.service.getState().connection).toBe('connected');
		const outcome = await writePadrao(h);
		expect(outcome.status).toBe('ok');
		expect(bytesOf(h.device)).toEqual([...padrao.reports, COMMIT]);
		const written = outcome as Written;
		expect(written.crc).toBe(0x1970);
		expect(written.result.reportsSent).toBe(9);
		expect(written.result.committed).toBe(true);
	});

	test('journal entry, flash record and one cable:written event', async () => {
		const h = await setup();
		await writePadrao(h);
		expect(h.journal.entries).toHaveLength(1);
		const entry = h.journal.entries[0] as JournalEntry;
		expect(entry).toMatchObject({
			schema: 1,
			at: T0,
			name: 'Padrão',
			crc: 0x1970,
			preampDb: padrao.preampDb,
			status: 'ok',
			device: 'USB DSP Audio'
		});
		expect(entry.bands).toEqual(padrao.eqBands);
		expect(h.flash.records).toEqual([T0]);
		expect(h.flash.get().day).toEqual({ date: localDateKey(T0), count: 1 });
		expect(h.written).toHaveLength(1);
		expect(h.written[0]?.crc).toBe(0x1970);
		expect(h.written[0]?.levelDb).toBeCloseTo(levelDb(padrao.eqBands, padrao.preampDb), 9);
		expect(h.service.getState().rescue).toBeNull();
	});

	test('each request field is read exactly once (getters cannot swap values)', async () => {
		const h = await setup();
		const reads: Record<string, number> = {};
		const gesture = h.service.createGesture(TRUSTED_CLICK);
		const values: Record<string, unknown> = {
			bands: padrao.eqBands,
			experimental: false,
			confirmations: CONFIRMED,
			gesture,
			name: 'Padrão'
		};
		const request = {} as Parameters<typeof h.service.write>[0];
		for (const key of Object.keys(values)) {
			Object.defineProperty(request, key, {
				enumerable: true,
				get: () => {
					reads[key] = (reads[key] ?? 0) + 1;
					return values[key];
				}
			});
		}
		// The first read sees padrao's preamp; any later read would get an unsafe 0 dB.
		Object.defineProperty(request, 'preampDb', {
			enumerable: true,
			get: () => {
				reads.preampDb = (reads.preampDb ?? 0) + 1;
				return reads.preampDb === 1 ? padrao.preampDb : 0;
			}
		});
		const outcome = await h.service.write(request);
		expect(outcome.status).toBe('ok');
		expect(reads).toEqual({
			bands: 1,
			preampDb: 1,
			experimental: 1,
			confirmations: 1,
			gesture: 1,
			name: 1
		});
		expect(bytesOf(h.device)).toEqual([...padrao.reports, COMMIT]);
		expect(h.journal.last()?.preampDb).toBe(padrao.preampDb);
		expect(h.written[0]?.preampDb).toBe(padrao.preampDb);
	});

	test('the journal stores a snapshot, not the caller array', async () => {
		const h = await setup();
		const bands = padrao.eqBands.map((band) => ({ ...band }));
		await h.service.write({
			bands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: CONFIRMED,
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		bands[0] = { kind: 'OFF' };
		expect(h.journal.entries[0]?.bands[0]).toEqual(padrao.eqBands[0]);
	});
});

describe('no write path bypasses gesture + checklist + gate', () => {
	test('missing gesture', async () => {
		const h = await setup();
		const outcome = await h.service.write({
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: CONFIRMED,
			gesture: undefined
		});
		expect(outcome).toMatchObject({ status: 'refused', reason: 'gesture' });
		expectNothingWritten(h);
	});

	test('untrusted event yields no token', async () => {
		const h = await setup();
		const gesture = h.service.createGesture({ isTrusted: false, type: 'click' });
		expect(gesture).toBeNull();
		const outcome = await h.service.write({
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: CONFIRMED,
			gesture
		});
		expect(outcome).toMatchObject({ status: 'refused', reason: 'gesture' });
		expectNothingWritten(h);
	});

	test('reused gesture (spent by a refused attempt)', async () => {
		const h = await setup();
		const gesture = h.service.createGesture(TRUSTED_CLICK);
		const request = {
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			gesture
		};
		const first = await h.service.write({
			...request,
			confirmations: { ...CONFIRMED, volumeLowered: false }
		});
		expect(first).toMatchObject({ status: 'refused', reason: 'checklist' });
		const second = await h.service.write({ ...request, confirmations: CONFIRMED });
		expect(second).toMatchObject({ status: 'refused', reason: 'gesture' });
		expectNothingWritten(h);
	});

	test('reused gesture after a successful write', async () => {
		const h = await setup();
		const gesture = h.service.createGesture(TRUSTED_CLICK);
		const request = {
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: CONFIRMED,
			gesture
		};
		expect((await h.service.write(request)).status).toBe('ok');
		h.time.value += 500; // still within the token lifetime
		expect(await h.service.write(request)).toMatchObject({ status: 'refused', reason: 'gesture' });
		expect(h.device.sent).toHaveLength(10);
		expect(h.journal.entries).toHaveLength(1);
	});

	test('expired gesture (> 1 s)', async () => {
		const h = await setup();
		const gesture = h.service.createGesture(TRUSTED_CLICK);
		h.time.value += 1001;
		const outcome = await h.service.write({
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: CONFIRMED,
			gesture
		});
		expect(outcome).toMatchObject({ status: 'refused', reason: 'gesture' });
		expectNothingWritten(h);
	});

	test('a non-gesture event or an inactive page yields no token', async () => {
		const h = await setup();
		expect(h.service.createGesture({ isTrusted: true, type: 'mouseover' })).toBeNull();
		const inactive = createCableService({
			hid: h.hid,
			journal: h.journal,
			flash: h.flash,
			now: () => h.time.value,
			lastWrittenLevelDb: () => null,
			sessionWriteCount: () => 0,
			userActivation: () => ({ isActive: false })
		});
		expect(inactive.createGesture(TRUSTED_CLICK)).toBeNull();
		inactive.dispose();
	});

	test('incomplete checklist', async () => {
		for (const missing of ['volumeLowered', 'keepConnected'] as const) {
			const h = await setup();
			const confirmations = { ...CONFIRMED, [missing]: false };
			const outcome = await writePadrao(h, { confirmations });
			expect(outcome, missing).toMatchObject({ status: 'refused', reason: 'checklist' });
			expectNothingWritten(h);
		}
	});

	test('within 2 s of the previous write', async () => {
		const h = await setup({ flash: { lastWriteAt: T0 - 1000 } });
		const outcome = await writePadrao(h);
		expect(outcome).toMatchObject({ status: 'refused', reason: 'checklist' });
		if (outcome.status === 'refused') {
			expect(outcome.checklist?.spacing).toEqual({ ok: false, waitMs: 1000 });
		}
		expectNothingWritten(h);
	});

	test('two writes in a row: the second waits 2 s', async () => {
		const h = await setup();
		expect((await writePadrao(h)).status).toBe('ok');
		h.time.value += 1999;
		expect(await writePadrao(h)).toMatchObject({ status: 'refused', reason: 'checklist' });
		h.time.value += 1;
		expect((await writePadrao(h)).status).toBe('ok');
		expect(h.journal.entries).toHaveLength(2);
		expect(h.flash.get().session).toBe(2);
	});

	test('gate-failing curve', async () => {
		const h = await setup();
		const outcome = await h.service.write({
			bands: padrao.eqBands,
			preampDb: 0,
			experimental: false,
			confirmations: CONFIRMED,
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(outcome).toMatchObject({ status: 'refused', reason: 'checklist' });
		if (outcome.status === 'refused') expect(outcome.checklist?.gateOk).toBe(false);
		expectNothingWritten(h);
	});

	test('experimental kinds need the experimental confirmation', async () => {
		for (const band of [
			{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 },
			{ kind: 'LP', freqHz: 18000, qFactor: 0.7 },
			{ kind: 'HP', freqHz: 30, qFactor: 0.7 }
		] satisfies Band[]) {
			const h = await setup();
			const outcome = await h.service.write({
				bands: [band, ...Array.from({ length: 9 }, off)],
				preampDb: -0.5,
				experimental: true,
				confirmations: CONFIRMED,
				gesture: h.service.createGesture(TRUSTED_CLICK)
			});
			expect(outcome, band.kind).toMatchObject({ status: 'refused', reason: 'checklist' });
			if (outcome.status === 'refused') {
				expect(outcome.checklist?.experimentalRequired).toBe(true);
			}
			expectNothingWritten(h);
		}
	});

	test('no device connected', async () => {
		const h = await setup({ connect: false });
		const outcome = await writePadrao(h);
		expect(outcome).toMatchObject({ status: 'refused', reason: 'no-device' });
		expectNothingWritten(h);
	});

	test('a concurrent write is refused', async () => {
		const h = await setup();
		const first = writePadrao(h);
		const second = await writePadrao(h);
		expect(second).toMatchObject({ status: 'refused', reason: 'busy' });
		expect((await first).status).toBe('ok');
		expect(h.journal.entries).toHaveLength(1);
	});
});

describe('loudness and flash notices through the service', () => {
	test('first write of the session warns', async () => {
		const h = await setup({ sessionWriteCount: 0 });
		const checklist = h.service.checklist({
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: CONFIRMED
		});
		expect(checklist.loudness.warn).toBe(true);
		expect(checklist.loudness.reasons).toContain('unknown-state');
	});

	test('+3 dB over the last written curve warns', async () => {
		const level = levelDb(padrao.eqBands, padrao.preampDb);
		const h = await setup({ sessionWriteCount: 1, lastWrittenLevelDb: level - 3 });
		const checklist = h.service.checklist({
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: CONFIRMED
		});
		expect(checklist.loudness.reasons).toEqual(['jump']);
	});

	test('50 writes today shows the flash notice', async () => {
		const h = await setup({ flash: { day: { date: localDateKey(T0), count: 50 }, total: 50 } });
		const checklist = h.service.checklist({
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: CONFIRMED
		});
		expect(checklist.dailyNotice.show).toBe(true);
		expect(checklist.counters.day).toBe(50);
	});

	test('an unknown lastWriteAt waits 2 s once, then expires', async () => {
		const h = await setup({ flash: { lastWriteAt: null } });
		expect(await writePadrao(h)).toMatchObject({ status: 'refused', reason: 'checklist' });
		h.time.value += 2000;
		expect((await writePadrao(h)).status).toBe('ok');
	});
});

describe('interruption and rescue', () => {
	test('disconnect mid-write: journal interrupted, rescue state, no event', async () => {
		const h = await setup({ deviceOptions: { disconnectAtReport: 4 } });
		// The attempt is counted before its first byte (a tab closed mid-write still counts it).
		const sentAtRecord: number[] = [];
		const record = h.flash.record.bind(h.flash);
		h.flash.record = (at) => {
			sentAtRecord.push(h.device.sent.length);
			record(at);
		};
		const outcome = await writePadrao(h);
		expect(outcome.status).toBe('interrupted');
		expect(h.device.sent).toHaveLength(4);
		expect(bytesOf(h.device).some((bytes) => bytes.every((b, i) => b === COMMIT[i]))).toBe(false);
		expect(h.journal.last()?.status).toBe('interrupted');
		expect(h.flash.records).toEqual([T0]);
		expect(sentAtRecord).toEqual([0]);
		expect(h.written).toEqual([]);
		const state = h.service.getState();
		expect(state.rescue).toEqual({ at: T0, deviceLabel: 'USB DSP Audio', reportsSent: 4 });
		expect(state.connection).toBe('disconnected');
		expect(state.devices).toEqual([]);
	});

	test('rescue: reconnect and write Neutro through the same checklist', async () => {
		const h = await setup({ deviceOptions: { disconnectAtReport: 2 } });
		await writePadrao(h);
		const replacement = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(replacement);
		expect(h.service.getState().device).toBe(replacement);
		h.time.value += 3000;
		const request = {
			bands: NEUTRAL_CURVE.bands,
			preampDb: NEUTRAL_CURVE.preampDb,
			experimental: false,
			name: NEUTRAL_CURVE.name
		};
		// The last journal entry is interrupted: the loudness warning is on.
		const checklist = h.service.checklist({ ...request, confirmations: CONFIRMED });
		expect(checklist.loudness.reasons).toContain('unknown-state');
		// Same rules: without the confirmations nothing is written.
		const refused = await h.service.write({
			...request,
			confirmations: { ...CONFIRMED, keepConnected: false },
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(refused).toMatchObject({ status: 'refused', reason: 'checklist' });
		expect(replacement.attempts).toBe(0);
		const outcome = await h.service.write({
			...request,
			confirmations: CONFIRMED,
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(outcome.status).toBe('ok');
		expect((outcome as Written).crc).toBe(0x4fff);
		expect(h.service.getState().rescue).toBeNull();
		expect(h.journal.last()?.status).toBe('ok');
		expect(h.written).toHaveLength(1);
	});

	test('an interrupted last journal entry restores the rescue state on load', async () => {
		const interrupted: JournalEntry = {
			schema: 1,
			at: T0 - 60_000,
			name: '',
			crc: 0x1970,
			preampDb: -2.8,
			bands: NEUTRAL_BANDS.map((band) => ({ ...band })),
			status: 'interrupted',
			device: 'USB DSP Audio'
		};
		const h = await setup({ journal: [interrupted], connect: false });
		expect(h.service.getState().rescue).toEqual({
			at: T0 - 60_000,
			deviceLabel: 'USB DSP Audio',
			reportsSent: null
		});
		h.service.dismissRescue();
		expect(h.service.getState().rescue).toBeNull();
	});

	test('a write is never retried', async () => {
		const h = await setup({ deviceOptions: { throwAtReport: 0 } });
		const outcome = await writePadrao(h);
		expect(outcome.status).toBe('interrupted');
		expect(h.device.attempts).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.device.attempts).toBe(1);
		expect(h.journal.entries).toHaveLength(1);
	});
});

describe('simulated mode', () => {
	test('without WebHID: writes to the fake cable only and journals simulated', async () => {
		const real = new FakeHIDDevice();
		// A "real" HID and cable the simulated service must never touch.
		const realHid = new FakeHID({ devices: [real] });
		const h = await setup({ hid: null });
		const state = h.service.getState();
		expect(state.mode).toBe('simulated');
		expect(state.connection).toBe('connected');
		expect(state.deviceLabel).toBe(`USB DSP Audio${SIMULATED_LABEL_SUFFIX}`);
		const outcome = await writePadrao(h);
		expect(outcome.status).toBe('simulated');
		expect((outcome as Written).simulated).toBe(true);
		expect(h.journal.last()).toMatchObject({
			status: 'simulated',
			crc: 0x1970,
			device: 'USB DSP Audio (simulado)'
		});
		expect(h.flash.records).toEqual([]);
		expect(h.written).toEqual([]);
		expect(real.attempts).toBe(0);
		expect(realHid.requests).toEqual([]);
		expect(h.hid.requests).toEqual([]);
		expect(h.device.attempts).toBe(0);
		const simulatedDevice = h.service.getState().device as FakeHIDDevice;
		expect(bytesOf(simulatedDevice)).toEqual([...padrao.reports, COMMIT]);
	});

	test('simulated writes follow the same gesture and checklist rules', async () => {
		const h = await setup({ hid: null });
		const outcome = await h.service.write({
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: CONFIRMED,
			gesture: null
		});
		expect(outcome).toMatchObject({ status: 'refused', reason: 'gesture' });
		const incomplete = await writePadrao(h, {
			confirmations: { ...CONFIRMED, volumeLowered: false }
		});
		expect(incomplete).toMatchObject({ status: 'refused', reason: 'checklist' });
		expect(h.journal.entries).toEqual([]);
	});
});

describe('connection events', () => {
	test('connect/disconnect events of the HID update the status', async () => {
		const h = await setup();
		const second = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		expect(h.service.getState().devices).toEqual([h.device, second]);
		expect(h.service.getState().deviceLabels).toEqual(['USB DSP Audio', 'USB DSP Audio #2']);
		h.hid.disconnect(h.device);
		expect(h.service.getState().device).toBe(second);
		h.hid.disconnect(second);
		expect(h.service.getState().connection).toBe('disconnected');
	});

	test('getDevices() restores a single permitted cable as the visible target', async () => {
		const h = await setup();
		const other = createCableService({
			hid: h.hid,
			journal: h.journal,
			flash: h.flash,
			now: () => h.time.value,
			lastWrittenLevelDb: () => null,
			sessionWriteCount: () => 0,
			locks: null,
			inflight: null
		});
		expect(other.getState().connection).toBe('disconnected');
		await other.restore();
		// Exactly one cable: it is the target, and the checklist shows its label (deviceLabel).
		expect(other.getState().device).toBe(h.device);
		expect(other.getState().deviceLabel).toBe('USB DSP Audio');
		expect(other.getState().connection).toBe('connected');
		other.dispose();
	});

	test('restoring several cables never picks a target silently', async () => {
		const h = await setup({ connect: false });
		const second = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		// Both cables were granted on an earlier visit.
		h.hid.choose = (matching) => matching;
		await h.hid.requestDevice({ filters: [] });
		const other = createCableService({
			hid: h.hid,
			journal: h.journal,
			flash: h.flash,
			now: () => h.time.value,
			lastWrittenLevelDb: () => null,
			sessionWriteCount: () => 0,
			userActivation: () => ({ isActive: true }),
			locks: null,
			inflight: null
		});
		expect(await other.restore()).toEqual([h.device, second]);
		const state = other.getState();
		expect(state.connection).toBe('connected');
		expect(state.devices).toEqual([h.device, second]);
		expect(state.device).toBeNull();
		expect(state.deviceLabel).toBeNull();
		const request = {
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: CONFIRMED
		};
		expect(
			await other.write({ ...request, gesture: other.createGesture(TRUSTED_CLICK) })
		).toMatchObject({ status: 'refused', reason: 'no-device' });
		expect(h.device.attempts + second.attempts).toBe(0);
		// An explicit selection makes it the target; selecting never writes by itself.
		expect(other.selectDevice(second)).toBe(true);
		expect(other.getState().deviceLabel).toBe('USB DSP Audio #2');
		expect(h.device.attempts + second.attempts).toBe(0);
		expect(
			(await other.write({ ...request, gesture: other.createGesture(TRUSTED_CLICK) })).status
		).toBe('ok');
		expect(second.sent).toHaveLength(10);
		expect(h.device.attempts).toBe(0);
		other.dispose();
	});

	test('unplugging the target of several cables leaves no target until the user chooses', async () => {
		const h = await setup();
		const second = new FakeHIDDevice({ clock: h.clock });
		const third = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		h.hid.addDevice(third);
		expect(h.service.getState().device).toBe(h.device);
		h.hid.disconnect(h.device);
		expect(h.service.getState()).toMatchObject({ device: null, connection: 'connected' });
		h.hid.disconnect(second);
		// A single remaining cable is the visible target again.
		expect(h.service.getState().device).toBe(third);
	});

	test('subscribe follows the store contract', async () => {
		const h = await setup();
		const seen: string[] = [];
		const stop = h.service.subscribe((state) => seen.push(state.connection));
		expect(seen).toEqual(['connected']);
		h.hid.disconnect(h.device);
		stop();
		h.hid.addDevice(new FakeHIDDevice());
		expect(seen).toEqual(['connected', 'disconnected']);
	});
});

describe('X9 multi-cable queue', () => {
	async function twoCables(secondOptions: ConstructorParameters<typeof FakeHIDDevice>[0] = {}) {
		const h = await setup();
		const second = new FakeHIDDevice({ clock: h.clock, ...secondOptions });
		h.hid.addDevice(second);
		return { ...h, second };
	}

	function queue(
		h: Harness,
		devices: FakeHIDDevice[],
		gesture = h.service.createGesture(TRUSTED_CLICK)
	) {
		return h.service.writeQueue({
			devices,
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: CONFIRMED,
			gesture,
			name: 'Padrão'
		});
	}

	test('one gesture writes every confirmed cable in sequence, 2 s apart', async () => {
		const h = await twoCables();
		const outcome = await queue(h, [h.device, h.second]);
		expect(outcome.status).toBe('done');
		if (outcome.status !== 'done') return;
		expect(outcome.items.map((item) => item.status)).toEqual(['ok', 'ok']);
		expect(outcome.items.map((item) => item.deviceLabel)).toEqual([
			'USB DSP Audio',
			'USB DSP Audio #2'
		]);
		expect(bytesOf(h.device)).toEqual([...padrao.reports, COMMIT]);
		expect(bytesOf(h.second)).toEqual([...padrao.reports, COMMIT]);
		const endFirst = h.device.sent.at(-1)?.at ?? 0;
		const startSecond = h.second.sent[0]?.at ?? 0;
		expect(startSecond - endFirst).toBeGreaterThanOrEqual(2000);
		expect(h.journal.entries.map((entry) => entry.status)).toEqual(['ok', 'ok']);
		expect(h.flash.records).toHaveLength(2);
		expect(h.written.map((detail) => detail.deviceLabel)).toEqual([
			'USB DSP Audio',
			'USB DSP Audio #2'
		]);
		expect(h.service.getState().queue?.running).toBe(false);
	});

	test('stops at the first failure; the rest is skipped', async () => {
		const h = await setup({ deviceOptions: { disconnectAtReport: 2 } });
		const second = new FakeHIDDevice({ clock: h.clock });
		h.hid.addDevice(second);
		const outcome = await queue(h, [h.device, second]);
		expect(outcome.status).toBe('done');
		if (outcome.status !== 'done') return;
		expect(outcome.items.map((item) => item.status)).toEqual(['interrupted', 'skipped']);
		expect(second.attempts).toBe(0);
		expect(h.journal.entries.map((entry) => entry.status)).toEqual(['interrupted']);
		expect(h.written).toEqual([]);
		expect(h.service.getState().rescue?.reportsSent).toBe(2);
	});

	test('the queue needs a gesture, a complete checklist and connected cables', async () => {
		const h = await twoCables();
		expect(await queue(h, [h.device, h.second], null)).toMatchObject({
			status: 'refused',
			reason: 'gesture'
		});
		const incomplete = await h.service.writeQueue({
			devices: [h.device, h.second],
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: { ...CONFIRMED, keepConnected: false },
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(incomplete).toMatchObject({ status: 'refused', reason: 'checklist' });
		const stranger = new FakeHIDDevice({ clock: h.clock });
		expect(await queue(h, [h.device, stranger])).toMatchObject({
			status: 'refused',
			reason: 'unknown-device'
		});
		expect(await queue(h, [h.device, h.device])).toMatchObject({
			status: 'refused',
			reason: 'unknown-device'
		});
		expect(await queue(h, [])).toMatchObject({ status: 'refused', reason: 'no-device' });
		expect(h.device.attempts + h.second.attempts + stranger.attempts).toBe(0);
		expect(h.journal.entries).toEqual([]);
	});

	test('a queue gesture cannot be reused', async () => {
		const h = await twoCables();
		const gesture = h.service.createGesture(TRUSTED_CLICK);
		expect((await queue(h, [h.device, h.second], gesture)).status).toBe('done');
		h.time.value += 500;
		expect(await queue(h, [h.device, h.second], gesture)).toMatchObject({
			status: 'refused',
			reason: 'gesture'
		});
		expect(h.journal.entries).toHaveLength(2);
	});

	test('simulated queue journals simulated and emits no cable:written', async () => {
		const h = await setup({ hid: null });
		await h.service.connect();
		const [first, second] = h.service.getState().devices;
		expect(second).toBeDefined();
		const outcome = await h.service.writeQueue({
			devices: [first, second].filter((device) => device !== undefined),
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: CONFIRMED,
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(outcome.status).toBe('done');
		if (outcome.status !== 'done') return;
		expect(outcome.simulated).toBe(true);
		expect(outcome.items.map((item) => item.status)).toEqual(['simulated', 'simulated']);
		expect(h.journal.entries.map((entry) => entry.status)).toEqual(['simulated', 'simulated']);
		expect(h.flash.records).toEqual([]);
		expect(h.written).toEqual([]);
	});
});
