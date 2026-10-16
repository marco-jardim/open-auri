// Server-side curve validation and gate cache (T4.1c), shared by publication (T4.2) and library
// merge (T4.3). A curve is validated as S1, identified by `curveId(s1)` and gated with the core's
// `gateForWrite` (~150 ms of CPU per curve in workerd). The verdict is cached in `curves` per curve
// id and gate version, so the gate never runs twice for the same curve and gate version.
import type { D1Database } from '@cloudflare/workers-types';
import { gateForWrite, levelDb, THRESHOLDS } from 'open-auri/safety';
import { canonKey, curveId, decodeS1, S1Error } from 'open-auri/share';
import { getCurve, listCurvesWithStaleGate, saveCurveGate } from '#lib/server/social/repo.ts';
import type { CurveInput, CurveRecord } from '#lib/server/social/types.ts';

type Decoded = ReturnType<typeof decodeS1>;
export type CurveBands = Decoded['bands'];

export type CurveCheck =
	| { ok: true; curve: CurveRecord; bands: CurveBands; preampDb: number }
	| { ok: false; code: 'invalid-curve'; codes: string[] }
	| { ok: false; code: 'gate-rejected'; reasons: string[]; curve: CurveRecord };

/** Injection points for tests (the defaults are the production ones). */
export interface GateDeps {
	gate: typeof gateForWrite;
}

export interface RegateDeps extends GateDeps {
	list: typeof listCurvesWithStaleGate;
}

let gateVersionMemo: Promise<string> | null = null;

async function computeGateVersion(): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(THRESHOLDS));
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `v2:${hex.slice(0, 16)}`;
}

/**
 * Current gate version: `'v2:'` + the first 16 hex characters of SHA-256 over
 * `JSON.stringify(THRESHOLDS)`. Computed once per isolate.
 */
export function gateVersion(): Promise<string> {
	if (!gateVersionMemo) {
		const pending = computeGateVersion();
		gateVersionMemo = pending;
		pending.catch(() => {
			// A failed digest must not stay memoized; the caller still sees the rejection.
			if (gateVersionMemo === pending) gateVersionMemo = null;
		});
	}
	return gateVersionMemo;
}

interface GateVerdict {
	gateOk: boolean;
	gateReasons: string[];
	levelDb: number | null;
}

/** Runs the gate once: reason codes de-duplicated in gate order, level when the codec accepted. */
function runGate(gate: typeof gateForWrite, bands: CurveBands, preampDb: number): GateVerdict {
	const result = gate(bands, preampDb);
	const gateReasons = [...new Set(result.reasons.map((reason) => String(reason.code)))];
	let level: number | null = null;
	if (result.metrics.payload) {
		const value = levelDb(bands, preampDb);
		level = Number.isFinite(value) ? value : null;
	}
	return { gateOk: result.ok && gateReasons.length === 0, gateReasons, levelDb: level };
}

async function persist(db: D1Database, curve: CurveInput, now: number): Promise<CurveRecord> {
	const saved = await saveCurveGate(db, curve, now);
	if (!saved.ok) throw new Error(`gate cache write failed: ${saved.code}`);
	return saved.value;
}

function verdictOf(curve: CurveRecord, bands: CurveBands, preampDb: number): CurveCheck {
	return curve.gateOk
		? { ok: true, curve, bands, preampDb }
		: { ok: false, code: 'gate-rejected', reasons: [...curve.gateReasons], curve };
}

function decode(s1: string): Decoded | { invalid: string } {
	try {
		return decodeS1(s1);
	} catch (error) {
		if (error instanceof S1Error) return { invalid: String(error.code) };
		throw error;
	}
}

/**
 * Validates `s1`, then returns the cached gate verdict for its curve id at the current gate
 * version, or runs the gate once and caches the verdict (accepted and rejected alike).
 */
export async function checkCurve(
	db: D1Database,
	s1: string,
	now = Date.now(),
	{ gate = gateForWrite }: Partial<GateDeps> = {}
): Promise<CurveCheck> {
	const decoded = decode(s1);
	if ('invalid' in decoded) return { ok: false, code: 'invalid-curve', codes: [decoded.invalid] };
	const { bands, preampDb } = decoded;
	const id = await curveId(s1);
	const key = canonKey(bands, preampDb);
	const version = await gateVersion();
	const cached = await getCurve(db, id);
	if (cached && cached.gateVer === version) return verdictOf(cached, bands, preampDb);
	const verdict = runGate(gate, bands, preampDb);
	const curve = await persist(db, { id, s1, canonKey: key, gateVer: version, ...verdict }, now);
	return verdictOf(curve, bands, preampDb);
}

function sameVerdict(before: CurveRecord, after: GateVerdict): boolean {
	return (
		before.gateOk === after.gateOk &&
		before.gateReasons.length === after.gateReasons.length &&
		before.gateReasons.every((reason, i) => reason === after.gateReasons[i])
	);
}

/**
 * Job step: re-gates up to `limit` curves cached under another gate version (oldest first).
 * A stored S1 that no longer decodes is cached as rejected with its S1 error code.
 * `changed` counts curves whose verdict (ok flag or reasons) differs from the stale one.
 */
export async function regateStale(
	db: D1Database,
	limit = 50,
	now = Date.now(),
	{ gate = gateForWrite, list = listCurvesWithStaleGate }: Partial<RegateDeps> = {}
): Promise<{ checked: number; changed: number }> {
	const version = await gateVersion();
	const stale = await list(db, version, limit);
	let changed = 0;
	for (const record of stale) {
		const decoded = decode(record.s1);
		const verdict: GateVerdict =
			'invalid' in decoded
				? { gateOk: false, gateReasons: [decoded.invalid], levelDb: null }
				: runGate(gate, decoded.bands, decoded.preampDb);
		await persist(
			db,
			{ id: record.id, s1: record.s1, canonKey: record.canonKey, gateVer: version, ...verdict },
			now
		);
		if (!sameVerdict(record, verdict)) changed++;
	}
	return { checked: stale.length, changed };
}
