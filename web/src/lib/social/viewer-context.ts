import { getContext, setContext } from 'svelte';

/** Who is reading, as the layout's AccountSession knows it (reactive getters, never e-mail). */
export interface Viewer {
	/** Signed-in summary, or null (anonymous or not known yet). */
	readonly current: { readonly username: string | null } | null;
	/** The session has been answered (dynamic page data or a successful prerender probe). */
	readonly known: boolean;
}

export const VIEWER_CONTEXT = Symbol('viewer');
/** The layout provides its AccountSession, so prerendered pages know the viewer without props. */
export function setViewer(viewer: Viewer): Viewer {
	return setContext(VIEWER_CONTEXT, viewer);
}
/** Isolated previews/tests have no layout provider: the viewer is unknown. */
export function getViewer(): Viewer | undefined {
	return getContext<Viewer | undefined>(VIEWER_CONTEXT);
}
