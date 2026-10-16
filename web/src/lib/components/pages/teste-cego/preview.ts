import type { AudioEngine, PreviewChain } from '#lib/audio/engine.ts';
import type { Candidate } from './experiment.ts';

/** Owns only this page's chains; the application owns the source and AudioContext. */
export function createBlindPreview(engine: AudioEngine, candidates: readonly Candidate[]) {
	const first = candidates[0];
	const second = candidates[1];
	if (!first || !second || candidates.length > 3) throw new RangeError('candidates');
	const trims = engine.matchGains(candidates.map((c) => c.level));
	const ab = engine.createAB(first, second, {
		experimental: candidates.some((c) => c.experimental)
	});
	const chains: PreviewChain[] = [ab.a, ab.b];
	try {
		const third = candidates[2];
		if (third)
			chains.push(
				engine.buildChain(third.bands, third.preampDb, {
					experimental: third.experimental,
					on: false
				})
			);
	} catch (error) {
		ab.dispose();
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
