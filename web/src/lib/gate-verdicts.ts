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
 * Verdicts are shared: callers read them and never change them.
 */
import { snapshotBands } from 'open-auri/dsp';
import { gateForWrite, isExperimentalKind } from 'open-auri/safety';

export type GateProfile = 'standard' | 'yolo';
export type GateVerdict = ReturnType<typeof gateForWrite>;
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
	profile: GateProfile
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

/** Forgets every cached verdict (tests). */
export function clearGateVerdicts(): void {
	verdicts.clear();
}
