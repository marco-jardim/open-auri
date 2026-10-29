import { untrack } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { snapshotBands } from 'open-auri/dsp';
import type { ClientApp } from '#lib/app/client.svelte.ts';
import type { PreviewCurve } from '#lib/audio/engine.ts';
import type { LiveState } from '#lib/cable/types.ts';
import { browserFlat, liveActive } from './live.ts';

/** The browser must not add another EQ on top of the cable's live curve. */
export function appBrowserFlat(app: ClientApp | null): boolean {
	const state = app?.cableState;
	if (!state || !app) return false;
	return browserFlat(state, state.live ? untrack(() => app.cable.liveSavedCurve()) : null);
}

export function flatCurve<T extends PreviewCurve>(curve: T): T {
	return { ...curve, bands: snapshotBands(NEUTRO.bands), preampDb: NEUTRO.preampDb };
}

export function liveComparing(live: LiveState | null | undefined): boolean {
	return liveActive(live) && live.comparison?.active === true && !live.comparison.blind;
}
