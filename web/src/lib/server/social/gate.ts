// Server-side curve validation and gate cache (T4.1c), shared by publication (T4.2) and library
// merge (T4.3). A curve is validated as S1, identified by `curveId(s1)` and gated with the core's
// `gateForWrite` (~150 ms of CPU per curve in workerd). The verdict is cached in `curves` per curve
// id and gate version, so the gate never runs twice for the same curve and gate version.
//
// Gate version `v2.<GATE_IMPL>:<hash>`: GATE_IMPL is a hand-bumped ordinal of the gate
// implementation (gate code, codec, level computation, thresholds); the hash covers GATE_IMPL and
// THRESHOLDS, so a threshold change re-gates even if the bump is forgotten. The cache upsert is
// monotonic in GATE_IMPL (an older isolate never overwrites a verdict of a newer one), and a
// verdict cached by a newer GATE_IMPL is trusted as current (deploy skew).
import type { D1Database } from '@cloudflare/workers-types';
import { gateForWrite, levelDb, THRESHOLDS } from 'open-auri/safety';
import { canonKey, curveId, decodeS1, S1Error } from 'open-auri/share';
import { getCurve, saveCurveGate } from '#lib/server/social/repo.ts';
import { listStaleCurvesByPriority } from '#lib/server/social/queries/curves.ts';
import type { CurveInput, CurveRecord } from '#lib/server/social/types.ts';

/**
 * Ordinal of the gate implementation. Bump it (never reuse or lower) on ANY change that can alter
 * a verdict: the core's `gateForWrite`, `THRESHOLDS`, the S1 codec, `levelDb`, or `runGate` below.
 * See README.md, "Gate cache".
 */
export const GATE_IMPL = 1;

/** Default wall-clock budget of one `regateStale` run (ms). */
export const REGATE_BUDGET_MS = 20_000;

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
	/** Stale curves to re-gate, in priority order (default: linkable heads first, then oldest). */
	list: (db: D1Database, gateVer: string, limit: number) => Promise<CurveRecord[]>;
	/** Wall-clock budget (ms): no new curve is started once it is spent. */
	budgetMs: number;
	/** Clock of the budget (ms). */
	clock: () => number;
}

let gateVersionMemo: Promise<string> | null = null;

/** The hashed input of the gate version (exported for tests). */
export function gateVersionInput(): string {
	return `${GATE_IMPL}:${JSON.stringify(THRESHOLDS)}`;
}

async function computeGateVersion(): Promise<string> {
	const bytes = new TextEncoder().encode(gateVersionInput());
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `v2.${GATE_IMPL}:${hex.slice(0, 16)}`;
}

/**
 * GATE_IMPL ordinal of a stored gate version: N for `v2.N:<hash>`, 0 for anything else (the
 * legacy `v2:<hash>` and older formats). Same rule as `gateImplSql` in repo.ts.
 */
export function gateImplOf(gateVer: string): number {
	const match = /^v2\.(\d{1,9}):/.exec(gateVer);
	return match ? Number(match[1]) : 0;
}

/**
 * True when a verdict cached under `gateVer` may be served without re-gating: it is the current
 * version, or it comes from a newer gate implementation (deploy skew: the newer isolate wins).
 */
export async function isGateCurrent(gateVer: string): Promise<boolean> {
	return gateVer === (await gateVersion()) || gateImplOf(gateVer) > GATE_IMPL;
}

/**
 * Current gate version: `'v2.' + GATE_IMPL + ':'` + the first 16 hex characters of SHA-256 over
 * `GATE_IMPL + ':' + JSON.stringify(THRESHOLDS)`. Computed once per isolate. (The core package
 * version is not part of it: importing `open-auri/package.json` needs `resolveJsonModule`, which
 * the jobs Worker that also imports this module does not enable, and the core stays at 0.0.0;
 * GATE_IMPL is the explicit implementation marker instead.)
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
	if (cached && (await isGateCurrent(cached.gateVer))) return verdictOf(cached, bands, preampDb);
	const verdict = runGate(gate, bands, preampDb);
	const curve = await persist(db, { id, s1, canonKey: key, gateVer: version, ...verdict }, now);
	return verdictOf(curve, bands, preampDb);
}

/**
 * Re-gates a stored curve when its cached verdict is not current (see isGateCurrent) and returns
 * the stored row afterwards; a current row is returned as is, without running the gate. A stored
 * S1 that no longer decodes is cached as rejected with its S1 error code. Used by the by-id reads
 * and actions of the curves service (lazy re-gate) and by `regateStale`.
 */
export async function regateCurve(
	db: D1Database,
	record: CurveRecord,
	now = Date.now(),
	{ gate = gateForWrite }: Partial<GateDeps> = {}
): Promise<CurveRecord> {
	if (await isGateCurrent(record.gateVer)) return record;
	const version = await gateVersion();
	const decoded = decode(record.s1);
	const verdict: GateVerdict =
		'invalid' in decoded
			? { gateOk: false, gateReasons: [decoded.invalid], levelDb: null }
			: runGate(gate, decoded.bands, decoded.preampDb);
	return persist(
		db,
		{ id: record.id, s1: record.s1, canonKey: record.canonKey, gateVer: version, ...verdict },
		now
	);
}

function sameVerdict(before: CurveRecord, after: CurveRecord): boolean {
	return (
		before.gateOk === after.gateOk &&
		before.gateReasons.length === after.gateReasons.length &&
		before.gateReasons.every((reason, i) => reason === after.gateReasons[i])
	);
}

function listStaleForThisImpl(
	db: D1Database,
	gateVer: string,
	limit: number
): Promise<CurveRecord[]> {
	return listStaleCurvesByPriority(db, gateVer, limit, GATE_IMPL);
}

export interface RegateResult {
	/** Stale curves processed by this run. */
	checked: number;
	/** Curves whose verdict (ok flag or reasons) differs from the stale one. */
	changed: number;
	/**
	 * Present (true) only when the run stopped because the time budget was spent (stale curves
	 * may remain); absent on a complete run, so the result of a complete run keeps its old shape.
	 */
	timedOut?: true;
}

/**
 * Job step: re-gates up to `limit` curves cached under another gate version, heads of linkable
 * lineages first (they are what anyone with a link can open), then oldest first. Stops starting
 * new curves once `budgetMs` of wall time has passed (the clock advances at each D1 write in
 * workerd, so the CPU of the last gate run is counted at its write). Rows of a newer GATE_IMPL are
 * never picked (they are current for a newer isolate).
 */
export async function regateStale(
	db: D1Database,
	limit = 50,
	now = Date.now(),
	{
		gate = gateForWrite,
		list = listStaleForThisImpl,
		budgetMs = REGATE_BUDGET_MS,
		clock = Date.now
	}: Partial<RegateDeps> = {}
): Promise<RegateResult> {
	const started = clock();
	const version = await gateVersion();
	const stale = await list(db, version, limit);
	let checked = 0;
	let changed = 0;
	for (const record of stale) {
		if (clock() - started >= budgetMs) return { checked, changed, timedOut: true };
		const stored = await regateCurve(db, record, now, { gate });
		checked++;
		if (!sameVerdict(record, stored)) changed++;
	}
	return { checked, changed };
}
