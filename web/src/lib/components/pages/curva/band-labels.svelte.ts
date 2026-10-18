/**
 * The one place that reads and writes the custom band names (bank rename and scope handles).
 * They are the editor curve's own `CurveData.labels` (`app.state.curve.labels`), the single
 * source of truth: persisted in `oa.current`, the undo history, the local library, S5 files
 * (`open-auri/preset@2`) and cloud versions. Never in `#p=` links, S1, curveId or the gate.
 * Without the app (SSR before mount, isolated renders) the names live in a local state.
 */
import { getAppContext, type AppContext } from '#lib/app/context.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import { checkLabel, withLabel, type BandWords, type LabelCheck } from './band-names.ts';

export interface BandLabels {
	/** Custom name by slot; null (or missing) where the automatic name applies. */
	readonly labels: readonly (string | null)[];
	/**
	 * Sets slot `index` after the strict S5 `@2` check (`checkLabel`: at most `LABEL_MAX`, 24,
	 * code points; no links, controls or ill-formed text); empty or null: automatic name. A
	 * refused name changes nothing and comes back with its envelope codes: it is never cut or
	 * silently dropped.
	 */
	rename(index: number, name: string | null): LabelCheck;
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
			const checked = checkLabel(name);
			if (!checked.ok) return checked;
			const target = store();
			const next = withLabel(target?.labels ?? local, index, checked.label);
			if (target) target.setLabels(next);
			else local = next;
			return checked;
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
