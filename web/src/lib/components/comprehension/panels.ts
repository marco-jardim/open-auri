// FUX.B (spec §5.3): the open panels of the comprehension layer are their own chunks. The page
// keeps only the triggers and the tour controller; the step definitions of the seven tours, the
// explainer bodies, positioning and the panel markup load on first intent (hover, focus, press)
// or when a tour opens. One shared loader each, so every trigger on a page reuses the same chunk;
// a failed import (offline before the chunk was cached) is retried on the next intent.
import { LazyModule } from '#lib/app/lazy.svelte.ts';

export const tourPanel = new LazyModule(() => import('./TourPanel.svelte'));
export const explainerPanel = new LazyModule(() => import('./ExplainerPanel.svelte'));
