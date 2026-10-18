import type { AudioEngine, PreviewChain } from '#lib/audio/engine.ts';
import type { Candidate } from './experiment.ts';

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
		for (const c of candidates) {
			chains.push(
				engine.buildChain(c.bands, c.preampDb, {
					experimental: c.experimental,
					on: false,
					...(protect ? { protect } : {})
				})
			);
		}
	} catch (error) {
		chains.forEach((chain) => chain.dispose());
		throw error;
	}
	const mute = () => chains.forEach((chain) => chain.setGain(0, false));
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
