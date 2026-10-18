/**
 * The one place that reads and writes the custom band names (bank rename and scope handles).
 * They live beside the editor curve (`app.state.curve.labels`), in client state only: share
 * links, the local library and the cloud do not carry them yet. Wiring persistence later means
 * changing this module (and the store), not its callers.
 * Without the app (SSR before mount, isolated renders) the names live in a local state.
 */
import { getAppContext, type AppContext } from '#lib/app/context.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import { withLabel, type BandWords } from './band-names.ts';

export interface BandLabels {
	/** Custom name by slot; null (or missing) where the automatic name applies. */
	readonly labels: readonly (string | null)[];
	/** Sets slot `index` (normalized, at most 16 characters); empty or null: automatic name. */
	rename(index: number, name: string | null): void;
}

function optionalContext(): AppContext | null {
	try {
		return getAppContext();
	} catch {
		return null;
	}
}

/** Call during component initialization. */
export function useBandLabels(): BandLabels {
	const context = optionalContext();
	let local = $state.raw<readonly (string | null)[]>([]);
	const store = () => context?.client?.state.curve ?? null;
	return {
		get labels() {
			return store()?.labels ?? local;
		},
		rename(index, name) {
			const target = store();
			const next = withLabel(target?.labels ?? local, index, name);
			if (target) target.setLabels(next);
			else local = next;
		}
	};
}

/**
 * The copy `bandNames` needs, in the page's locale. Built once per component: a language switch
 * reloads the page. The explicit locale spares Paraglide a cookie read per message.
 */
export function bandWords(): BandWords {
	const options = { locale: getLocale() };
	return {
		locale: options.locale,
		regions: {
			sub: m.curva_bn_region_sub({}, options),
			bass: m.curva_bn_region_bass({}, options),
			body: m.curva_bn_region_body({}, options),
			mids: m.curva_bn_region_mids({}, options),
			presence: m.curva_bn_region_presence({}, options),
			brilliance: m.curva_bn_region_brilliance({}, options),
			air: m.curva_bn_region_air({}, options)
		},
		free: m.curva_bn_free({}, options),
		cut: (freq) => m.curva_bn_cut({ freq }, options),
		lowCut: m.curva_bn_low_cut({}, options),
		highCut: m.curva_bn_high_cut({}, options)
	};
}
