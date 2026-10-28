/**
 * Live preview across tabs (issue #68, S5): the session lock `oa-cable-live`, `live-elsewhere`
 * refusals, the `oa.cable.live` marker and orphan previews left by a tab that is gone.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { gateForWrite } from 'open-auri/safety';
import {
	CABLE_LIVE_LOCK,
	cableAliveLock,
	parseLiveMarker
} from '../../../src/lib/cable/service.ts';
import type { Band, LiveCurve } from '../../../src/lib/cable/types.ts';
import { CONFIRMED, TRUSTED_CLICK, off, setup, type SetupOptions } from './harness.ts';
import { memoryInflight, memoryLocks, type MemoryInflight } from './locks-fake.ts';

type Harness = Awaited<ReturnType<typeof setup>>;

const OFF_BANDS: Band[] = Array.from({ length: 10 }, off);

function curve(preampDb: number): LiveCurve {
	return { bands: OFF_BANDS, preampDb };
}

function crcOf(preampDb: number): number {
	return Number(gateForWrite(OFF_BANDS, preampDb, { experimental: false }).metrics.payloadCrc);
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
	test('written before the first apply, removed after a successful revert', async () => {
		const o = origin();
		const a = await o.tab('tab-a');
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
		const request = { bands: OFF_BANDS, preampDb: -11, experimental: false, confirmations: CONFIRMED };
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
