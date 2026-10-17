// Main destinations of the bar (FUX.NAV), shared by the inline navigation (Nav.svelte) and the
// mobile menu sheet (BarSheet.svelte, its own chunk), with the "Soe como X" warm-up (W5, FUX.2).
import { m } from '#lib/paraglide/messages.js';
import { prefetchUrl } from '#lib/app/warm.ts';

export interface NavItem {
	href: string;
	label: string;
	/** Fold order in the bar (0 always inline, 3 folds first). Custom items default to 0. */
	tier?: 0 | 1 | 2 | 3;
}

/**
 * The eight destinations. Tier 0 (Curva) is always inline, tier 1 from 721 px, tier 2 from
 * 1024 px, tier 3 from 1600 px; below, a link lives in "Mais" (or in the sheet on mobile).
 */
export function mainLinks(): NavItem[] {
	return [
		{ href: '/', label: m.chrome_nav_curve(), tier: 0 },
		{ href: '/biblioteca', label: m.chrome_nav_library(), tier: 1 },
		{ href: '/comparar', label: m.chrome_nav_compare(), tier: 2 },
		{ href: '/soe-como-x', label: m.chrome_nav_sound(), tier: 2 },
		{ href: '/comunidade', label: m.chrome_nav_community(), tier: 3 },
		{ href: '/teste-cego', label: m.chrome_nav_blind(), tier: 3 },
		{ href: '/cabo', label: m.chrome_nav_cable(), tier: 3 },
		{ href: '/docs', label: m.chrome_nav_docs(), tier: 3 }
	];
}

/** Path without query, hash or trailing slash ("/" for the home page), as links compare it. */
export function navPathname(path: string): string {
	return (path.split(/[?#]/)[0] ?? '').replace(/\/$/, '') || '/';
}

const SOUND_HREF = '/soe-como-x';
const AUTOEQ_INDEX_URL = '/data/autoeq/index.json';
// Module scope: one prefetch per session, however many times the bar remounts.
let autoEqIndexWarmed = false;

/** Pointer or keyboard intent on "Soe como X" prefetches the AutoEq index its page reads first. */
export function warmLink(href: string | null | undefined): void {
	if (href !== SOUND_HREF || autoEqIndexWarmed) return;
	autoEqIndexWarmed = true;
	prefetchUrl(AUTOEQ_INDEX_URL);
}
