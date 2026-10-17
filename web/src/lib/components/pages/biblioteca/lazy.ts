// FUX.B (spec §5.3): the account shelves (Minha biblioteca, with creation insights and the merge
// banner) sit below the public shelves; they are their own chunk, loaded on approach or idle.
// TrackSheet keeps its own on-open import in Biblioteca.svelte.
import { LazyModule } from '#lib/app/lazy.svelte.ts';

export const minhaBiblioteca = new LazyModule(() => import('./MinhaBiblioteca.svelte'));
