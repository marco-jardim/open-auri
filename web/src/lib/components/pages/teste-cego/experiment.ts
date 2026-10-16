import { OFFICIAL_PRESETS } from 'open-auri/catalog';
import { levelDb, snapshotBands } from 'open-auri/dsp';
import { autoPreamp, gate, isExperimentalKind } from 'open-auri/safety';
import type { PreviewCurve } from '#lib/audio/engine.ts';

export type RandomWord = () => number;
export type OutputConfirmation = 'neutral' | 'other';
export interface Candidate extends PreviewCurve {
	id: string;
	name: string;
	description?: string;
	official: boolean;
	experimental: boolean;
	accepted: boolean;
	reasons: string[];
	level: number;
}

/** No Math.random fallback: a blind order requires a cryptographic source. */
export const cryptoWord: RandomWord = () => crypto.getRandomValues(new Uint32Array(1))[0]!;

/** Rejection sampling avoids the modulo bias when 2^32 is not divisible by size. */
export function randomIndex(size: number, word: RandomWord = cryptoWord): number {
	if (!Number.isInteger(size) || size < 1 || size > 2 ** 32) throw new RangeError('size');
	const limit = Math.floor(2 ** 32 / size) * size;
	for (;;) {
		const value = word();
		if (!Number.isInteger(value) || value < 0 || value >= 2 ** 32) throw new RangeError('word');
		if (value < limit) return value % size;
	}
}

export function shuffle<T>(values: readonly T[], word: RandomWord = cryptoWord): T[] {
	const result = [...values];
	for (let i = result.length - 1; i > 0; i--) {
		const j = randomIndex(i + 1, word);
		[result[i], result[j]] = [result[j]!, result[i]!];
	}
	return result;
}

// Two-sided 95% quantiles t(0.975, df), df 1..30. No normal approximation for small n.
// Source: NIST/SEMATECH e-Handbook §1.3.6.7.2, Student's t distribution table,
// https://www.itl.nist.gov/div898/handbook/eda/section3/eda3672.htm
// Values retained to at least 9 significant digits; sessions allow at most 12 rounds.
export const T_975 = [
	12.706204736, 4.30265273, 3.182446305, 2.776445105, 2.570581836, 2.446911851, 2.364624252,
	2.306004135, 2.262157163, 2.228138852, 2.20098516, 2.17881283, 2.160368656, 2.144786688,
	2.131449546, 2.119905299, 2.109815578, 2.10092204, 2.093024054, 2.085963447, 2.079613845,
	2.073873068, 2.06865761, 2.063898562, 2.059538553, 2.055529439, 2.051830516, 2.048407142,
	2.045229642, 2.042272456
] as const;

export interface Summary {
	n: number;
	mean: number | null;
	/** Unclipped interval: truncating at 0 or 10 would misrepresent the uncertainty. */
	ci: readonly [number, number] | null;
}

export function confidence95(values: readonly number[]): Summary {
	if (Array.from(values).some((v) => !Number.isFinite(v) || v < 0 || v > 10)) {
		throw new RangeError('rating');
	}
	const n = values.length;
	if (n === 0) return { n, mean: null, ci: null };
	const mean = values.reduce((sum, v) => sum + v, 0) / n;
	if (n === 1) return { n, mean, ci: null };
	const t = T_975[n - 2];
	if (t === undefined) throw new RangeError('unsupported degrees of freedom');
	const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
	const margin = t * Math.sqrt(variance / n);
	return { n, mean, ci: [mean - margin, mean + margin] };
}

export interface Round {
	order: string[];
	ratings: number[];
}
export interface Session {
	candidates: Candidate[];
	planned: number;
	order: string[];
	completed: Round[];
}

export function candidate(
	id: string,
	name: string,
	curve: PreviewCurve,
	official = false,
	description?: string
): Candidate {
	const bands = snapshotBands(curve.bands);
	const experimental = bands.some((band) => isExperimentalKind(band.kind));
	const result = gate(bands, curve.preampDb, { experimental });
	return {
		id,
		name,
		bands,
		preampDb: curve.preampDb,
		official,
		description,
		experimental,
		accepted: result.ok,
		reasons: result.reasons.map((reason) => reason.code),
		level: result.ok ? levelDb(bands, curve.preampDb) : 0
	};
}

export function officialCandidates(): Candidate[] {
	return OFFICIAL_PRESETS.map((preset) =>
		candidate(`preset:${preset.id}`, preset.label, preset, true, preset.description)
	);
}

/** Fixed, disclosed regional patterns. Only the preamp is attenuated to pass the core gate. */
export function variations(base: Candidate, spread: number, generation: number): Candidate[] {
	if (!Number.isFinite(spread) || spread < 0.5 || spread > 4) throw new RangeError('spread');
	const patterns = [
		[1, -0.5, -1],
		[-1, 1, -0.5],
		[-0.5, -1, 1]
	] as const;
	return patterns.map((pattern, index) => {
		const bands: Array<PreviewCurve['bands'][number]> = base.bands.map((band) => {
			if (band.kind !== 'PK' && band.kind !== 'LS' && band.kind !== 'HS') return { ...band };
			const region =
				band.freqHz < 250 ? 0 : band.freqHz > 5000 ? 2 : band.freqHz >= 1000 ? 1 : null;
			return { ...band, gainDb: band.gainDb + (region === null ? 0 : pattern[region] * spread) };
		});
		// Flat/OFF curves can still have meaningful neighbours. Fill unused slots only; never
		// discard or reorder an existing section to make room for a variation.
		const centers = [150, 2500, 8000] as const;
		centers.forEach((frequency, region) => {
			const present = base.bands.some((band) => {
				if (band.kind !== 'PK' && band.kind !== 'LS' && band.kind !== 'HS') return false;
				return region === 0
					? band.freqHz < 250
					: region === 1
						? band.freqHz >= 1000 && band.freqHz <= 5000
						: band.freqHz > 5000;
			});
			const slot = bands.findIndex((band) => band.kind === 'OFF');
			if (!present && slot !== -1) {
				bands[slot] = {
					kind: region === 0 ? 'LS' : 'PK',
					freqHz: frequency,
					gainDb: pattern[region]! * spread,
					qFactor: region === 0 ? 0.7 : 1
				};
			}
		});
		const allowed = autoPreamp(bands, { experimental: base.experimental });
		const preampDb = allowed === null ? base.preampDb : Math.min(base.preampDb, allowed);
		return candidate(`variation:${generation}:${index}`, `${base.name} · ${index + 1}`, {
			bands,
			preampDb
		});
	});
}

export function startSession(
	candidates: readonly Candidate[],
	planned: number,
	output: OutputConfirmation | null,
	word: RandomWord = cryptoWord
): Session {
	if (output !== 'neutral' && output !== 'other') throw new Error('confirmation-required');
	if (!Number.isInteger(planned) || planned < 2 || planned > 12) throw new RangeError('rounds');
	if (
		candidates.length < 2 ||
		candidates.length > 3 ||
		new Set(candidates.map((c) => c.id)).size !== candidates.length ||
		candidates.some((c) => !c.accepted)
	)
		throw new Error('candidates-required');
	return {
		candidates: [...candidates],
		planned,
		order: shuffle(
			candidates.map((c) => c.id),
			word
		),
		completed: []
	};
}

export function recordRound(
	session: Session,
	ratings: readonly (number | null)[],
	word: RandomWord = cryptoWord
): Session {
	if (session.completed.length >= session.planned) throw new Error('finished');
	if (ratings.length !== session.order.length) throw new Error('ratings-required');
	const scores = Array.from(ratings, (value) => {
		if (value === null || !Number.isFinite(value) || value < 0 || value > 10) {
			throw new Error('ratings-required');
		}
		return value;
	});
	const round: Round = { order: [...session.order], ratings: scores };
	return {
		...session,
		completed: [...session.completed, round],
		order: shuffle(
			session.candidates.map((c) => c.id),
			word
		)
	};
}

export interface CandidateResult extends Summary {
	candidate: Candidate;
}
export interface BracketStage {
	results: CandidateResult[];
	winner: Candidate;
	spread: number;
	/** Overlapping individual intervals are a conservative stop rule, not a significance test. */
	tied: boolean;
}

export function bracketStage(session: Session, spread: number): BracketStage {
	if (session.completed.length === 0) throw new Error('no-results');
	const results = session.candidates
		.map((c) => ({
			candidate: c,
			...confidence95(session.completed.map((r) => r.ratings[r.order.indexOf(c.id)]!))
		}))
		.sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0) || a.candidate.id.localeCompare(b.candidate.id));
	const first = results[0]!;
	const tied = results
		.slice(1)
		.some((other) => !first.ci || !other.ci || first.ci[0] <= other.ci[1]);
	return { results, winner: first.candidate, spread, tied };
}

export function nextSpread(stage: BracketStage): number | null {
	const half = stage.spread / 2;
	return stage.tied || half < 0.5 ? null : half;
}

/** A lower-bound plan, not a prediction of free switching: one write per audition plus restore. */
export function estimatedWrites(rounds: number, candidates: number): number {
	return rounds * candidates + 1;
}

/** Explicit allowlist: no audio, filenames, free text, account or device identifiers. UI-only. */
export function preferencePreview(session: Session | null) {
	return {
		schema: 'S6-preview',
		pairs:
			session?.completed.flatMap((round) =>
				round.order.flatMap((a, i) =>
					round.order.slice(i + 1).map((b, offset) => ({
						a,
						b,
						ratingA: round.ratings[i],
						ratingB: round.ratings[i + offset + 1]
					}))
				)
			) ?? []
	};
}
