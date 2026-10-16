// Gate cache of the social layer (T4.1c): S1 validation, one gate run per curve and gate version,
// rejected curves cached too, the 11 official presets accepted, stale rows re-gated. The D1 is
// shared with other files: every curve built here is unique, and regateStale is only pointed at
// this file's rows (through the `list` injection) so it never touches other tests' curves.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { gateForWrite, THRESHOLDS } from 'open-auri/safety';
import { curveId, encodeS1 } from 'open-auri/share';
import { checkCurve, gateVersion, regateStale } from '#lib/server/social/gate.ts';
import { getCurve, listCurvesWithStaleGate, saveCurveGate } from '#lib/server/social/repo.ts';
import type { CurveRecord } from '#lib/server/social/types.ts';
import reference from '../../../../../test/fixtures/eq0xcb.reference.json';

type Curve = Parameters<typeof encodeS1>[0];
type Band = Curve['bands'][number];

const presets = Object.entries(reference.presets).map(([name, preset]) => ({
	name,
	curve: { bands: preset.eqBands as Band[], preampDb: preset.preampDb } satisfies Curve
}));

function randomInt(min: number, max: number): number {
	const [value] = crypto.getRandomValues(new Uint32Array(1));
	return min + (value % (max - min + 1));
}

/**
 * A unique curve the gate refuses: the first preset with its first two bands replaced by HS
 * shelves (HS is only allowed in the experimental layer, so `gateForWrite` reports
 * `k:kind-not-allowed` for both stages).
 */
function rejectedCurve(): Curve {
	const base = presets[0].curve;
	const shelf = (): Band => ({
		kind: 'HS',
		freqHz: randomInt(1000, 15999),
		gainDb: -randomInt(1, 60) / 10,
		qFactor: 0.71
	});
	return { bands: [shelf(), shelf(), ...base.bands.slice(2)], preampDb: base.preampDb };
}

function countingGate(): { gate: typeof gateForWrite; calls: () => number } {
	let calls = 0;
	const gate: typeof gateForWrite = (bands, preampDb, options) => {
		calls++;
		return gateForWrite(bands, preampDb, options);
	};
	return { gate, calls: () => calls };
}

async function storeStale(
	s1: string,
	overrides: Partial<Pick<CurveRecord, 'gateOk' | 'gateReasons' | 'canonKey'>> = {}
): Promise<string> {
	const id = await curveId(s1);
	const saved = await saveCurveGate(
		env.DB,
		{
			id,
			s1,
			canonKey: overrides.canonKey ?? `stale;${id}`,
			gateVer: 'v1:stale',
			gateOk: overrides.gateOk ?? true,
			gateReasons: overrides.gateReasons ?? [],
			levelDb: null
		},
		1
	);
	if (!saved.ok) throw new Error(`stale insert failed: ${saved.code}`);
	return id;
}

describe('gateVersion', () => {
	it('is v2 plus 16 hex chars of SHA-256 over the thresholds, memoized', async () => {
		const bytes = new TextEncoder().encode(JSON.stringify(THRESHOLDS));
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
		const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
		const version = await gateVersion();
		expect(version).toBe(`v2:${hex.slice(0, 16)}`);
		expect(version).toMatch(/^v2:[0-9a-f]{16}$/);
		expect(gateVersion()).toBe(gateVersion());
	});
});

describe('checkCurve: invalid S1', () => {
	it('returns invalid-curve with the S1 error code', async () => {
		expect(await checkCurve(env.DB, '!'.repeat(68))).toEqual({
			ok: false,
			code: 'invalid-curve',
			codes: ['s1:charset']
		});
		expect(await checkCurve(env.DB, encodeS1(presets[0].curve).slice(0, 60))).toEqual({
			ok: false,
			code: 'invalid-curve',
			codes: ['s1:length']
		});
	});

	it('refuses a corrupted S1 without running the gate', async () => {
		const corrupted = corrupt(encodeS1(presets[0].curve));
		const spy = countingGate();
		const result = await checkCurve(env.DB, corrupted, Date.now(), { gate: spy.gate });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe('invalid-curve');
		if (result.code !== 'invalid-curve') return;
		expect(result.codes).toHaveLength(1);
		expect(result.codes[0]).toMatch(/^s1:/);
		expect(spy.calls()).toBe(0);
	});
});

describe('checkCurve: official presets', () => {
	it('accepts the 11 presets of the reference fixture and caches them', async () => {
		expect(presets).toHaveLength(11);
		const version = await gateVersion();
		for (const { name, curve } of presets) {
			const s1 = encodeS1(curve);
			const result = await checkCurve(env.DB, s1);
			expect(result.ok, name).toBe(true);
			if (!result.ok) continue;
			expect(result.curve.id).toBe(await curveId(s1));
			expect(result.curve.s1).toBe(s1);
			expect(result.curve.gateVer).toBe(version);
			expect(result.curve.gateOk).toBe(true);
			expect(result.curve.gateReasons).toEqual([]);
			expect(Number.isFinite(result.curve.levelDb)).toBe(true);
			expect(result.preampDb).toBe(curve.preampDb);
			expect(result.bands).toHaveLength(curve.bands.length);
		}
	});

	it('serves a cached preset without running the gate', async () => {
		const s1 = encodeS1(presets[1].curve);
		await checkCurve(env.DB, s1);
		const spy = countingGate();
		const result = await checkCurve(env.DB, s1, Date.now(), { gate: spy.gate });
		expect(result.ok).toBe(true);
		expect(spy.calls()).toBe(0);
	});
});

describe('checkCurve: rejection and cache', () => {
	it('caches a rejected curve and never re-runs the gate for it', async () => {
		const s1 = encodeS1(rejectedCurve());
		const spy = countingGate();
		const first = await checkCurve(env.DB, s1, Date.now(), { gate: spy.gate });
		expect(spy.calls()).toBe(1);
		expect(first.ok).toBe(false);
		if (first.ok || first.code !== 'gate-rejected') throw new Error('expected gate-rejected');
		expect(first.reasons[0]).toBe('k:kind-not-allowed');
		expect(first.reasons.filter((r) => r === 'k:kind-not-allowed')).toHaveLength(1);
		expect(new Set(first.reasons).size).toBe(first.reasons.length);
		expect(first.curve.gateOk).toBe(false);
		expect(first.curve.gateVer).toBe(await gateVersion());

		const second = await checkCurve(env.DB, s1, Date.now(), { gate: spy.gate });
		expect(spy.calls()).toBe(1);
		expect(second).toEqual(first);

		const stored = await getCurve(env.DB, first.curve.id);
		expect(stored?.gateReasons).toEqual(first.reasons);
	});

	it('re-runs the gate once for a stale gate version and updates the row', async () => {
		const s1 = encodeS1(rejectedCurve());
		const id = await storeStale(s1, { gateOk: true, gateReasons: [] });
		const spy = countingGate();
		const result = await checkCurve(env.DB, s1, Date.now(), { gate: spy.gate });
		expect(spy.calls()).toBe(1);
		expect(result.ok).toBe(false);
		if (result.ok || result.code !== 'gate-rejected') throw new Error('expected gate-rejected');
		expect(result.reasons).toContain('k:kind-not-allowed');

		const stored = await getCurve(env.DB, id);
		expect(stored?.gateVer).toBe(await gateVersion());
		expect(stored?.gateOk).toBe(false);
		expect(stored?.gateReasons).toEqual(result.reasons);
		expect(stored?.canonKey).toBe(`stale;${id}`);

		await checkCurve(env.DB, s1, Date.now(), { gate: spy.gate });
		expect(spy.calls()).toBe(1);
	});
});

describe('regateStale', () => {
	it('re-gates only stale rows, caches undecodable S1 as rejected and counts changes', async () => {
		const flipped = encodeS1(rejectedCurve());
		const flippedId = await storeStale(flipped, { gateOk: true, gateReasons: [] });

		const steadyCurve = rejectedCurve();
		const steady = encodeS1(steadyCurve);
		const reasons = gateForWrite(steadyCurve.bands, steadyCurve.preampDb).reasons;
		const steadyReasons = [...new Set(reasons.map((r) => String(r.code)))];
		const steadyId = await storeStale(steady, { gateOk: false, gateReasons: steadyReasons });

		const brokenId = await storeBroken();

		const mine = new Set([flippedId, steadyId, brokenId]);
		const list: typeof listCurvesWithStaleGate = async (db, version) =>
			(await listCurvesWithStaleGate(db, version, 1000)).filter((c) => mine.has(c.id));
		const spy = countingGate();

		const result = await regateStale(env.DB, 50, Date.now(), { gate: spy.gate, list });
		expect(result).toEqual({ checked: 3, changed: 2 });
		expect(spy.calls()).toBe(2);

		const version = await gateVersion();
		const flippedRow = await getCurve(env.DB, flippedId);
		expect(flippedRow?.gateVer).toBe(version);
		expect(flippedRow?.gateOk).toBe(false);
		expect(flippedRow?.gateReasons).toContain('k:kind-not-allowed');
		expect(Number.isFinite(flippedRow?.levelDb)).toBe(true);

		const steadyRow = await getCurve(env.DB, steadyId);
		expect(steadyRow?.gateVer).toBe(version);
		expect(steadyRow?.gateReasons).toEqual(steadyReasons);

		const brokenRow = await getCurve(env.DB, brokenId);
		expect(brokenRow?.gateVer).toBe(version);
		expect(brokenRow?.gateOk).toBe(false);
		expect(brokenRow?.gateReasons).toHaveLength(1);
		expect(brokenRow?.gateReasons[0]).toMatch(/^s1:/);
		expect(brokenRow?.levelDb).toBeNull();

		expect(await regateStale(env.DB, 50, Date.now(), { gate: spy.gate, list })).toEqual({
			checked: 0,
			changed: 0
		});
		expect(spy.calls()).toBe(2);
	});
});

// ---- helpers of the regateStale test -------------------------------------------------------

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** One body character changed: still 68 base64url chars, but `decodeS1` refuses it. */
function corrupt(s1: string): string {
	const i = 30;
	return s1.slice(0, i) + (s1[i] === 'A' ? 'B' : 'A') + s1.slice(i + 1);
}

/**
 * A stale row whose stored S1 no longer decodes (as if the format had tightened), with a random
 * id of the curve-id shape (`curveId` itself would refuse the string).
 */
async function storeBroken(): Promise<string> {
	const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => BASE32[b % 32]).join('');
	const saved = await saveCurveGate(
		env.DB,
		{
			id,
			s1: corrupt(encodeS1(rejectedCurve())),
			canonKey: `broken;${id}`,
			gateVer: 'v1:stale',
			gateOk: true,
			gateReasons: [],
			levelDb: null
		},
		1
	);
	if (!saved.ok) throw new Error(`broken insert failed: ${saved.code}`);
	return id;
}
