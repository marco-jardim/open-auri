import { afterEach, expect, test, vi } from 'vitest';
import { FakeHIDDevice } from 'open-auri/transport';
import { CABLE_WRITE_LOCK, cableAliveLock, isCableDevice } from '#lib/cable/service.ts';
import { CONFIRMED, TRUSTED_CLICK, padrao, setup } from './harness.ts';
import { memoryLocks } from './locks-fake.ts';

const services: { dispose(): void }[] = [];

afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
	vi.restoreAllMocks();
});

async function harness(options: Parameters<typeof setup>[0] = {}) {
	const h = await setup(options);
	services.push(h.service);
	return h;
}

function request(h: Awaited<ReturnType<typeof setup>>) {
	return {
		bands: padrao.eqBands,
		preampDb: padrao.preampDb,
		experimental: false,
		confirmations: CONFIRMED,
		gesture: h.service.createGesture(TRUSTED_CLICK)
	};
}

test.each([
	null,
	false,
	{},
	{ vendorId: 0x3302 },
	{ vendorId: 0x3302, productId: 0x8902 },
	{ vendorId: 0x3302, productId: 0x8902, sendReport: () => undefined },
	{ vendorId: 1, productId: 0x8902, sendReport: () => undefined, open: () => undefined }
])('rejects incomplete/non-cable HID candidates: %j', (value) => {
	expect(isCableDevice(value)).toBe(false);
	expect(isCableDevice(new FakeHIDDevice())).toBe(true);
});

test('picker rejection and restore rejection leave the service disconnected with actionable errors', async () => {
	const h = await harness({ connect: false });
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	vi.spyOn(h.hid, 'requestDevice').mockRejectedValueOnce(new Error('Picker denied'));
	expect(await h.service.connect()).toBeNull();
	expect(h.service.getState()).toMatchObject({
		connection: 'disconnected',
		error: 'request-failed'
	});
	vi.spyOn(h.hid, 'getDevices').mockRejectedValueOnce(new Error('Restore denied'));
	expect(await h.service.restore()).toEqual([]);
	expect(h.service.getState().error).toBe('restore-failed');
	expect(h.device.attempts).toBe(0);
});

test('a pending picker is not opened again; cancellation gives feedback cleared by a successful connect', async () => {
	const h = await harness({ connect: false });
	let resolve!: (devices: FakeHIDDevice[]) => void;
	vi.spyOn(h.hid, 'requestDevice').mockImplementationOnce(
		() =>
			new Promise((done) => {
				resolve = done;
			})
	);
	const first = h.service.connect();
	expect(h.service.getState().connection).toBe('connecting');
	expect(await h.service.connect()).toBeNull();
	resolve([]);
	expect(await first).toBeNull();
	expect(h.hid.requestDevice).toHaveBeenCalledOnce();
	expect(h.service.getState()).toMatchObject({ connection: 'disconnected', error: 'request-empty' });
	expect(h.device.attempts).toBe(0);
	expect(await h.service.connect()).toBe(h.device);
	expect(h.service.getState()).toMatchObject({ connection: 'connected', error: null });
});

test('selection/disconnection reject strangers; closing a permitted cable can fail without losing state cleanup', async () => {
	const h = await harness();
	const other = new FakeHIDDevice({ clock: h.clock });
	expect(h.service.selectDevice(other)).toBe(false);
	expect(await h.service.disconnect(other)).toBe(false);
	h.hid.addDevice(other);
	expect(h.service.selectDevice(other)).toBe(true);
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	Object.defineProperty(other, 'close', {
		value: vi.fn().mockRejectedValue(new Error('Already unplugged'))
	});
	expect(await h.service.disconnect()).toBe(true);
	// The remaining cable is not made the target silently: nothing to disconnect by default.
	expect(h.service.getState().device).toBeNull();
	expect(await h.service.disconnect()).toBe(false);
	expect(await h.service.disconnect(h.device)).toBe(true);
	expect(await h.service.disconnect(h.device)).toBe(false);
	expect(h.service.getState().connection).toBe('disconnected');
});

test('active writes block selection and disconnect; abort never commits and clears the write flag', async () => {
	const h = await harness();
	expect(h.service.abort()).toBe(false);
	const writing = h.service.write(request(h));
	expect(h.service.getState().writing).toBe(true);
	expect(h.service.selectDevice(h.device)).toBe(false);
	const disconnecting = h.service.disconnect();
	expect(h.service.abort()).toBe(true);
	expect(await disconnecting).toBe(false);
	const outcome = await writing;
	if (outcome.status === 'refused') expect(outcome.reason).toBe('aborted');
	else expect(outcome.result.committed).toBe(false);
	expect(h.device.sent.length).toBeLessThan(10);
	expect(h.service.getState().writing).toBe(false);
	expect(h.service.abort()).toBe(false);
	expect(
		(globalThis as typeof globalThis & { __oaWriteInProgress?: boolean }).__oaWriteInProgress
	).toBe(false);
});

test('a simulated interruption does not append a journal entry, count a real flash write or create rescue state', async () => {
	const h = await harness({ hid: null });
	const device = h.service.getState().device;
	if (!device) throw new Error('Missing simulated device');
	vi.spyOn(device, 'sendReport').mockRejectedValueOnce(new Error('Simulated failure'));
	const outcome = await h.service.write(request(h));
	expect(outcome).toMatchObject({ status: 'interrupted', simulated: true, entry: null });
	expect(h.journal.entries).toEqual([]);
	expect(h.flash.records).toEqual([]);
	expect(h.service.getState().rescue).toBeNull();
	expect(h.written).toEqual([]);
});

test('journal failure is surfaced while the already completed device write remains counted and is never retried', async () => {
	const h = await harness();
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	vi.spyOn(h.journal, 'append').mockImplementation(() => {
		throw new Error('Journal unavailable');
	});
	const outcome = await h.service.write(request(h));
	expect(outcome.status).toBe('ok');
	expect(h.service.getState().error).toBe('journal-failed');
	expect(h.flash.records).toHaveLength(1);
	expect(h.device.sent).toHaveLength(10);
});

test('journal names and device labels are truncated by Unicode code point, not UTF-16 code unit', async () => {
	const h = await harness({ deviceOptions: { productName: '🎧'.repeat(80) } });
	await h.service.write({ ...request(h), name: '🎵'.repeat(70) });
	expect(h.journal.last()?.name).toBe('🎵'.repeat(48));
	expect(h.journal.last()?.device).toBe('🎧'.repeat(64));
});

test('running queue summaries cannot be cleared; completed summaries can be cleared', async () => {
	const h = await harness();
	const second = new FakeHIDDevice({ clock: h.clock });
	h.hid.addDevice(second);
	const running = h.service.writeQueue({ ...request(h), devices: [h.device, second] });
	h.service.clearQueue();
	expect(h.service.getState().queue?.running).toBe(true);
	await running;
	expect(h.service.getState().queue?.running).toBe(false);
	h.service.clearQueue();
	expect(h.service.getState().queue).toBeNull();
});

test('the liveness lock is taken before the first marker, kept, and released on dispose (#15)', async () => {
	const alive = cableAliveLock('tab-x');
	const locks = memoryLocks(new Set([alive]));
	const h = await harness({ locks, tabId: 'tab-x' });
	// Cannot be taken: refused before any marker, flash count or byte; the write lock is free.
	expect(await h.service.write(request(h))).toMatchObject({ status: 'refused', reason: 'error' });
	expect(h.device.attempts).toBe(0);
	expect(h.inflight.writes).toEqual([]);
	expect(h.flash.records).toEqual([]);
	expect(locks.held.has(CABLE_WRITE_LOCK)).toBe(false);
	locks.held.delete(alive);
	expect((await h.service.write(request(h))).status).toBe('ok');
	expect(locks.requests.map((entry) => entry.name)).toEqual([
		CABLE_WRITE_LOCK,
		alive,
		CABLE_WRITE_LOCK,
		alive
	]);
	expect([...locks.held]).toEqual([alive]);
	// Held, so the next write does not ask for it again.
	h.time.value += 2_500;
	expect((await h.service.write(request(h))).status).toBe('ok');
	expect(locks.requests.map((entry) => entry.name).slice(4)).toEqual([CABLE_WRITE_LOCK]);
	h.service.dispose();
	await vi.waitFor(() => expect(locks.held.size).toBe(0));
	// Never waited on anything: only `ifAvailable` requests.
	expect(locks.waits).toEqual([]);
});
