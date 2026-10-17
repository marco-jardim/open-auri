// FUX.B (spec §5.3): Curva's panels that are not on the first screen are their own chunks. The
// filter bank shows on the Ajustar and Engenharia layers only, the cabinet (with Inspector and
// Sequencer, already on-open) on Engenharia only, and ImportExport sits in the lower band. Each
// loads on approach or idle behind a same-size box; CurvaPage also warms the layer panels on
// idle, so switching layers normally finds them ready. Meters stay static (plan §0.12, §5.5).
import { LazyModule } from '#lib/app/lazy.svelte.ts';

export const filterBank = new LazyModule(() => import('./FilterBank.svelte'));
export const cabinet = new LazyModule(() => import('./Cabinet.svelte'));
export const importExport = new LazyModule(() => import('./ImportExport.svelte'));
