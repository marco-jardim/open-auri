// FUX.B (spec §5.3): the blend panel closes the Comparar page, below the deck and the lanes; it is
// its own chunk, loaded on approach or idle behind a same-size box. SocialPublish and the PNG
// export keep their own on-demand imports.
import { LazyModule } from '#lib/app/lazy.svelte.ts';

export const blendPanel = new LazyModule(() => import('./BlendPanel.svelte'));
