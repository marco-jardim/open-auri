// YOLO publication, classification (migration 0013, GATE_IMPL 2): the server derives the class of
// every curve (standard, yolo, rejected) from the core's `classifyCurve`, caches it in `curves`
// (gate_ok / gate_yolo / gate_reasons) and counts the write-gate runs it spent; HS/LP/HP within the
// limits are standard; a re-gate after a gate change flips the cached class. Every curve is unique,
// so the file can share the database.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { NEUTRAL_BANDS } from 'open-auri/dsp';
import { classifyCurve, gateForWrite } from 'open-auri/safety';
import { curveId, decodeS1, encodeS1 } from 'open-auri/share';
import {
	checkPublishable,
	GATE_IMPL,
	gateVersion,
	hardCodes,
	regateCurve
} from '#lib/server/social/gate.ts';
import { getCurve, saveCurveGate } from '#lib/server/social/repo.ts';
import {
	presetCurve,
	uniqueRejectedCurve,
	uniqueShelfCurve,
	uniqueUltrasonicCut,
	uniqueYoloCurve
} from '../curves/helpers.ts';

type Curve = Parameters<typeof encodeS1>[0];
type Band = Curve['bands'][number];

/** Counting wrappers of the write gate and of the classifier (the production functions). */
function spies(): {
	deps: { gate: typeof gateForWrite; classify: typeof classifyCurve };
	gateRuns: () => number;
	classifications: () => number;
} {
	let gateRuns = 0;
	let classifications = 0;
	const gate: typeof gateForWrite = (bands, preampDb, options) => {
		gateRuns++;
		return gateForWrite(bands, preampDb, options);
	};
	const classify: typeof classifyCurve = (bands, preampDb, options) => {
		classifications++;
		return classifyCurve(bands, preampDb, options);
	};
	return {
		deps: { gate, classify },
		gateRuns: () => gateRuns,
		classifications: () => classifications
	};
}

async function row(
	id: string
): Promise<{ gate_ok: number; gate_yolo: number; gate_reasons: string; gate_ver: string } | null> {
	return env.DB.prepare(
		'SELECT gate_ok, gate_yolo, gate_reasons, gate_ver FROM curves WHERE id = ?'
	)
		.bind(id)
		.first<{ gate_ok: number; gate_yolo: number; gate_reasons: string; gate_ver: string }>();
}

function randomInt(min: number, max: number): number {
	const [value = 0] = crypto.getRandomValues(new Uint32Array(1));
	return min + (value % (max - min + 1));
}

describe('server classification and its cache', () => {
	it('is GATE_IMPL 2', () => {
		expect(GATE_IMPL).toBe(2);
	});

	it('a YOLO curve is classified once (two gate runs), cached with its waived codes', async () => {
		const s1 = encodeS1(uniqueYoloCurve());
		const spy = spies();
		const first = await checkPublishable(env.DB, s1, Date.now(), spy.deps);
		if (!first.ok) throw new Error(`expected a storable curve, got ${first.code}`);
		expect(first.class).toBe('yolo');
		expect(first.waived).toContain('d7:pk-boost-above-16k');
		expect(first.gateRuns).toBe(2);
		expect(spy.gateRuns()).toBe(1);
		expect(spy.classifications()).toBe(1);
		expect(first.curve.gateOk).toBe(false);
		expect(first.curve.gateYolo).toBe(true);

		const stored = await row(first.curve.id);
		expect(stored?.gate_ok).toBe(0);
		expect(stored?.gate_yolo).toBe(1);
		expect(JSON.parse(stored?.gate_reasons ?? '[]')).toEqual(first.waived);
		expect(stored?.gate_ver).toBe(await gateVersion());

		const second = await checkPublishable(env.DB, s1, Date.now(), spy.deps);
		expect(second.ok && second.class).toBe('yolo');
		expect(second.gateRuns).toBe(0);
		expect(spy.gateRuns()).toBe(1);
		expect(spy.classifications()).toBe(1);
	});

	it('a standard curve runs the write gate only (no classifier run)', async () => {
		const spy = spies();
		const curve = presetCurve(3);
		// A lower preamp only lowers every peak: still standard, and most likely not cached yet.
		const preampDb = Math.max(Math.round(curve.preampDb * 10 - randomInt(1, 9)) / 10, -25.5);
		const s1 = encodeS1({ ...curve, preampDb });
		const check = await checkPublishable(env.DB, s1, Date.now(), spy.deps);
		if (!check.ok) throw new Error(`expected standard, got ${check.code}`);
		expect(check.class).toBe('standard');
		expect(check.waived).toEqual([]);
		expect(check.gateRuns).toBeLessThanOrEqual(1);
		expect(spy.classifications()).toBe(0);
	});

	it('a curve that fails a hard reason is rejected without a YOLO run, with `hard` codes', async () => {
		const spy = spies();
		const s1 = encodeS1(uniqueRejectedCurve());
		const check = await checkPublishable(env.DB, s1, Date.now(), spy.deps);
		if (check.ok || check.code !== 'gate-rejected') throw new Error('expected gate-rejected');
		expect(check.reasons).toContain('e:output-audible');
		expect(check.hard).toContain('e:output-audible');
		expect(check.hard).toEqual(hardCodes(check.reasons));
		expect(check.gateRuns).toBe(1);
		expect(spy.gateRuns()).toBe(1);
		expect(spy.classifications()).toBe(1);
		const stored = await row(check.curve.id);
		expect(stored?.gate_ok).toBe(0);
		expect(stored?.gate_yolo).toBe(0);
	});

	it('HS, LP and HP within the limits are standard (experimental derived from the curve)', async () => {
		const shelf = await checkPublishable(env.DB, encodeS1(uniqueShelfCurve()));
		expect(shelf.ok && shelf.class).toBe('standard');

		const highPass: Band = { kind: 'HP', freqHz: randomInt(100, 200), qFactor: 0.71 };
		const lowPass: Band = { kind: 'LP', freqHz: randomInt(12_000, 18_000), qFactor: 0.71 };
		const bands = NEUTRAL_BANDS.map((neutral, i) =>
			i === 0 ? highPass : i === 1 ? lowPass : neutral
		) as Band[];
		const pass = await checkPublishable(
			env.DB,
			encodeS1({ bands, preampDb: -randomInt(10, 40) / 10 })
		);
		expect(pass.ok && pass.class).toBe('standard');
	});

	it('an S1 v2 curve (a PK cut at 25 kHz) is standard', async () => {
		const s1 = encodeS1(uniqueUltrasonicCut());
		expect(decodeS1(s1).version).toBe(2);
		const check = await checkPublishable(env.DB, s1);
		expect(check.ok && check.class).toBe('standard');
	});
});

describe('a re-gate flips the cached class', () => {
	const STALE = 'v2.1:0000000000000000';

	async function storeStale(
		curve: Curve,
		verdict: { gateOk: boolean; gateYolo?: boolean; gateReasons: string[] }
	): Promise<string> {
		const s1 = encodeS1(curve);
		const id = await curveId(s1);
		const saved = await saveCurveGate(
			env.DB,
			{ id, s1, canonKey: `flip;${id}`, gateVer: STALE, levelDb: null, ...verdict },
			1
		);
		if (!saved.ok) throw new Error(`stale insert failed: ${saved.code}`);
		return id;
	}

	it('an HS shelf rejected by GATE_IMPL 1 (k:kind-not-allowed) becomes standard', async () => {
		const id = await storeStale(uniqueShelfCurve(), {
			gateOk: false,
			gateReasons: ['k:kind-not-allowed']
		});
		const stale = await getCurve(env.DB, id);
		if (!stale) throw new Error('missing stale row');
		const fresh = await regateCurve(env.DB, stale);
		expect(fresh.gateVer).toBe(await gateVersion());
		expect(fresh.gateOk).toBe(true);
		expect(fresh.gateYolo).toBe(false);
		expect(fresh.gateReasons).toEqual([]);
	});

	it('a curve cached as standard by an older gate becomes YOLO', async () => {
		const id = await storeStale(uniqueYoloCurve(), { gateOk: true, gateReasons: [] });
		const stale = await getCurve(env.DB, id);
		if (!stale) throw new Error('missing stale row');
		const fresh = await regateCurve(env.DB, stale);
		expect(fresh.gateOk).toBe(false);
		expect(fresh.gateYolo).toBe(true);
		expect(fresh.gateReasons).toContain('d7:pk-boost-above-16k');
	});

	it('a curve cached as YOLO by an older gate becomes rejected when it fails a hard reason', async () => {
		const id = await storeStale(uniqueRejectedCurve(), {
			gateOk: false,
			gateYolo: true,
			gateReasons: ['c:section-peak']
		});
		const stale = await getCurve(env.DB, id);
		if (!stale) throw new Error('missing stale row');
		expect(stale.gateYolo).toBe(true);
		const fresh = await regateCurve(env.DB, stale);
		expect(fresh.gateOk).toBe(false);
		expect(fresh.gateYolo).toBe(false);
		expect(fresh.gateReasons).toContain('e:output-audible');
	});
});
