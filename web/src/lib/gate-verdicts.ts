/**
 * One cache of full-grid write-gate verdicts (`gateForWrite`) for the whole client. The curve
 * store (adopting another tab's curve, an undo or redo step, `oa.current` on load), the audio
 * engine (the preview protection, C1: `standardGateAccepts`) and the Curva preview ask the same
 * question about the same curves; through this module each curve is judged once per profile.
 *
 * - Key: the canonical snapshot of the bands (`snapshotBands`: one read per field, OFF without
 *   extra fields, LP/HP without a zero gain), so a raw band list and its snapshot hit the same
 *   entry; plus the preamp, the experimental flag and the profile. The gate itself judges that
 *   same snapshot, so a cached verdict is the one the raw list would get.
 * - Only plain data is cached: a kind that is not a string, or a value that is neither a number
 *   nor absent, is judged directly every time (the gate refuses it anyway). Numbers are keyed by
 *   their exact text (`-0`, `NaN` and the infinities stay apart), strings by JSON, so two
 *   different curves never share an entry.
 * - LRU of `GATE_VERDICTS_KEPT` entries.
 *
 * The class of a curve (`curveClassification`: standard, YOLO or rejected, the core's
 * `classifyCurve` rules) runs its gate passes through this same verdict cache, so the standard
 * pass the editor or the preview already made, and the YOLO pass, cost nothing a second time. The
 * classes themselves are cached in their own LRU (`CLASSIFICATIONS_KEPT`), each with the gate runs
 * it took (`classifiedCurve`, `GateRuns`: what the server counts), with `experimental` always
 * derived from the curve (it has an HS, LP or HP section), as the server and `verdictFor` do.
 *
 * Verdicts are shared: callers read them and never change them.
 */
import { snapshotBands } from 'open-auri/dsp';
import {
	classifyCurve,
	gateForWrite,
	isExperimentalKind,
	YOLO_STORAGE_PREAMP_FLOOR_DB,
	YOLO_WAIVABLE
} from 'open-auri/safety';

export type GateProfile = 'standard' | 'yolo';
export type GateVerdict = ReturnType<typeof gateForWrite>;
export type CurveClassification = ReturnType<typeof classifyCurve>;
type Bands = Parameters<typeof gateForWrite>[0];

export interface GateVerdictOptions {
	/** `'yolo'`: the core's YOLO profile (class 2 waived). Standard by default. */
	profile?: GateProfile;
	/** Experimental kinds (HS, LP, HP) allowed. By default: whether the bands use one. */
	experimental?: boolean;
}

/** Entries kept (least recently used out first). */
export const GATE_VERDICTS_KEPT = 64;
const verdicts = new Map<string, GateVerdict>();

/** Exact text of a number field, null when absent; undefined when it cannot be keyed. */
function numberKey(value: unknown): string | null | undefined {
	if (value === undefined) return null;
	if (typeof value !== 'number') return undefined;
	return Object.is(value, -0) ? '-0' : String(value);
}

/** Cache key of a canonical snapshot, or null when it holds anything but plain data. */
function keyOf(
	snapshot: ReturnType<typeof snapshotBands>,
	preampDb: unknown,
	experimental: boolean,
	profile: GateProfile | 'class'
): string | null {
	const preamp = numberKey(preampDb);
	if (typeof preamp !== 'string') return null;
	const bands: (string | null)[][] = [];
	for (const band of snapshot) {
		const kind: unknown = Reflect.get(band, 'kind');
		if (typeof kind !== 'string') return null;
		const fields = [
			numberKey(Reflect.get(band, 'freqHz')),
			numberKey(Reflect.get(band, 'gainDb')),
			numberKey(Reflect.get(band, 'qFactor'))
		];
		const plain: (string | null)[] = [];
		for (const field of fields) {
			if (field === undefined) return null;
			plain.push(field);
		}
		bands.push([kind, ...plain]);
	}
	return JSON.stringify([profile, experimental, preamp, bands]);
}

function judge(
	bands: Bands,
	preampDb: number,
	experimental: boolean,
	profile: GateProfile
): GateVerdict {
	return gateForWrite(
		bands,
		preampDb,
		profile === 'yolo' ? { experimental, profile: 'yolo' } : { experimental }
	);
}

/**
 * The full-grid write-gate verdict of this curve in `profile`, as `gateForWrite` gives it, from
 * the shared cache. Shared: never change it.
 */
export function gateVerdict(
	bands: Bands,
	preampDb: number,
	options: GateVerdictOptions = {}
): GateVerdict {
	const profile = options.profile ?? 'standard';
	let snapshot: ReturnType<typeof snapshotBands>;
	try {
		snapshot = snapshotBands(bands);
	} catch {
		// Not a band list (or a getter threw): the gate refuses it with its own reason.
		return judge(bands, preampDb, options.experimental ?? false, profile);
	}
	const experimental =
		options.experimental ?? snapshot.some((band) => isExperimentalKind(band.kind));
	const key = keyOf(snapshot, preampDb, experimental, profile);
	if (key === null) return judge(snapshot, preampDb, experimental, profile);
	const known = verdicts.get(key);
	if (known !== undefined) {
		// Most recently used: to the end of the eviction order.
		verdicts.delete(key);
		verdicts.set(key, known);
		return known;
	}
	const verdict = judge(snapshot, preampDb, experimental, profile);
	while (verdicts.size >= GATE_VERDICTS_KEPT) {
		const oldest = verdicts.keys().next();
		if (oldest.done) break;
		verdicts.delete(oldest.value);
	}
	verdicts.set(key, verdict);
	return verdict;
}

/** Whether the full-grid write gate accepts this curve in `profile` (shared cache). */
export function gateAccepts(
	bands: Bands,
	preampDb: number,
	options: GateVerdictOptions = {}
): boolean {
	return gateVerdict(bands, preampDb, options).ok;
}

/**
 * Write-gate runs a classification takes, as the server counts them (gate.ts `runGate`): 1 when
 * only the standard profile ran (a standard curve, or one rejected on a code the classification
 * never waives), 2 when it also ran the YOLO profile (a YOLO curve, or a curve that YOLO
 * rejected after every standard code was waivable).
 */
export type GateRuns = 1 | 2;

/** A class with the write-gate runs it took (`GateRuns`). Shared: never change it. */
export interface ClassifiedCurve {
	readonly classification: CurveClassification;
	readonly gateRuns: GateRuns;
}

/**
 * Classes kept (least recently used out first) for the page's synchronous exits. Bulk work over a
 * larger library (shelf badges) keeps its own answers (workers/classifier-store.ts), so an
 * eviction here never sends a curve back to the worker.
 */
export const CLASSIFICATIONS_KEPT = 256;
const classes = new Map<string, ClassifiedCurve>();

type Reason = GateVerdict['reasons'][number];
type ReasonCode = CurveClassification['reasons'][number];

/**
 * Codes the classification waives for a `yolo` curve (core `CLASSIFICATION_WAIVABLE`): the YOLO
 * profile's class 2 except `k:kind-not-allowed`; experimental kinds are decided by the flag.
 */
const CLASS_WAIVABLE: ReadonlySet<string> = new Set(
	YOLO_WAIVABLE.filter((code) => code !== 'k:kind-not-allowed')
);

/** Whether `reason` keeps the curve out of every class (core classify-core.mjs `blocks`). */
function blocksClass(reason: Reason): boolean {
	if (!CLASS_WAIVABLE.has(reason.code)) return true;
	if (reason.code !== 'g:preamp') return false;
	const value = reason.value;
	return !(typeof value === 'number' && value >= YOLO_STORAGE_PREAMP_FLOOR_DB);
}

/** The blocking codes of `reasons`, once each, in order of first appearance. */
function blockingCodes(reasons: readonly Reason[]): ReasonCode[] {
	return [...new Set(reasons.filter(blocksClass).map((reason) => reason.code))];
}

/**
 * The core's classification steps (`classifyCurve`, classify-core.mjs `classifyWith`, which the
 * package does not export) with every gate pass read from the verdict cache (`gateVerdict`):
 * 1. the standard profile; a pass is `standard`;
 * 2. a standard failure on a code the classification never waives is `rejected`, with no YOLO
 *    pass (it would fail too);
 * 3. otherwise the YOLO profile on the standard pass's frozen bands: a pass is `yolo` with the
 *    codes it waived, a failure `rejected` with its blocking codes.
 * Same codes, same order, same result as the core (a unit test holds them equal). `gateRuns` is 2
 * exactly when step 3 ran.
 */
function classifyCached(snapshot: Bands, preampDb: number, experimental: boolean): ClassifiedCurve {
	const standard = gateVerdict(snapshot, preampDb, { experimental });
	if (standard.ok) {
		return { classification: { class: 'standard', waived: [], reasons: [] }, gateRuns: 1 };
	}
	const hard = blockingCodes(standard.reasons);
	if (hard.length > 0) {
		return { classification: { class: 'rejected', waived: [], reasons: hard }, gateRuns: 1 };
	}
	const frozen = standard.metrics.bands ?? snapshot;
	const yolo = gateVerdict(frozen, preampDb, { experimental, profile: 'yolo' });
	const blocking = blockingCodes([...yolo.reasons, ...(yolo.waivedReasons ?? [])]);
	if (blocking.length > 0) {
		return { classification: { class: 'rejected', waived: [], reasons: blocking }, gateRuns: 2 };
	}
	return {
		classification: { class: 'yolo', waived: [...(yolo.waived ?? [])], reasons: [] },
		gateRuns: 2
	};
}

/**
 * The upper bound of the runs behind a class whose runs are not known: 1 for a standard curve, 2
 * otherwise (a rejected curve may have needed the YOLO profile).
 */
function runsBound(classification: CurveClassification): GateRuns {
	return classification.class === 'standard' ? 1 : 2;
}

/**
 * `curveClassification` with the write-gate runs the class took (`GateRuns`), from the same
 * cache. Shared: never change it.
 */
export function classifiedCurve(bands: Bands, preampDb: number): ClassifiedCurve {
	let snapshot: ReturnType<typeof snapshotBands>;
	try {
		snapshot = snapshotBands(bands);
	} catch {
		// Not a band list: the classifier refuses it with its own codes (the standard run only).
		return {
			classification: classifyCurve(bands, preampDb, { experimental: false }),
			gateRuns: 1
		};
	}
	const experimental = snapshot.some((band) => isExperimentalKind(band.kind));
	const key = keyOf(snapshot, preampDb, experimental, 'class');
	// Not plain data: judged directly every time, through the same steps (never cached).
	if (key === null) return classifyCached(snapshot, preampDb, experimental);
	const known = classes.get(key);
	if (known !== undefined) {
		classes.delete(key);
		classes.set(key, known);
		return known;
	}
	const classified = classifyCached(snapshot, preampDb, experimental);
	remember(key, classified);
	return classified;
}

/**
 * The class of this curve (core `classifyCurve` rules: `standard`, `yolo` with the waived codes,
 * or `rejected` with the blocking codes, a preamp below −25.5 dB included), from its own cache;
 * a curve not in it costs only the gate passes the verdict cache does not hold yet. `experimental`
 * is whether the curve has an HS, LP or HP section. Synchronous, so a write or save exit always
 * knows the class at the moment of the action. Shared: never change it.
 */
export function curveClassification(bands: Bands, preampDb: number): CurveClassification {
	return classifiedCurve(bands, preampDb).classification;
}

/** The class key of a plain-data curve, or null (not a band list, or not plain data). */
function classKey(bands: Bands, preampDb: number): string | null {
	let snapshot: ReturnType<typeof snapshotBands>;
	try {
		snapshot = snapshotBands(bands);
	} catch {
		// Not a band list: never cached (`curveClassification` judges it directly).
		return null;
	}
	const experimental = snapshot.some((band) => isExperimentalKind(band.kind));
	return keyOf(snapshot, preampDb, experimental, 'class');
}

/** The cached class and runs of this curve, or null when not classified here yet (no gate). */
export function knownClassified(bands: Bands, preampDb: number): ClassifiedCurve | null {
	const key = classKey(bands, preampDb);
	return key === null ? null : (classes.get(key) ?? null);
}

/** The cached class of this curve, or null when it has not been classified here yet (no gate). */
export function knownClassification(bands: Bands, preampDb: number): CurveClassification | null {
	return knownClassified(bands, preampDb)?.classification ?? null;
}

/** Stores `classified` under `key`, dropping the least recently used classes first. */
function remember(key: string, classified: ClassifiedCurve): void {
	classes.delete(key);
	while (classes.size >= CLASSIFICATIONS_KEPT) {
		const oldest = classes.keys().next();
		if (oldest.done) break;
		classes.delete(oldest.value);
	}
	classes.set(key, classified);
}

/**
 * Keeps a class computed off the main thread (the gate worker's `classify`, the same rules on
 * the same core) for this curve, so the page's synchronous exits find it. `gateRuns`: the runs
 * the worker reported; without it, the upper bound (`runsBound`). Ignored for a curve that cannot
 * be keyed (`curveClassification` judges those directly every time).
 */
export function rememberClassification(
	bands: Bands,
	preampDb: number,
	classification: CurveClassification,
	gateRuns: GateRuns = runsBound(classification)
): void {
	const key = classKey(bands, preampDb);
	if (key !== null) remember(key, { classification, gateRuns });
}

/** Forgets every cached verdict and class (tests). */
export function clearGateVerdicts(): void {
	verdicts.clear();
	classes.clear();
}
