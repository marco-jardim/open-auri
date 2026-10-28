/**
 * Comparison on the cable (issues #73/#74, slice 2): `startComparison` / `switchComparison` /
 * `endComparison` on the live preview. A pre-approved, level-matched set: switches never hold,
 * the cable always plays the selected candidate, a blind comparison exposes nothing that tells
 * the candidates apart, and nothing touches the journal, the flash or `cable:written`.
 */
import { afterEach, describe, expect, test } from 'vitest';
import type { FakeFirmware } from 'open-auri/transport';
import { gateForWrite } from 'open-auri/safety';
import { CABLE_WRITE_LOCK, LIVE_BUSY_MAX_ATTEMPTS } from '../../../src/lib/cable/service.ts';
import { planComparison } from '../../../src/lib/cable/compare.ts';
import type {
	Band,
	CableState,
	ComparisonCurve,
	ComparisonStartRequest,
	JournalEntry,
	LiveCurve
} from '../../../src/lib/cable/types.ts';
import { T0, TRUSTED_CLICK, off, setup } from './harness.ts';
import type { MemoryLocks } from './locks-fake.ts';

type Harness = Awaited<ReturnType<typeof setup>>;

const OFF_BANDS: Band[] = Array.from({ length: 10 }, off);

function offCurve(preampDb: number): ComparisonCurve {
	return { bands: OFF_BANDS, preampDb };
}

function pkCurve(preampDb: number, gainDb = 3): ComparisonCurve {
	return {
		bands: [{ kind: 'PK', freqHz: 1000, gainDb, qFactor: 1 }, ...OFF_BANDS.slice(1)],
		preampDb
	};
}

function hsCurve(preampDb: number): ComparisonCurve {
	return {
		bands: [{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 }, ...OFF_BANDS.slice(1)],
		preampDb,
		experimental: true
	};
}

/** Three candidates at different levels. */
const CURVES: ComparisonCurve[] = [pkCurve(-9, 3), offCurve(-12), pkCurve(-10, 1.5)];

function payloadCrc(payload: Uint8Array | null): number | null {
	if (payload === null) return null;
	return (payload[218] ?? 0) | ((payload[219] ?? 0) << 8);
}

function liveCrc(firmware: FakeFirmware): number | null {
	return payloadCrc(firmware.live);
}

function savedEntry(saved: LiveCurve): JournalEntry {
	const verdict = gateForWrite(saved.bands, saved.preampDb, { experimental: false });
	return {
		schema: 1,
		at: T0 - 60_000,
		name: 'Salvo',
		crc: Number(verdict.metrics.payloadCrc),
		preampDb: saved.preampDb,
		bands: [...saved.bands],
		status: 'ok',
		device: 'USB DSP Audio'
	};
}

function expectNoWriteBookkeeping(h: Harness, journal: JournalEntry[] = []) {
	expect(h.journal.entries).toEqual(journal);
	expect(h.flash.records).toEqual([]);
	expect(h.flash.touches).toEqual([]);
	expect(h.written).toEqual([]);
	expect(h.inflight.writes).toEqual([]);
	expect(h.device.firmware.commitCount).toBe(0);
}

/** The next `times` write-lock requests find it busy (another tab holds it). */
function busyWrites(h: Harness, times: number) {
	const base = h.locks;
	if (base === null) throw new Error('the harness has Web Locks by default');
	const original = base.request.bind(base);
	let left = times;
	const request: MemoryLocks['request'] = (name, options, callback) => {
		if (name === CABLE_WRITE_LOCK && options.ifAvailable === true && left > 0) {
			left -= 1;
			return callback(null);
		}
		return original(name, options, callback);
	};
	Object.assign(base, { request });
}

let cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup) dispose();
	cleanup = [];
});

async function harness(options: Parameters<typeof setup>[0] = {}): Promise<Harness> {
	const h = await setup(options);
	cleanup.push(() => h.service.dispose());
	return h;
}

function compare(
	h: Harness,
	extra: Partial<Omit<ComparisonStartRequest, 'gesture'>> = {}
) {
	return h.service.startComparison({
		curves: CURVES,
		match: true,
		blind: false,
		confirmations: { volumeLowered: true },
		...extra,
		gesture: h.service.createGesture(TRUSTED_CLICK)
	});
}

function crcs(curves: readonly ComparisonCurve[] = CURVES, match = true): number[] {
	return planComparison(curves, { match }).items.map((item) => item.crc);
}

describe('startComparison', () => {
	test('applies the first matched candidate; the loudest played level is the confirmed one', async () => {
		const h = await harness();
		const outcome = await compare(h);
		expect(outcome.status).toBe('accepted');
		if (outcome.status !== 'accepted') throw new Error('expected a start');
		const plan = planComparison(CURVES, { match: true });
		expect(liveCrc(h.device.firmware)).toBe(plan.items[0]?.crc);
		expect(outcome.plan.ackLevelDb).toBe(plan.ackLevelDb);
		expect(outcome.plan.items.map((item) => item.preampDb)).toEqual(
			plan.items.map((item) => item.preampDb)
		);
		const live = h.service.getState().live;
		expect(live).toMatchObject({ status: 'live', hold: null, ackLevelDb: plan.ackLevelDb });
		expect(live?.comparison).toMatchObject({
			active: true,
			blind: false,
			count: 3,
			status: 'ready',
			index: 0
		});
		expect(live?.comparison?.items?.map((item) => item.levelDb)).toEqual(
			plan.items.map((item) => item.levelDb)
		);
		expectNoWriteBookkeeping(h);
	});

	test('a given first index is applied first', async () => {
		const h = await harness();
		await compare(h, { first: 2 });
		expect(liveCrc(h.device.firmware)).toBe(crcs()[2]);
		expect(h.service.getState().live?.comparison?.index).toBe(2);
		const refused = await compare(await harness(), { first: 3 });
		expect(refused).toMatchObject({ reason: 'comparison', refusal: { reason: 'bad-index' } });
	});

	test('refused while a live session is active, and without the gesture', async () => {
		const h = await harness();
		expect(
			await h.service.startComparison({
				curves: CURVES,
				match: true,
				blind: false,
				confirmations: { volumeLowered: true },
				gesture: null
			})
		).toMatchObject({ status: 'refused', reason: 'gesture' });
		await h.service.startLive({
			curve: offCurve(-12),
			confirmations: { volumeLowered: true },
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(await compare(h)).toMatchObject({ status: 'refused', reason: 'busy' });
		expect(await compare(await harness({ livePolicy: { enabled: false } }))).toMatchObject({
			status: 'refused',
			reason: 'unavailable'
		});
	});

	test('a plan refusal refuses the start before any I/O', async () => {
		const h = await harness();
		const outcome = await compare(h, { curves: [pkCurve(-6, 3), offCurve(-25.5)] });
		expect(outcome).toMatchObject({
			status: 'refused',
			reason: 'comparison',
			refusal: { reason: 'level-range', index: 0 }
		});
		expect(h.device.attempts).toBe(0);
		expect(h.service.getState().live).toBeNull();
	});

	test('the volume confirmation is required (live checklist)', async () => {
		const h = await harness();
		const outcome = await compare(h, { confirmations: { volumeLowered: false } });
		expect(outcome).toMatchObject({ status: 'refused', reason: 'checklist' });
		expect(h.device.attempts).toBe(0);
	});

	test('experimental union: one experimental candidate requires the confirmation', async () => {
		// Match off: the loudest (checked) candidate is the plain one.
		const curves = [offCurve(-12), hsCurve(-12)];
		const h = await harness();
		const refused = await compare(h, { curves, match: false });
		expect(refused).toMatchObject({ status: 'refused', reason: 'checklist' });
		if (refused.status !== 'refused' || refused.reason !== 'checklist') {
			throw new Error('expected a checklist refusal');
		}
		expect(refused.checklist?.experimentalRequired).toBe(true);
		expect(refused.checklist?.items.find((item) => item.id === 'experimental')).toEqual({
			id: 'experimental',
			required: true,
			satisfied: false
		});
		expect(h.device.attempts).toBe(0);

		const started = await compare(h, {
			curves,
			match: false,
			confirmations: { volumeLowered: true, experimental: true }
		});
		expect(started.status).toBe('accepted');
		// The experimental candidate is never held.
		expect(await h.service.switchComparison(1)).toEqual({ status: 'applied' });
		expect(liveCrc(h.device.firmware)).toBe(
			Number(gateForWrite(curves[1]?.bands ?? [], -12, { experimental: true }).metrics.payloadCrc)
		);
		expect(h.service.getState().live?.hold).toBeNull();
	});
});

describe('switchComparison', () => {
	test('200 random switches never hold; the cable always plays the selected candidate', async () => {
		const h = await harness();
		await compare(h);
		const expected = crcs();
		let seed = 1;
		for (let i = 0; i < 200; i++) {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			const index = seed % CURVES.length;
			const result = await h.service.switchComparison(index);
			expect(result).toEqual({ status: 'applied' });
			expect(liveCrc(h.device.firmware)).toBe(expected[index]);
			const live = h.service.getState().live;
			expect(live?.hold).toBeNull();
			expect(live?.status).toBe('live');
			expect(live?.comparison?.index).toBe(index);
		}
		expect(h.service.getState().live?.applies).toBe(201);
		expectNoWriteBookkeeping(h);
	}, 60_000);

	test('queueLive is refused during a comparison (nothing sent)', async () => {
		const h = await harness();
		await compare(h);
		const attempts = h.device.attempts;
		expect(h.service.queueLive(offCurve(-13))).toBe(false);
		await h.service.whenLiveIdle();
		expect(h.device.attempts).toBe(attempts);
		expect(liveCrc(h.device.firmware)).toBe(crcs()[0]);
	});

	test('a plain live session has no comparison to switch', async () => {
		const h = await harness();
		expect(await h.service.switchComparison(0)).toEqual({ status: 'ended' });
		await h.service.startLive({
			curve: offCurve(-12),
			confirmations: { volumeLowered: true },
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(await h.service.switchComparison(0)).toEqual({ status: 'error' });
	});

	test('an out-of-range index is an error (nothing sent)', async () => {
		const h = await harness();
		await compare(h);
		const attempts = h.device.attempts;
		expect(await h.service.switchComparison(3)).toEqual({ status: 'error' });
		expect(await h.service.switchComparison(0.5)).toEqual({ status: 'error' });
		expect(h.device.attempts).toBe(attempts);
	});

	test('report 8 failed: unknown; later switches are refused up front', async () => {
		const h = await harness();
		await compare(h);
		// Attempts 0..8 were the start apply; attempt 17 is report 8 of the switch.
		h.device.faults.throwAtReport = 17;
		expect(await h.service.switchComparison(1)).toEqual({ status: 'unknown' });
		expect(h.service.getState().live?.comparison?.status).toBe('failed');
		const attempts = h.device.attempts;
		expect(await h.service.switchComparison(2)).toEqual({ status: 'unknown' });
		expect(h.device.attempts).toBe(attempts);
	});

	test('a hold refuses the switch up front', async () => {
		const h = await harness({ journal: [savedEntry(offCurve(-3))] });
		await compare(h);
		// A revert to a much louder saved curve is held (loudness).
		const ended = await h.service.endComparison({
			revert: true,
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(ended).toMatchObject({ reason: 'revert-failed', revertFailure: 'held' });
		const attempts = h.device.attempts;
		expect(await h.service.switchComparison(1)).toEqual({ status: 'held' });
		expect(h.device.attempts).toBe(attempts);
	});

	test('unplugged mid-switch: ended', async () => {
		const h = await harness();
		await compare(h);
		h.device.faults.disconnectAtReport = 12;
		expect(await h.service.switchComparison(1)).toEqual({ status: 'ended' });
		expect(h.service.getState().live).toMatchObject({
			status: 'ended',
			endedReason: 'disconnected',
			comparison: { active: false }
		});
		expect(await h.service.switchComparison(2)).toEqual({ status: 'ended' });
	});

	test('the write lock stays busy: busy, nothing sent, no hold', async () => {
		const h = await harness();
		await compare(h);
		const attempts = h.device.attempts;
		busyWrites(h, LIVE_BUSY_MAX_ATTEMPTS);
		expect(await h.service.switchComparison(1)).toEqual({ status: 'busy' });
		expect(h.device.attempts).toBe(attempts);
		expect(liveCrc(h.device.firmware)).toBe(crcs()[0]);
		expect(h.service.getState().live?.hold).toBeNull();
		// The lock is free again: the next switch goes through.
		expect(await h.service.switchComparison(1)).toEqual({ status: 'applied' });
	});

	test('a second switch while one runs is busy', async () => {
		const h = await harness();
		await compare(h);
		const first = h.service.switchComparison(1);
		expect(await h.service.switchComparison(2)).toEqual({ status: 'busy' });
		expect(await first).toEqual({ status: 'applied' });
		expect(liveCrc(h.device.firmware)).toBe(crcs()[1]);
	});
});

describe('endComparison', () => {
	test('without revert: the session ends, the cable keeps the candidate', async () => {
		const h = await harness();
		await compare(h);
		await h.service.switchComparison(2);
		const outcome = await h.service.endComparison({ revert: false });
		expect(outcome.status).toBe('accepted');
		expect(h.service.getState().live).toMatchObject({
			status: 'ended',
			endedReason: 'stopped',
			comparison: { active: false }
		});
		expect(liveCrc(h.device.firmware)).toBe(crcs()[2]);
		expect(await h.service.endComparison({ revert: false })).toMatchObject({
			reason: 'no-session'
		});
	});

	test('with revert: the saved curve plays again', async () => {
		const saved = offCurve(-14);
		const journal = [savedEntry(saved)];
		const h = await harness({ journal });
		await compare(h);
		await h.service.switchComparison(1);
		const outcome = await h.service.endComparison({
			revert: true,
			gesture: h.service.createGesture(TRUSTED_CLICK),
			saved
		});
		expect(outcome.status).toBe('accepted');
		expect(h.service.getState().live).toMatchObject({ status: 'ended', endedReason: 'reverted' });
		expect(liveCrc(h.device.firmware)).toBe(journal[0]?.crc);
		expectNoWriteBookkeeping(h, journal);
	});

	test('a loudness-held revert is surfaced; the comparison goes on', async () => {
		const journal = [savedEntry(offCurve(-3))];
		const h = await harness({ journal });
		await compare(h);
		const outcome = await h.service.endComparison({
			revert: true,
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(outcome).toMatchObject({
			status: 'refused',
			reason: 'revert-failed',
			revertFailure: 'held'
		});
		expect(h.service.getState().live).toMatchObject({
			status: 'held',
			comparison: { active: true }
		});
		expect(liveCrc(h.device.firmware)).toBe(crcs()[0]);
		// Ending without a revert still works.
		expect((await h.service.endComparison({ revert: false })).status).toBe('accepted');
	});

	test('the originals stay available for "Salvar esta"', async () => {
		const h = await harness();
		expect(h.service.comparisonOriginal(0)).toBeNull();
		await compare(h);
		await h.service.endComparison({ revert: false });
		CURVES.forEach((curve, index) => {
			expect(h.service.comparisonOriginal(index)).toEqual({
				bands: curve.bands,
				preampDb: curve.preampDb
			});
		});
		expect(h.service.comparisonOriginal(3)).toBeNull();
	});
});

describe('blind comparison', () => {
	function expectRedacted(state: CableState) {
		const live = state.live;
		if (live === null) return;
		expect(live.applied).toBeNull();
		expect(live.ackLevelDb).toBeNull();
		expect(live.hold).toBeNull();
		expect(live).not.toHaveProperty('savedCrc');
		if (live.comparison !== undefined) {
			expect(Object.keys(live.comparison).sort()).toEqual(['active', 'blind', 'count', 'status']);
			expect(live.comparison.blind).toBe(true);
		}
	}

	test('the state never exposes the CRC, level, hold or index', async () => {
		const journal = [savedEntry(offCurve(-14))];
		const h = await harness({ journal });
		const states: CableState[] = [];
		const stop = h.service.subscribe((state) => states.push(state));
		try {
			const outcome = await compare(h, { blind: true });
			expect(outcome.status).toBe('accepted');
			for (const index of [1, 2, 0, 2, 1]) {
				expect(await h.service.switchComparison(index)).toEqual({ status: 'applied' });
				expect(liveCrc(h.device.firmware)).toBe(crcs()[index]);
			}
			// A failed switch is coarse too.
			h.device.faults.throwAtReport = h.device.attempts + 8;
			expect(await h.service.switchComparison(0)).toEqual({ status: 'unknown' });
			expect(h.service.getState().live?.comparison?.status).toBe('failed');
		} finally {
			stop();
		}
		const live = states.filter((state) => state.live?.comparison !== undefined);
		expect(live.length).toBeGreaterThan(5);
		for (const state of states) expectRedacted(state);
		expectNoWriteBookkeeping(h, journal);
	});
});
