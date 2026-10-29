/**
 * Live preview across tabs (issue #68, S5): the session lock `oa-cable-live`, `live-elsewhere`
 * refusals, the `oa.cable.live` marker and orphan previews left by a tab that is gone.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { gateForWrite } from 'open-auri/safety';
import {
	CABLE_LIVE_LOCK,
	cableAliveLock,
	parseLiveMarker
} from '../../../src/lib/cable/service.ts';
import type { Band, JournalEntry, LiveCurve } from '../../../src/lib/cable/types.ts';
import { CONFIRMED, T0, TRUSTED_CLICK, off, setup, type SetupOptions } from './harness.ts';
import { memoryInflight, memoryLocks, type MemoryInflight } from './locks-fake.ts';

type Harness = Awaited<ReturnType<typeof setup>>;

const OFF_BANDS: Band[] = Array.from({ length: 10 }, off);

function curve(preampDb: number): LiveCurve {
	return { bands: OFF_BANDS, preampDb };
}

function crcOf(preampDb: number): number {
	return Number(gateForWrite(OFF_BANDS, preampDb, { experimental: false }).metrics.payloadCrc);
}

/** An `ok` journal entry: the default cable holds `preampDb` (flat) in flash. */
function savedEntry(preampDb: number): JournalEntry {
	return {
		schema: 1,
		at: T0 - 60_000,
		name: 'Salvo',
		crc: crcOf(preampDb),
		preampDb,
		bands: OFF_BANDS,
		status: 'ok',
		device: 'USB DSP Audio'
	};
}

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

let tabs: Harness[] = [];
afterEach(() => {
	for (const h of tabs) h.service.dispose();
	tabs = [];
});

/** Tabs of one origin: they share the lock manager's `held` set and the live marker key. */
function origin() {
	const held = new Set<string>();
	const liveMarker: MemoryInflight = memoryInflight();
	const inflight = memoryInflight();
	return {
		held,
		liveMarker,
		async tab(tabId: string, options: SetupOptions = {}) {
			const h = await setup({
				locks: memoryLocks(held),
				liveMarker,
				inflight,
				tabId,
				...options
			});
			tabs.push(h);
			return h;
		}
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

describe('one live session per origin', () => {
	test("a second tab's startLive is refused live-elsewhere; nothing is sent", async () => {
		const o = origin();
		const a = await o.tab('tab-a');
		const b = await o.tab('tab-b');
		expect((await start(a)).status).toBe('accepted');
		expect(o.held.has(CABLE_LIVE_LOCK)).toBe(true);
		expect(await start(b, -11)).toMatchObject({ status: 'refused', reason: 'live-elsewhere' });
		expect(b.service.getState().live).toBeNull();
		expect(b.device.attempts).toBe(0);
		// Once A stops, B may start.
		await a.service.stopLive({ revert: false });
		await macrotask();
		expect(o.held.has(CABLE_LIVE_LOCK)).toBe(false);
		expect((await start(b, -11)).status).toBe('accepted');
	});

	test("another tab's write is refused live-elsewhere while the session runs", async () => {
		const o = origin();
		const a = await o.tab('tab-a');
		const b = await o.tab('tab-b');
		await start(a);
		const refused = await save(b, -13);
		expect(refused).toMatchObject({ status: 'refused', reason: 'live-elsewhere' });
		expect(b.device.attempts).toBe(0);
		expect(b.journal.entries).toEqual([]);
		expect(b.inflight.writes).toEqual([]);
		// The session's own tab saves ("Salvar") normally.
		expect((await save(a, -12)).status).toBe('ok');
		await a.service.stopLive({ revert: false });
		b.time.value += 5_000;
		expect((await save(b, -13)).status).toBe('ok');
	});
});

describe('live marker', () => {
	test('failed open sends zero reports and leaves no orphan preview after reload', async () => {
		const o = origin();
		const error = new Error('controlTransfer failed (-1)');
		const a = await o.tab('tab-a', { deviceOptions: { openError: error } });
		await start(a);
		expect(a.service.getState().live?.lastError).toBe(error);
		expect(a.device.attempts).toBe(0);
		expect(a.device.sent).toHaveLength(0);
		expect(o.liveMarker.writes.some((raw) => raw !== null)).toBe(true);
		a.service.dispose();
		await macrotask();
		const reloaded = await o.tab('tab-reloaded');
		expect(reloaded.service.getState().liveOrphan).toBeNull();
		expect(o.liveMarker.value).toBeNull();
	});

	test.each(['tab-a', 'previous-tab'])(
		'failed open preserves a previous marker owned by %s',
		async (owner) => {
			const o = origin();
			const previous = JSON.stringify({
				tabId: owner,
				device: 'USB DSP Audio',
				crc: crcOf(-13),
				at: T0 - 1_000
			});
			o.liveMarker.value = previous;
			const a = await o.tab('tab-a', {
				deviceOptions: { openError: new Error('open failed') }
			});
			await start(a);
			expect(a.device.attempts).toBe(0);
			expect(o.liveMarker.value).toBe(previous);
			a.service.dispose();
			await macrotask();
			const reloaded = await o.tab('tab-reloaded');
			expect(reloaded.service.getState().liveOrphan).toMatchObject({ crc: crcOf(-13) });
		}
	);

	test('failed open never removes a marker replaced during the attempt', async () => {
		const o = origin();
		const a = await o.tab('tab-a');
		const newer = JSON.stringify({
			tabId: 'other-tab',
			device: 'USB DSP Audio',
			crc: crcOf(-13),
			at: T0 + 1
		});
		vi.spyOn(a.device, 'open').mockImplementation(async () => {
			o.liveMarker.value = newer;
			throw new Error('open failed');
		});
		await start(a);
		expect(a.device.attempts).toBe(0);
		expect(o.liveMarker.value).toBe(newer);
	});

	test.each([
		['first report unconfirmed', 0, new Error('send failed')],
		['first report TypeError', 0, new TypeError('send failed')],
		['failure after first report', 1, new Error('send failed')],
		['timeout after first report', 1, new DOMException('transfer timed out', 'TimeoutError')],
		[
			'connection lost without confirmed unplug',
			1,
			new DOMException('connection lost', 'NetworkError')
		]
	] as const)('%s keeps the marker and orphan warning', async (_name, report, error) => {
		const o = origin();
		const a = await o.tab('tab-a', {
			deviceOptions: { throwAtReport: report, throwError: error }
		});
		await start(a);
		expect(a.device.attempts).toBe(report + 1);
		expect(a.device.sent).toHaveLength(report);
		expect(o.liveMarker.value).not.toBeNull();
		a.service.dispose();
		await macrotask();
		const reloaded = await o.tab('tab-reloaded');
		expect(reloaded.service.getState().liveOrphan).toMatchObject({ crc: crcOf(-12) });
	});

	test.each(['stop', 'tab death'])('%s during a pending report keeps the marker', async (end) => {
		const o = origin();
		const a = await o.tab('tab-a', { deviceOptions: { hangAtReport: 1 } });
		const starting = start(a);
		await vi.waitFor(() => expect(a.device.attempts).toBe(2));
		expect(a.device.sent).toHaveLength(1);
		expect(o.liveMarker.value).not.toBeNull();
		if (end === 'stop') await a.service.stopLive({ revert: false });
		a.service.dispose();
		await starting;
		await macrotask();
		expect(o.liveMarker.value).not.toBeNull();
		const reloaded = await o.tab('tab-reloaded');
		expect(reloaded.service.getState().liveOrphan).toMatchObject({ crc: crcOf(-12) });
	});

	test('written before the first apply, removed after a successful revert', async () => {
		const o = origin();
		const a = await o.tab('tab-a', { journal: [savedEntry(-14)] });
		await start(a, -12);
		const marker = o.liveMarker.value === null ? null : parseLiveMarker(o.liveMarker.value);
		expect(marker).toMatchObject({ tabId: 'tab-a', device: 'USB DSP Audio', crc: crcOf(-12) });
		const reverted = await a.service.stopLive({
			revert: true,
			gesture: a.service.createGesture(TRUSTED_CLICK),
			saved: curve(-14)
		});
		expect(reverted.status).toBe('accepted');
		expect(a.service.getState().live?.endedReason).toBe('reverted');
		expect(o.liveMarker.value).toBeNull();
	});

	test('removed when the cable is unplugged; kept when the preview is stopped without revert', async () => {
		const o = origin();
		const a = await o.tab('tab-a');
		await start(a, -12);
		await a.service.stopLive({ revert: false });
		expect(o.liveMarker.value).not.toBeNull();
		a.hid.disconnect(a.device);
		expect(o.liveMarker.value).toBeNull();
	});

	test('reload after the tab died: orphan preview, loudness unknown, cleared by an unplug', async () => {
		const o = origin();
		const a = await o.tab('tab-a');
		await start(a, -12);
		await a.service.stopLive({ revert: false });
		// The tab is gone: its liveness lock is released, the marker stays.
		a.service.dispose();
		await macrotask();
		expect(o.held.has(cableAliveLock('tab-a'))).toBe(false);
		const c = await o.tab('tab-c', { lastWrittenLevelDb: -30, sessionWriteCount: 1 });
		const orphan = c.service.getState().liveOrphan;
		expect(orphan).toMatchObject({ crc: crcOf(-12), deviceLabel: 'USB DSP Audio' });
		const request = {
			bands: OFF_BANDS,
			preampDb: -11,
			experimental: false,
			confirmations: CONFIRMED
		};
		const loudness = c.service.checklist(request).loudness;
		expect(loudness.deltaDb).toBeNull();
		expect(loudness.reasons).toContain('unknown-state');
		c.hid.disconnect(c.device);
		expect(c.service.getState().liveOrphan).toBeNull();
		expect(o.liveMarker.value).toBeNull();
	});

	test('a tab open while the previewing tab dies reports the orphan too', async () => {
		const o = origin();
		const a = await o.tab('tab-a');
		const b = await o.tab('tab-b');
		await start(a, -12);
		// `storage` event in B: A wrote its marker.
		o.liveMarker.announce();
		await macrotask();
		expect(b.service.getState().liveOrphan ?? null).toBeNull();
		a.service.dispose();
		await macrotask();
		expect(b.service.getState().liveOrphan).toMatchObject({ crc: crcOf(-12) });
	});

	test("another tab's newer save is the saved curve: the marker follows it, not this tab's", async () => {
		const o = origin();
		const a = await o.tab('tab-a');
		const b = await o.tab('tab-b');
		// This tab saved X (-14); later another tab saved Y (-13) to the same cable.
		expect((await save(a, -14)).status).toBe('ok');
		b.time.value += 5_000;
		a.time.value += 5_000;
		expect((await save(b, -13)).status).toBe('ok');
		const y = b.journal.entries.at(-1);
		if (y === undefined) throw new Error('tab B journaled nothing');
		// The shared journal reaches tab A (storage event).
		a.journal.append(y);
		// Previewing X is a preview now (the flash holds Y): marker written.
		await start(a, -14);
		const marker = () => (o.liveMarker.value === null ? null : parseLiveMarker(o.liveMarker.value));
		expect(marker()).toMatchObject({ tabId: 'tab-a', crc: crcOf(-14) });
		// Y plays again: the marker goes.
		a.service.queueLive(curve(-13));
		await a.service.whenLiveIdle();
		expect(a.service.getState().live?.applied?.crc).toBe(crcOf(-13));
		expect(o.liveMarker.value).toBeNull();
		// A revert targets Y, even when this tab offers X.
		a.service.queueLive(curve(-13.5));
		await a.service.whenLiveIdle();
		expect(marker()).toMatchObject({ crc: crcOf(-13.5) });
		const reverted = await a.service.revertLive({
			gesture: a.service.createGesture(TRUSTED_CLICK),
			saved: curve(-14)
		});
		expect(reverted.status).toBe('accepted');
		expect(a.service.getState().live?.applied?.crc).toBe(crcOf(-13));
		expect(o.liveMarker.value).toBeNull();
	});

	test('a preview of the stale per-tab save is not reverted: its marker stays', async () => {
		const o = origin();
		const a = await o.tab('tab-a');
		expect((await save(a, -14)).status).toBe('ok');
		a.time.value += 5_000;
		// Another tab's newer save of the same cable (Y, -13), arrived through storage.
		a.journal.append({ ...savedEntry(-13), at: a.time.value });
		await start(a, -12);
		a.service.queueLive(curve(-14));
		await a.service.whenLiveIdle();
		expect(a.service.getState().live?.applied?.crc).toBe(crcOf(-14));
		// X is not what the flash holds: the marker names it.
		const marker = o.liveMarker.value === null ? null : parseLiveMarker(o.liveMarker.value);
		expect(marker).toMatchObject({ tabId: 'tab-a', crc: crcOf(-14) });
	});

	test('the live tab itself never reports its own marker as an orphan', async () => {
		const o = origin();
		const a = await o.tab('tab-a');
		await start(a, -12);
		o.liveMarker.announce();
		await macrotask();
		expect(a.service.getState().liveOrphan ?? null).toBeNull();
	});
});

describe('the cable state during a session', () => {
	test("another tab's in-flight write marker: nothing is sent, the state is unknown", async () => {
		const o = origin();
		const a = await o.tab('tab-a');
		await start(a, -12);
		const attempts = a.device.attempts;
		// A write marker of a tab that is gone appears (it may have changed what the cable plays).
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
		expect(a.device.attempts).toBe(attempts);
		expect(a.service.getState().live).toMatchObject({
			status: 'unknown',
			hold: { reason: 'unknown-state' }
		});
		// Recorded like a write would (journal + rescue notice).
		expect(a.journal.entries.at(-1)?.status).toBe('interrupted');
	});
});
