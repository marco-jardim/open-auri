// Server-side curve validation, classification and gate cache (T4.1c), shared by publication
// (T4.2) and library merge (T4.3). A curve is validated as S1, identified by `curveId(s1)` and
// classified on the server, never trusting a client's claim:
//   - `standard`: the core's `gateForWrite` accepts it (~150 ms of CPU per curve in workerd);
//   - `yolo`: the standard gate refuses it on waivable reasons only and the YOLO profile accepts it;
//   - `rejected`: neither.
// The class is the core's classification (`classifyWith`, the step behind `classifyCurve`, through
// ./classify-core.mjs) on the injected write gate, run only when the standard write gate refuses
// the curve. Its first step is that same standard run: it is handed the verdict already computed,
// so a YOLO curve costs exactly two gate runs (standard + YOLO profile), both through the injected
// gate (the library merge counts them all against MERGE_GATE_RUNS_MAX).
// `experimental` (HS, LP, HP allowed) is derived from the curve itself, as the editor does
// (web/src/lib/components/pages/curva/model.ts `hasExperimental`): the server accepts HS/LP/HP as
// standard curves. The verdict is cached in `curves` per curve id and gate version (migration
// 0013: `gate_ok` = standard, `gate_yolo` = YOLO), so the gate never runs twice for the same curve
// and gate version.
//
// Gate version `v2.<GATE_IMPL>:<hash>`: GATE_IMPL is a hand-bumped ordinal of the gate
// implementation (gate code, classifier, codec, level computation, thresholds); the hash covers
// GATE_IMPL, THRESHOLDS and the classifier's input (`classifierVersionInput`: THRESHOLDS,
// YOLO_THRESHOLDS and the waivable codes), so a threshold change re-gates even if the bump is
// forgotten. The cache upsert is monotonic in GATE_IMPL (an older isolate never overwrites a
// verdict of a newer one), and a verdict cached by a newer GATE_IMPL is trusted as current
// (deploy skew).
import type { D1Database } from '@cloudflare/workers-types';
import {
	classifierVersionInput,
	gateForWrite,
	isExperimentalKind,
	isWaivable,
	levelDb,
	THRESHOLDS
} from 'open-auri/safety';
import { canonKey, curveId, decodeS1, S1Error } from 'open-auri/share';
import { classifyWith } from './classify-core.mjs';
import {
	getCurve,
	getHeadGateState,
	getVersionGateState,
	listStaleCurvesForRegate,
	saveCurveGate,
	type GateState
} from '#lib/server/social/repo.ts';
import type { CurveInput, CurveRecord } from '#lib/server/social/types.ts';

/**
 * Ordinal of the gate implementation. Bump it (never reuse or lower) on ANY change that can alter
 * a verdict: the core's `gateForWrite`, `classifyCurve`, `THRESHOLDS` or `YOLO_THRESHOLDS`, the S1
 * codec, `levelDb`, or `runGate` below. See README.md, "Gate cache".
 * 2 = server classification (standard / yolo / rejected) with `experimental` derived from the
 * curve (HS, LP and HP are standard on the server).
 */
export const GATE_IMPL = 2;

/** Default wall-clock budget of one `regateStale` run (ms). */
export const REGATE_BUDGET_MS = 20_000;

type Decoded = ReturnType<typeof decodeS1>;
export type CurveBands = Decoded['bands'];

/** The class of a curve (core `classifyCurve`). */
export type CurveClass = 'standard' | 'yolo' | 'rejected';

/** Legacy check: `ok` means STANDARD (a YOLO curve is `gate-rejected` here). */
export type CurveCheck =
	| { ok: true; curve: CurveRecord; bands: CurveBands; preampDb: number }
	| { ok: false; code: 'invalid-curve'; codes: string[] }
	| { ok: false; code: 'gate-rejected'; reasons: string[]; curve: CurveRecord };

/**
 * Publication check: `ok` means the curve may be stored (standard or YOLO). `gateRuns` = write-gate
 * runs this call spent, every one of them through the injected gate (0 cached, 1 the standard
 * profile only, 2 when the classification also ran the YOLO profile).
 */
export type PublishableCheck =
	| {
			ok: true;
			class: 'standard' | 'yolo';
			/** Codes the YOLO profile waived ([] for a standard curve). */
			waived: string[];
			curve: CurveRecord;
			bands: CurveBands;
			preampDb: number;
			gateRuns: number;
	  }
	| { ok: false; code: 'invalid-curve'; codes: string[]; gateRuns: number }
	| {
			ok: false;
			code: 'gate-rejected';
			/** Cached codes: the standard ones, plus the YOLO-only blocking ones. */
			reasons: string[];
			/** The codes that block in every profile (no YOLO waiver can lift them). */
			hard: string[];
			curve: CurveRecord;
			gateRuns: number;
	  };

/** Injection points (the defaults are the production ones). */
export interface GateDeps {
	/**
	 * Write gate of every run, standard and YOLO profile alike (default: the core's gateForWrite).
	 * The library merge passes a counting wrapper; tests pass spies and forced verdicts.
	 */
	gate: typeof gateForWrite;
}

export interface RegateDeps extends GateDeps {
	/**
	 * Stale curves to re-gate, in priority order (default: standard or YOLO linkable heads, then
	 * other heads of publicly listable lineages, then the rest; oldest first within each).
	 */
	list: (db: D1Database, gateVer: string, limit: number) => Promise<CurveRecord[]>;
	/** Wall-clock budget (ms): no new curve is started once it is spent. */
	budgetMs: number;
	/** Clock of the budget (ms). */
	clock: () => number;
}

let gateVersionMemo: Promise<string> | null = null;

/** The hashed input of the gate version (exported for tests). */
export function gateVersionInput(): string {
	return `${GATE_IMPL}:${JSON.stringify(THRESHOLDS)}:${classifierVersionInput()}`;
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
 * {@link gateVersionInput} (`GATE_IMPL + ':' + JSON.stringify(THRESHOLDS) + ':' +
 * classifierVersionInput()`). Computed once per isolate. (The core package version is not part of
 * it: importing `open-auri/package.json` needs `resolveJsonModule`, which the jobs Worker that also
 * imports this module does not enable, and the core stays at 0.0.0; GATE_IMPL is the explicit
 * implementation marker instead.)
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

/**
 * Whether the curve has an experimental kind (HS, LP, HP): the `experimental` flag of the gate and
 * of the classifier, derived from the curve exactly as the editor derives it.
 */
export function hasExperimental(bands: CurveBands): boolean {
	return bands.some((band) => isExperimentalKind(band.kind));
}

/**
 * The codes of cached reasons that block in every profile: everything the YOLO profile does not
 * waive, and `k:kind-not-allowed` (experimental kinds are decided by the flag, never waived). An S1
 * curve cannot carry a preamp below −25.5 dB, so `g:preamp` never blocks here.
 */
export function hardCodes(reasons: readonly string[]): string[] {
	return reasons.filter((code) => code === 'k:kind-not-allowed' || !isWaivable(code));
}

interface GateVerdict {
	gateOk: boolean;
	gateYolo: boolean;
	gateReasons: string[];
	levelDb: number | null;
	/** Write-gate runs of the classification (all through the injected gate): 1, or 2 with YOLO. */
	runs: number;
}

type GateResult = ReturnType<typeof gateForWrite>;

/**
 * Classifies a curve once. The standard write gate runs first (its reason codes, de-duplicated in
 * gate order, and the level when the codec accepted the curve); a curve it accepts is standard.
 * Otherwise the class is the core's classification (`classifyWith`) on the same gate, handed the
 * standard verdict already computed for its first step, so only its YOLO-profile run (if any)
 * reaches the gate again: exactly 2 runs for a YOLO curve, 1 for a curve rejected on a reason the
 * classification never waives. `yolo` caches the waived codes, `rejected` the standard codes plus
 * the codes only the YOLO profile reports. A gate that contradicts itself (tests only: a forced
 * `ok`) never makes a refused curve standard or YOLO: a standard refusal without any reason, a
 * `standard` classification of a refused curve and a `yolo` one whose YOLO run did not pass are
 * rejected with the codes reported.
 */
function runGate(gate: typeof gateForWrite, bands: CurveBands, preampDb: number): GateVerdict {
	const experimental = hasExperimental(bands);
	let runs = 0;
	const counted: typeof gateForWrite = (runBands, runPreampDb, options) => {
		runs++;
		return gate(runBands, runPreampDb, options);
	};
	const result = counted(bands, preampDb, { experimental });
	const standardCodes = [...new Set(result.reasons.map((reason) => String(reason.code)))];
	let level: number | null = null;
	if (result.metrics.payload) {
		const value = levelDb(bands, preampDb);
		level = Number.isFinite(value) ? value : null;
	}
	if (result.ok && standardCodes.length === 0) {
		return { gateOk: true, gateYolo: false, gateReasons: [], levelDb: level, runs };
	}
	const rejected = (codes: readonly string[]): GateVerdict => {
		const yoloOnly = codes.filter((code) => !standardCodes.includes(code));
		return {
			gateOk: false,
			gateYolo: false,
			gateReasons: [...standardCodes, ...new Set(yoloOnly)],
			levelDb: level,
			runs
		};
	};
	// Nothing for a YOLO profile to waive: no YOLO run.
	if (standardCodes.length === 0) return rejected([]);
	const seen: { standard: boolean; yolo: GateResult | null } = { standard: false, yolo: null };
	// classifyWith's first call is the standard run above: answer it with that verdict. Any later
	// call is its YOLO-profile run, through the counted gate (a result without the YOLO fields,
	// from an injected gate, is read as waiving nothing).
	const write: typeof gateForWrite = (runBands, runPreampDb, options) => {
		if (!seen.standard) {
			seen.standard = true;
			return result;
		}
		const ran = counted(runBands, runPreampDb, options);
		seen.yolo = ran;
		return { ...ran, waived: ran.waived ?? [], waivedReasons: ran.waivedReasons ?? [] };
	};
	const classification = classifyWith(write, bands, preampDb, experimental);
	if (classification.class === 'yolo' && seen.yolo?.ok === true) {
		const waived = [...new Set(classification.waived.map(String))];
		return { gateOk: false, gateYolo: true, gateReasons: waived, levelDb: level, runs };
	}
	return rejected(classification.class === 'rejected' ? classification.reasons.map(String) : []);
}

function resolveGate(deps: Partial<GateDeps>): typeof gateForWrite {
	return deps.gate ?? gateForWrite;
}

async function persist(db: D1Database, curve: CurveInput, now: number): Promise<CurveRecord> {
	const saved = await saveCurveGate(db, curve, now);
	if (!saved.ok) throw new Error(`gate cache write failed: ${saved.code}`);
	return saved.value;
}

function decode(s1: string): Decoded | { invalid: string } {
	try {
		return decodeS1(s1);
	} catch (error) {
		if (error instanceof S1Error) return { invalid: String(error.code) };
		throw error;
	}
}

type Classified =
	| { invalid: string }
	| { curve: CurveRecord; bands: CurveBands; preampDb: number; gateRuns: number };

/**
 * Validates `s1`, then returns the cached verdict for its curve id at the current gate version,
 * or classifies the curve once and caches the verdict (every class alike).
 */
async function classifyStored(
	db: D1Database,
	s1: string,
	now: number,
	deps: Partial<GateDeps>
): Promise<Classified> {
	const decoded = decode(s1);
	if ('invalid' in decoded) return decoded;
	const { bands, preampDb } = decoded;
	const id = await curveId(s1);
	const cached = await getCurve(db, id);
	if (cached && (await isGateCurrent(cached.gateVer))) {
		return { curve: cached, bands, preampDb, gateRuns: 0 };
	}
	const version = await gateVersion();
	const { runs, ...verdict } = runGate(resolveGate(deps), bands, preampDb);
	const key = canonKey(bands, preampDb);
	const curve = await persist(db, { id, s1, canonKey: key, gateVer: version, ...verdict }, now);
	return { curve, bands, preampDb, gateRuns: runs };
}

/**
 * Legacy check (ok = STANDARD): validates `s1`, then returns the cached verdict for its curve id at
 * the current gate version, or classifies the curve once and caches the verdict. A YOLO curve is
 * `gate-rejected` here with its waived codes. The publication paths use {@link checkPublishable}.
 */
export async function checkCurve(
	db: D1Database,
	s1: string,
	now = Date.now(),
	deps: Partial<GateDeps> = {}
): Promise<CurveCheck> {
	const classified = await classifyStored(db, s1, now, deps);
	if ('invalid' in classified) {
		return { ok: false, code: 'invalid-curve', codes: [classified.invalid] };
	}
	const { curve, bands, preampDb } = classified;
	return curve.gateOk
		? { ok: true, curve, bands, preampDb }
		: { ok: false, code: 'gate-rejected', reasons: [...curve.gateReasons], curve };
}

/**
 * The class of `s1` as the server derives it (cached like {@link checkCurve}): `ok` with
 * `class: 'standard' | 'yolo'` when the curve may be stored, `gate-rejected` (with the blocking
 * `hard` codes) when it passes neither profile, `invalid-curve` when S1 does not decode. Whether a
 * YOLO curve may be shown to others is the caller's decision (acknowledgement, kill switch).
 */
export async function checkPublishable(
	db: D1Database,
	s1: string,
	now = Date.now(),
	deps: Partial<GateDeps> = {}
): Promise<PublishableCheck> {
	const classified = await classifyStored(db, s1, now, deps);
	if ('invalid' in classified) {
		return { ok: false, code: 'invalid-curve', codes: [classified.invalid], gateRuns: 0 };
	}
	const { curve, bands, preampDb, gateRuns } = classified;
	if (curve.gateOk) {
		return { ok: true, class: 'standard', waived: [], curve, bands, preampDb, gateRuns };
	}
	if (curve.gateYolo) {
		const waived = [...curve.gateReasons];
		return { ok: true, class: 'yolo', waived, curve, bands, preampDb, gateRuns };
	}
	const reasons = [...curve.gateReasons];
	return { ok: false, code: 'gate-rejected', reasons, hard: hardCodes(reasons), curve, gateRuns };
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
	deps: Partial<GateDeps> = {}
): Promise<CurveRecord> {
	if (await isGateCurrent(record.gateVer)) return record;
	const version = await gateVersion();
	const decoded = decode(record.s1);
	let verdict: Omit<GateVerdict, 'runs'>;
	if ('invalid' in decoded) {
		verdict = { gateOk: false, gateYolo: false, gateReasons: [decoded.invalid], levelDb: null };
	} else {
		const ran = runGate(resolveGate(deps), decoded.bands, decoded.preampDb);
		verdict = {
			gateOk: ran.gateOk,
			gateYolo: ran.gateYolo,
			gateReasons: ran.gateReasons,
			levelDb: ran.levelDb
		};
	}
	return persist(
		db,
		{ id: record.id, s1: record.s1, canonKey: record.canonKey, gateVer: version, ...verdict },
		now
	);
}

/**
 * One curve of a by-id read hidden by its cached verdict (#27): re-gates it (one classification,
 * through regateCurve) when that verdict is not standard under a stale gate version (a rejected
 * curve, or a YOLO one, may now be standard). True when the gate ran (the caller reads again
 * through the visibility predicates), false when nothing ran. The record loaded for the re-gate is
 * never returned.
 */
async function regateStaleRejection(
	db: D1Database,
	state: GateState,
	now: number,
	deps: Partial<GateDeps>
): Promise<boolean> {
	if (state.gateOk || (await isGateCurrent(state.gateVer))) return false;
	const record = await getCurve(db, state.curveId);
	if (!record) return false;
	await regateCurve(db, record, now, deps);
	return true;
}

/**
 * By-id reads of a lineage (#27): the readable rows hide a head cached as rejected, so a stale
 * rejection is never re-gated there and the curve would stay 404 after the gate is relaxed. When
 * the lineage is linkable apart from that verdict (getHeadGateState) and its head is cached as not
 * standard under a stale gate version, re-gates the head (at most one classification) and returns
 * true so the caller reads the lineage again; false otherwise (nothing ran). Private, retracted,
 * moderated and banned-owner lineages are never re-gated here.
 */
export async function regateRejectedHead(
	db: D1Database,
	lineageId: string,
	now = Date.now(),
	deps: Partial<GateDeps> = {}
): Promise<boolean> {
	const state = await getHeadGateState(db, lineageId);
	return state ? regateStaleRejection(db, state, now, deps) : false;
}

/**
 * Same as regateRejectedHead for a version id: its own curve and, with `head`, its lineage's head
 * when cached as not standard under a stale gate version (at most one classification per curve).
 * True when the gate ran.
 */
export async function regateRejectedVersion(
	db: D1Database,
	versionId: string,
	now = Date.now(),
	deps: Partial<GateDeps> = {},
	{ head = true }: { head?: boolean } = {}
): Promise<boolean> {
	const state = await getVersionGateState(db, versionId);
	if (!state) return false;
	const own = await regateStaleRejection(db, state.curve, now, deps);
	const top =
		head && state.head.curveId !== state.curve.curveId
			? await regateStaleRejection(db, state.head, now, deps)
			: false;
	return own || top;
}

function sameVerdict(before: CurveRecord, after: CurveRecord): boolean {
	return (
		before.gateOk === after.gateOk &&
		before.gateYolo === after.gateYolo &&
		before.gateReasons.length === after.gateReasons.length &&
		before.gateReasons.every((reason, i) => reason === after.gateReasons[i])
	);
}

function listStaleForThisImpl(
	db: D1Database,
	gateVer: string,
	limit: number
): Promise<CurveRecord[]> {
	return listStaleCurvesForRegate(db, gateVer, limit, GATE_IMPL);
}

export interface RegateResult {
	/** Stale curves processed by this run. */
	checked: number;
	/** Curves whose verdict (class or reasons) differs from the stale one. */
	changed: number;
	/**
	 * Present (true) only when the run stopped because the time budget was spent (stale curves
	 * may remain); absent on a complete run, so the result of a complete run keeps its old shape.
	 */
	timedOut?: true;
}

/**
 * Job step: re-gates up to `limit` curves cached under another gate version, standard or YOLO
 * heads of linkable lineages first (they are what anyone with a link can open), then the other
 * heads of publicly listable lineages (a relaxed gate brings them back to the lists, #27), then the
 * rest, oldest first within each (listStaleCurvesForRegate in repo.ts). Stops starting
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
