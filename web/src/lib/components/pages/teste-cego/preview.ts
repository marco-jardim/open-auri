import { NEUTRO } from 'open-auri/catalog';
import { snapshotBands } from 'open-auri/dsp';
import type { AudioEngine, PreviewChain } from '#lib/audio/engine.ts';
import type { Candidate } from './experiment.ts';

/**
 * The blind test on the cable (issue #74): the cable plays the candidates, so the browser plays
 * ONE flat chain (Neutro, trim 0) for all of them: no per-candidate chain, trim or protection to
 * tell them apart. `select` never unmutes (the cable round's switch window does, with `unmute`).
 */
export function createFlatPreview(engine: AudioEngine) {
	const chain = engine.buildChain(snapshotBands(NEUTRO.bands), NEUTRO.preampDb, {
		gainDb: 0,
		on: false
	});
	const chains: PreviewChain[] = [chain];
	const trims: number[] = [0];
	return {
		chains,
		trims,
		mute: () => chain.setGain(0, false),
		unmute: () => chain.setGain(0, true),
		select(id: string) {
			void id;
		},
		dispose: () => chain.dispose()
	};
}

/**
 * Owns only this page's chains; the application owns the source and AudioContext.
 *
 * Protection (C1): the candidates share one preview protection (`engine.sharedProtection`, with
 * their level-match trims), as `createAB` gives a pair. When any candidate fails the standard
 * gate (or is louder than it allows), every chain gets the same normalize gain and limiter: the
 * level match holds, and the protection itself never tells which candidate is which (equal gain
 * staging on every chain). Otherwise no chain has any.
 */
export function createBlindPreview(engine: AudioEngine, candidates: readonly Candidate[]) {
	const first = candidates[0];
	const second = candidates[1];
	if (!first || !second || candidates.length > 3) throw new RangeError('candidates');
	const trims = engine.matchGains(candidates.map((c) => c.level));
	const protect = engine.sharedProtection(
		candidates.map((c, i) => ({ bands: c.bands, preampDb: c.preampDb, trimDb: trims[i] ?? 0 }))
	);
	const chains: PreviewChain[] = [];
	try {
		candidates.forEach((c, i) => {
			chains.push(
				engine.buildChain(c.bands, c.preampDb, {
					experimental: c.experimental,
					// The trim plays ahead of the protection: the shared gain counts it.
					gainDb: trims[i] ?? 0,
					on: false,
					...(protect ? { protect } : {})
				})
			);
		});
	} catch (error) {
		chains.forEach((chain) => chain.dispose());
		throw error;
	}
	// Silence keeps each chain's trim, so no limiter ever sees a level the shared gain did not count.
	const mute = () => chains.forEach((chain, i) => chain.setGain(trims[i] ?? 0, false));
	mute();
	return {
		chains,
		trims,
		mute,
		select(id: string) {
			chains.forEach((chain, i) => chain.setGain(trims[i] ?? 0, candidates[i]?.id === id));
		},
		dispose() {
			chains.forEach((chain) => chain.dispose());
		}
	};
}
