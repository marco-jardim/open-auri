/**
 * Comparison on the cable (issues #73/#74, slice 2): `startComparison` / `switchComparison` /
 * `endComparison` on the live preview. A pre-approved, level-matched set: switches never hold,
 * the cable always plays the selected candidate, a blind comparison exposes nothing that tells
 * the candidates apart, and nothing touches the journal, the flash or `cable:written`.
 */
import { afterEach, describe, expect, test } from 'vitest';
import type { FakeFirmware } from 'open-auri/transport';
import { gateForWrite } from 'open-auri/safety';
import {
	CABLE_WRITE_LOCK,
	LIVE_BUSY_MAX_ATTEMPTS,
	LIVE_MARKER_BLIND_CRC
} from '../../../src/lib/cable/service.ts';
import { planComparison } from '../../../src/lib/cable/compare.ts';
import type {
	Band,
	CableState,
	ComparisonCurve,
	ComparisonStartRequest,
	JournalEntry,
	LiveCurve
} from '../../../src/lib/cable/types.ts';
import { CONFIRMED, T0, TRUSTED_CLICK, off, setup } from './harness.ts';
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

function compare(h: Harness, extra: Partial<Omit<ComparisonStartRequest, 'gesture'>> = {}) {
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
		// 31-bit LCG on 32-bit integer arithmetic (Math.imul): the state never leaves 2^31.
		let seed = 1;
		for (let i = 0; i < 200; i++) {
			seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
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
		// A hold keeps its reason only (never the delta, gate reasons or anything per candidate).
		if (live.hold !== null) {
			expect(Object.keys(live.hold).filter((key) => key !== 'curve')).toEqual(['reason']);
		}
		expect([null, 'busy', 'error']).toContain(live.lastError);
		expect(typeof live.playsUnsaved).toBe('boolean');
		expect(typeof live.cableEq).toBe('boolean');
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
			// The hold says why (unknown state), never which candidate.
			expect(h.service.getState().live?.hold).toEqual({ reason: 'unknown-state' });
		} finally {
			stop();
		}
		const live = states.filter((state) => state.live?.comparison !== undefined);
		expect(live.length).toBeGreaterThan(5);
		for (const state of states) expectRedacted(state);
		expectNoWriteBookkeeping(h, journal);
	});

	test('non-identifying flags stay truthful (unsaved, cable EQ), also after the end', async () => {
		const journal = [savedEntry(offCurve(-14))];
		const h = await harness({ journal });
		await compare(h, { blind: true });
		expect(h.service.getState().live).toMatchObject({
			status: 'live',
			applied: null,
			playsUnsaved: true,
			cableEq: true
		});
		expect(await h.service.switchComparison(1)).toEqual({ status: 'applied' });
		expect(h.service.getState().live).toMatchObject({ playsUnsaved: true, cableEq: true });
		// Report 8 unconfirmed: unknown, so unsaved but not known to apply the EQ.
		h.device.faults.throwAtReport = h.device.attempts + 8;
		expect(await h.service.switchComparison(2)).toEqual({ status: 'unknown' });
		const unknown = h.service.getState().live;
		expect(unknown).toMatchObject({
			status: 'unknown',
			hold: { reason: 'unknown-state' },
			playsUnsaved: true,
			cableEq: false,
			lastError: 'error'
		});
		expectRedacted(h.service.getState());
		// "Reaplicar" re-applies the current candidate (no detail exposed either way).
		const reapplied = await h.service.confirmLive({
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(reapplied.status).toBe('accepted');
		expect(liveCrc(h.device.firmware)).toBe(crcs()[2]);
		expect(h.service.getState().live).toMatchObject({ hold: null, cableEq: true });
		// Ended, the candidate kept on the cable: still redacted, flags still truthful.
		expect((await h.service.endComparison({ revert: false })).status).toBe('accepted');
		const ended = h.service.getState();
		expect(ended.live).toMatchObject({
			status: 'ended',
			endedReason: 'stopped',
			applied: null,
			playsUnsaved: true,
			cableEq: true
		});
		expectRedacted(ended);
	});

	test('the flags never single out the candidate that is the saved curve, also after a stop', async () => {
		// Candidate 1 (the quietest, never lowered) is the cable's saved curve.
		const journal = [savedEntry(offCurve(-12))];
		const h = await harness({ journal });
		expect(crcs()[1]).toBe(journal[0]?.crc);
		await compare(h, { blind: true });
		const flags = () => {
			const live = h.service.getState().live;
			return { playsUnsaved: live?.playsUnsaved, cableEq: live?.cableEq };
		};
		const seen: ReturnType<typeof flags>[] = [];
		for (const index of [1, 2, 1, 0, 1]) {
			expect(await h.service.switchComparison(index)).toEqual({ status: 'applied' });
			expect(liveCrc(h.device.firmware)).toBe(crcs()[index]);
			seen.push(flags());
		}
		for (const entry of seen) expect(entry).toEqual({ playsUnsaved: true, cableEq: true });
		// Stopped on the saved-curve candidate: the same flags as on any other one.
		expect((await h.service.endComparison({ revert: false })).status).toBe('accepted');
		expect(liveCrc(h.device.firmware)).toBe(crcs()[1]);
		expect(h.service.getState().live).toMatchObject({
			status: 'ended',
			endedReason: 'stopped',
			playsUnsaved: true,
			cableEq: true
		});
		expectRedacted(h.service.getState());
	});

	test('the flags after a stop on another candidate match the saved-curve one', async () => {
		const journal = [savedEntry(offCurve(-12))];
		const h = await harness({ journal });
		await compare(h, { blind: true });
		expect(await h.service.switchComparison(2)).toEqual({ status: 'applied' });
		expect((await h.service.endComparison({ revert: false })).status).toBe('accepted');
		expect(h.service.getState().live).toMatchObject({
			status: 'ended',
			endedReason: 'stopped',
			playsUnsaved: true,
			cableEq: true
		});
	});

	test('needs match: refused before any I/O', async () => {
		const h = await harness();
		const outcome = await compare(h, { blind: true, match: false });
		expect(outcome).toEqual({
			status: 'refused',
			reason: 'comparison',
			refusal: { reason: 'blind-needs-match' }
		});
		expect(h.device.attempts).toBe(0);
		expect(h.service.getState().live).toBeNull();
	});

	test('saves are refused while it runs (nothing sent), and allowed once it ended', async () => {
		const journal = [savedEntry(offCurve(-14))];
		const h = await harness({ journal });
		await compare(h, { blind: true });
		await h.service.switchComparison(1);
		const attempts = h.device.attempts;
		const refused = await h.service.write({
			bands: OFF_BANDS,
			preampDb: -12,
			experimental: false,
			confirmations: CONFIRMED,
			gesture: h.service.createGesture(TRUSTED_CLICK),
			name: 'Salvo'
		});
		expect(refused).toMatchObject({ status: 'refused', reason: 'blind' });
		expect(h.device.attempts).toBe(attempts);
		expectNoWriteBookkeeping(h, journal);
		expect((await h.service.endComparison({ revert: false })).status).toBe('accepted');
		const original = h.service.comparisonOriginal(1);
		if (original === null) throw new Error('expected the original');
		const saved = await h.service.write({
			...original,
			experimental: false,
			confirmations: CONFIRMED,
			gesture: h.service.createGesture(TRUSTED_CLICK),
			name: 'Salvo'
		});
		expect(saved.status).toBe('ok');
	});

	test('the live marker never stores the playing CRC, even for the saved curve', async () => {
		// Candidate 1 (the quietest, never lowered) is the cable's saved curve.
		const journal = [savedEntry(offCurve(-12))];
		const h = await harness({ journal });
		const marker = () => (h.liveMarker.value === null ? null : JSON.parse(h.liveMarker.value));
		await compare(h, { blind: true });
		expect(marker()).toMatchObject({ device: 'USB DSP Audio', crc: LIVE_MARKER_BLIND_CRC });
		for (const index of [1, 2, 1, 0]) {
			expect(await h.service.switchComparison(index)).toEqual({ status: 'applied' });
			// Kept (and opaque) even while the saved curve plays: its presence names nothing.
			expect(marker()).toMatchObject({ crc: LIVE_MARKER_BLIND_CRC });
		}
		// Reverted at the end: the saved curve plays, the marker is gone.
		const ended = await h.service.endComparison({
			revert: true,
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(ended.status).toBe('accepted');
		expect(h.liveMarker.value).toBeNull();
	});
});

describe('the confirmed level is never lowered during a comparison', () => {
	/** Match off: the candidates are 6 dB apart; the set's level is the loudest one's. */
	const plan = planComparison(CURVES, { match: false });
	const levels = plan.items.map((item) => item.levelDb);
	const loudest = levels.indexOf(Math.max(...levels));
	const quietest = levels.indexOf(Math.min(...levels));

	/** Switches to `index`: it is applied below the confirmed level + 3 dB, or held. */
	async function switchSafely(h: Harness, index: number) {
		const confirmed = h.service.getState().live?.ackLevelDb ?? null;
		if (confirmed === null) throw new Error('expected a confirmed level');
		const result = await h.service.switchComparison(index);
		if (result.status === 'held') {
			expect(h.service.getState().live?.hold).toMatchObject({ reason: 'loudness' });
			return result;
		}
		expect(result).toEqual({ status: 'applied' });
		expect(levels[index]).toBeLessThan(confirmed + 3);
		expect(liveCrc(h.device.firmware)).toBe(plan.items[index]?.crc);
		return result;
	}

	test('the set spans more than 3 dB (the cases below would otherwise play louder)', () => {
		expect(plan.refusal).toBeUndefined();
		expect((levels[loudest] ?? 0) - (levels[quietest] ?? 0)).toBeGreaterThan(3);
	});

	test('after "Salvar" of a quiet curve', async () => {
		const h = await harness();
		await compare(h, { match: false, first: quietest });
		const saved = await h.service.write({
			bands: OFF_BANDS,
			preampDb: -20,
			experimental: false,
			confirmations: CONFIRMED,
			gesture: h.service.createGesture(TRUSTED_CLICK),
			name: 'Salvo'
		});
		expect(saved.status).toBe('ok');
		expect(h.service.getState().live).toMatchObject({
			ackLevelDb: plan.ackLevelDb,
			playsUnsaved: false,
			cableEq: true
		});
		expect((await switchSafely(h, loudest)).status).toBe('applied');
		expect(h.service.getState().live).toMatchObject({ playsUnsaved: true });
		for (const index of [quietest, loudest, 2, loudest]) await switchSafely(h, index);
	});

	test('revertLive is refused (the comparison ends with endComparison)', async () => {
		const quiet = offCurve(-20);
		const journal = [savedEntry(quiet)];
		const h = await harness({ journal });
		await compare(h, { match: false });
		const attempts = h.device.attempts;
		expect(
			await h.service.revertLive({ gesture: h.service.createGesture(TRUSTED_CLICK), saved: quiet })
		).toMatchObject({ status: 'refused', reason: 'comparison-active' });
		expect(
			await h.service.stopLive({
				revert: true,
				gesture: h.service.createGesture(TRUSTED_CLICK),
				saved: quiet
			})
		).toMatchObject({ status: 'refused', reason: 'comparison-active' });
		expect(h.device.attempts).toBe(attempts);
		expect(h.service.getState().live).toMatchObject({
			status: 'live',
			ackLevelDb: plan.ackLevelDb,
			comparison: { active: true }
		});
		await switchSafely(h, quietest);
		expect((await switchSafely(h, loudest)).status).toBe('applied');
		expectNoWriteBookkeeping(h, journal);
	});

	test('after "Reaplicar" of an unknown state (match off)', async () => {
		const h = await harness();
		await compare(h, { match: false, first: loudest });
		// The switch to the quietest goes out unconfirmed.
		h.device.faults.throwAtReport = h.device.attempts + 8;
		expect(await h.service.switchComparison(quietest)).toEqual({ status: 'unknown' });
		const reapplied = await h.service.confirmLive({
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(reapplied.status).toBe('accepted');
		// The current candidate (the quietest) plays again; the confirmed level stays the set's.
		expect(liveCrc(h.device.firmware)).toBe(plan.items[quietest]?.crc);
		expect(h.service.getState().live).toMatchObject({
			status: 'live',
			hold: null,
			ackLevelDb: plan.ackLevelDb,
			comparison: { index: quietest, status: 'ready' }
		});
		expect((await switchSafely(h, loudest)).status).toBe('applied');
	});

	test('"Reaplicar" after a save went out unconfirmed re-applies the candidate, not the save', async () => {
		const h = await harness();
		await compare(h, { match: false, first: quietest });
		// Report 8 of the save's data reports fails: the cable state is unknown.
		h.device.faults.throwAtReport = h.device.attempts + 8;
		const saved = await h.service.write({
			bands: OFF_BANDS,
			preampDb: -20,
			experimental: false,
			confirmations: CONFIRMED,
			gesture: h.service.createGesture(TRUSTED_CLICK),
			name: 'Salvo'
		});
		expect(saved.status).not.toBe('ok');
		expect(h.service.getState().live).toMatchObject({
			status: 'unknown',
			hold: { reason: 'unknown-state' }
		});
		const reapplied = await h.service.confirmLive({
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(reapplied.status).toBe('accepted');
		expect(liveCrc(h.device.firmware)).toBe(plan.items[quietest]?.crc);
		expect(h.service.getState().live?.ackLevelDb).toBe(plan.ackLevelDb);
		expect((await switchSafely(h, loudest)).status).toBe('applied');
	});
});

describe('cancelHold', () => {
	test('drops a held revert without I/O; the candidate keeps playing and switches go on', async () => {
		const h = await harness({ journal: [savedEntry(offCurve(-3))] });
		await compare(h);
		const ended = await h.service.endComparison({
			revert: true,
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(ended).toMatchObject({ reason: 'revert-failed', revertFailure: 'held' });
		expect(h.service.getState().live?.hold).toMatchObject({ reason: 'loudness', curve: 'saved' });
		const attempts = h.device.attempts;
		expect(h.service.cancelHold()).toEqual({ status: 'cleared' });
		expect(h.device.attempts).toBe(attempts);
		expect(liveCrc(h.device.firmware)).toBe(crcs()[0]);
		expect(h.service.getState().live).toMatchObject({
			status: 'live',
			hold: null,
			comparison: { active: true, status: 'ready', index: 0 }
		});
		expect(h.service.cancelHold()).toEqual({ status: 'no-hold' });
		expect(await h.service.switchComparison(2)).toEqual({ status: 'applied' });
		expect(liveCrc(h.device.firmware)).toBe(crcs()[2]);
		expect((await h.service.endComparison({ revert: false })).status).toBe('accepted');
		expect(h.service.cancelHold()).toEqual({ status: 'ended' });
	});

	test('a blind comparison too (nothing about the candidate is exposed)', async () => {
		const h = await harness({ journal: [savedEntry(offCurve(-3))] });
		await compare(h, { blind: true });
		await h.service.endComparison({
			revert: true,
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(h.service.getState().live?.hold).toEqual({ reason: 'loudness', curve: 'saved' });
		expect(h.service.cancelHold()).toEqual({ status: 'cleared' });
		expect(h.service.getState().live).toMatchObject({
			status: 'live',
			hold: null,
			comparison: { status: 'ready' }
		});
		expect(liveCrc(h.device.firmware)).toBe(crcs()[0]);
	});

	test('an unknown state is not cleared: "Reaplicar" re-applies the current candidate', async () => {
		const h = await harness();
		await compare(h);
		h.device.faults.throwAtReport = h.device.attempts + 8;
		expect(await h.service.switchComparison(1)).toEqual({ status: 'unknown' });
		const attempts = h.device.attempts;
		expect(h.service.cancelHold()).toEqual({ status: 'unknown' });
		expect(h.device.attempts).toBe(attempts);
		expect(h.service.getState().live?.status).toBe('unknown');
	});

	test('a plain live session has no comparison hold to cancel', async () => {
		const h = await harness();
		expect(h.service.cancelHold()).toEqual({ status: 'ended' });
		await h.service.startLive({
			curve: offCurve(-12),
			confirmations: { volumeLowered: true },
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(h.service.cancelHold()).toEqual({ status: 'error' });
	});
});

describe('confirmEndComparison', () => {
	/** A comparison whose revert is held (the saved curve is much louder than the set). */
	async function heldRevert(blind: boolean) {
		const journal = [savedEntry(offCurve(-3))];
		const h = await harness({ journal });
		await compare(h, { blind });
		const ended = await h.service.endComparison({
			revert: true,
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(ended).toMatchObject({ reason: 'revert-failed', revertFailure: 'held' });
		expect(h.service.getState().live?.hold).toMatchObject({ reason: 'loudness', curve: 'saved' });
		return { h, journal };
	}

	test('blind: the held saved curve plays, the session ends reverted, flags and marker are back to saved', async () => {
		const { h, journal } = await heldRevert(true);
		expect(h.liveMarker.value).not.toBeNull();
		const outcome = await h.service.confirmEndComparison({
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(outcome.status).toBe('accepted');
		expect(liveCrc(h.device.firmware)).toBe(journal[0]?.crc);
		expect(h.service.getState().live).toMatchObject({
			status: 'ended',
			endedReason: 'reverted',
			playsUnsaved: false,
			cableEq: false,
			comparison: { active: false }
		});
		// The saved curve plays again: no preview marker is left behind (blind too).
		expect(h.liveMarker.value).toBeNull();
		expectNoWriteBookkeeping(h, journal);
	});

	test('not blind: the same end (reverted, not stopped)', async () => {
		const { h, journal } = await heldRevert(false);
		const outcome = await h.service.confirmEndComparison({
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(outcome.status).toBe('accepted');
		expect(liveCrc(h.device.firmware)).toBe(journal[0]?.crc);
		expect(h.service.getState().live).toMatchObject({
			status: 'ended',
			endedReason: 'reverted',
			playsUnsaved: false
		});
	});

	test('an apply that did not land is not reported as reverted; the session goes on', async () => {
		const { h, journal } = await heldRevert(true);
		// Report 8 of the saved curve's apply goes out unconfirmed: what the cable plays is unknown.
		h.device.faults.throwAtReport = h.device.attempts + 8;
		const outcome = await h.service.confirmEndComparison({
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(outcome).toMatchObject({
			status: 'refused',
			reason: 'revert-failed',
			revertFailure: 'unknown'
		});
		expect(h.service.getState().live).toMatchObject({
			status: 'unknown',
			playsUnsaved: true,
			comparison: { active: true }
		});
		expect(h.service.getState().live?.endedReason).toBeUndefined();
		// The marker stays: the cable may not play its saved curve.
		expect(h.liveMarker.value).not.toBeNull();
		expectNoWriteBookkeeping(h, journal);
	});

	test('refused without a held revert, and without a fresh gesture (nothing sent)', async () => {
		const h = await harness({ journal: [savedEntry(offCurve(-3))] });
		expect(
			await h.service.confirmEndComparison({ gesture: h.service.createGesture(TRUSTED_CLICK) })
		).toMatchObject({ reason: 'no-session' });
		await compare(h, { blind: true });
		const attempts = h.device.attempts;
		expect(
			await h.service.confirmEndComparison({ gesture: h.service.createGesture(TRUSTED_CLICK) })
		).toMatchObject({ reason: 'no-hold' });
		await h.service.endComparison({
			revert: true,
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(await h.service.confirmEndComparison({ gesture: null })).toMatchObject({
			reason: 'gesture'
		});
		expect(h.device.attempts).toBe(attempts);
		expect(h.service.getState().live).toMatchObject({
			hold: { reason: 'loudness', curve: 'saved' },
			comparison: { active: true }
		});
	});
});

describe('startComparison validation', () => {
	test('a missing or non-object candidate is refused before any I/O', async () => {
		const h = await harness();
		const curves = [offCurve(-12), null] as unknown as ComparisonCurve[];
		expect(await compare(h, { curves })).toEqual({
			status: 'refused',
			reason: 'comparison',
			refusal: { reason: 'invalid', index: 1 }
		});
		expect(h.device.attempts).toBe(0);
		expect(h.service.getState().live).toBeNull();
	});

	test('a refused set leaves the gesture token unspent', async () => {
		const h = await harness();
		const gesture = h.service.createGesture(TRUSTED_CLICK);
		const request = {
			curves: CURVES,
			match: true,
			blind: false,
			confirmations: { volumeLowered: true },
			gesture
		};
		expect(await h.service.startComparison({ ...request, first: 7 })).toMatchObject({
			refusal: { reason: 'bad-index' }
		});
		expect((await h.service.startComparison(request)).status).toBe('accepted');
		// Spent now: it cannot start another one.
		await h.service.endComparison({ revert: false });
		expect(await h.service.startComparison(request)).toMatchObject({
			status: 'refused',
			reason: 'gesture'
		});
	});
});
