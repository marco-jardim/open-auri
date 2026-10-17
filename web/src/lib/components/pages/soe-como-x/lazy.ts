// FUX.B (spec §5.3): the drawn-target editor only shows after the reader picks "drawn" as the
// target; it is its own chunk, loaded on approach or idle behind a same-size box. The meters in
// Preview stay static (plan §0.12, spec §5.5); the AutoEq index and SocialPublish keep their
// own on-demand imports.
import { LazyModule } from '#lib/app/lazy.svelte.ts';

export const targetEditor = new LazyModule(() => import('./TargetEditor.svelte'));
