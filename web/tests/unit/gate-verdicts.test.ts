/**
 * The client's one cache of full-grid write-gate verdicts (`gate-verdicts.ts`): the curve store,
 * the audio engine and the Curva preview read it, so each curve is judged once per profile. Keyed
 * on the canonical snapshot (raw and snapshot inputs share an entry), the preamp, the
 * experimental flag and the profile; LRU of `GATE_VERDICTS_KEPT`; plain data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { snapshotBands } from 'open-auri/dsp';
import { gateForWrite } from 'open-auri/safety';
import {
	clearGateVerdicts,
	gateAccepts,
	gateVerdict,
	GATE_VERDICTS_KEPT
} from '#lib/gate-verdicts.ts';
import { standardGateAccepts, type Band } from '#lib/audio/engine.ts';
import { gateAccepts as storeGateAccepts } from '#lib/state/curve.svelte.ts';
import { checkedCurve } from '#lib/state/model.ts';

vi.mock('open-auri/safety', async (importOriginal) => {
	const actual = await importOriginal<typeof import('open-auri/safety')>();
	return { ...actual, gateForWrite: vi.fn(actual.gateForWrite) };
});

/** Full-grid gate runs since the last reset. */
const runs = () => vi.mocked(gateForWrite).mock.calls.length;
const pad = (active: Band[]): Band[] => [...active, ...NEUTRO.bands.slice(active.length)];
/** Refused by the standard gate, accepted by the YOLO one: HP 30 Hz (an experimental kind). */
const YOLO_ONLY = pad([{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]);
const neutro = (): Band[] => NEUTRO.bands.slice();

beforeEach(() => {
	clearGateVerdicts();
	vi.mocked(gateForWrite).mockClear();
});
afterEach(() => clearGateVerdicts());

describe('one entry per canonical curve', () => {
	it('a raw list and its snapshot share an entry, with the verdict the raw list gets', () => {
		// Extra fields on OFF, an LP with a zero gain and another key order: all canonicalized.
		const raw: Band[] = pad([
			Object.assign({ kind: 'OFF' as const }, { freqHz: 100, gainDb: 3 }),
			{ qFactor: 1, gainDb: -6, freqHz: 1000, kind: 'PK' },
			Object.assign({ kind: 'LP' as const, freqHz: 18000, qFactor: 0.71 }, { gainDb: 0 })
		]);
		const first = gateVerdict(raw, -1);
		expect(gateVerdict(snapshotBands(raw), -1)).toBe(first);
		expect(gateVerdict(raw.map((band) => ({ ...band })), -1)).toBe(first);
		expect(runs()).toBe(1);
		// Experimental by default (LP): the flag the write gate would get.
		expect(first.ok).toBe(gateForWrite(raw, -1, { experimental: true }).ok);
	});

	it('the profile and the experimental flag are part of the key', () => {
		const standard = gateVerdict(YOLO_ONLY, -0.5);
		const yolo = gateVerdict(YOLO_ONLY, -0.5, { profile: 'yolo' });
		expect(standard.ok).toBe(false);
		expect(yolo.ok).toBe(true);
		expect(yolo).not.toBe(standard);
		// The default flag is derived from the bands: HP is experimental.
		expect(gateVerdict(YOLO_ONLY, -0.5, { experimental: true })).toBe(standard);
		const unflagged = gateVerdict(YOLO_ONLY, -0.5, { experimental: false, profile: 'yolo' });
		expect(unflagged).not.toBe(yolo);
		expect(gateAccepts(YOLO_ONLY, -0.5, { profile: 'yolo' })).toBe(true);
		expect(runs()).toBe(3);
		// The unflagged entry is the gate's own verdict without the flag.
		expect(unflagged.ok).toBe(
			gateForWrite(YOLO_ONLY, -0.5, { experimental: false, profile: 'yolo' }).ok
		);
	});

	it('numbers are keyed by their exact value: -0, 0, NaN and the infinities stay apart', () => {
		const values = [0, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1];
		const verdicts = values.map((preampDb) => gateVerdict(neutro(), preampDb));
		expect(new Set(verdicts).size).toBe(values.length);
		expect(runs()).toBe(values.length);
		// Each one is cached, NaN included.
		values.forEach((preampDb, index) => {
			expect(gateVerdict(neutro(), preampDb)).toBe(verdicts[index]);
		});
		expect(runs()).toBe(values.length);
		const band = (freqHz: number): Band[] => pad([{ kind: 'PK', freqHz, gainDb: -3, qFactor: 1 }]);
		expect(gateVerdict(band(1000), -1)).not.toBe(gateVerdict(band(1000.0000001), -1));
	});

	it('anything but plain data is judged every time, never cached', () => {
		/** Passes the standard gate. */
		const cut = pad([{ kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 }]);
		// A string where a number belongs: the gate refuses it, and it is not keyed.
		const text = cut.map((band, index) =>
			index === 0 ? Object.assign({}, band, { freqHz: '1000' }) : band
		);
		const once = gateVerdict(text, -1);
		const twice = gateVerdict(text, -1);
		expect(once.ok).toBe(false);
		expect(twice).not.toBe(once);
		expect(runs()).toBe(2);
		// The number it looks like has an entry of its own.
		const number = gateVerdict(cut, -1);
		expect(number).not.toBe(once);
		expect(number.ok).toBe(true);
		expect(gateVerdict(cut, -1)).toBe(number);
		expect(runs()).toBe(3);
	});
});

describe('least recently used out first', () => {
	const preamp = (index: number) => -1 - index / 10;

	it(`keeps ${GATE_VERDICTS_KEPT} entries; a hit makes an entry the newest`, () => {
		expect(GATE_VERDICTS_KEPT).toBe(64);
		const kept = Array.from({ length: GATE_VERDICTS_KEPT }, (_, index) =>
			gateVerdict(neutro(), preamp(index))
		);
		expect(runs()).toBe(GATE_VERDICTS_KEPT);
		// Full: every entry is still there.
		expect(gateVerdict(neutro(), preamp(0))).toBe(kept[0]);
		expect(runs()).toBe(GATE_VERDICTS_KEPT);
		// One more: the least recently used goes (entry 1; entry 0 was just read).
		gateVerdict(neutro(), preamp(GATE_VERDICTS_KEPT));
		expect(runs()).toBe(GATE_VERDICTS_KEPT + 1);
		expect(gateVerdict(neutro(), preamp(0))).toBe(kept[0]);
		expect(gateVerdict(neutro(), preamp(2))).toBe(kept[2]);
		expect(runs()).toBe(GATE_VERDICTS_KEPT + 1);
		const again = gateVerdict(neutro(), preamp(1));
		expect(again).not.toBe(kept[1]);
		expect(again.ok).toBe(kept[1]?.ok);
		expect(runs()).toBe(GATE_VERDICTS_KEPT + 2);
	});
});

describe('shared by the engine and the curve store', () => {
	it('one full-grid run serves the engine, the store and a direct read of the same curve', () => {
		const stored = checkedCurve({
			schema: 1,
			name: 'Subsônica',
			source: 'custom',
			preampDb: -0.5,
			bands: YOLO_ONLY,
			labels: null,
			updatedAt: 1
		});
		// The engine reads the raw bands (preview protection), the store its frozen snapshot.
		expect(standardGateAccepts(YOLO_ONLY, -0.5)).toBe(false);
		expect(storeGateAccepts(stored, 'standard')).toBe(false);
		expect(gateAccepts(snapshotBands(YOLO_ONLY), -0.5)).toBe(false);
		expect(runs()).toBe(1);
		// The store's YOLO question is another entry, judged once.
		expect(storeGateAccepts(stored, 'yolo')).toBe(true);
		expect(gateAccepts(YOLO_ONLY, -0.5, { profile: 'yolo' })).toBe(true);
		expect(runs()).toBe(2);
	});
});
