/**
 * The one place that reads and writes the custom band names (bank rename and scope handles).
 * They are the editor curve's own `CurveData.labels` (`app.state.curve.labels`), the single
 * source of truth: persisted in `oa.current`, the undo history, the local library, S5 files
 * (`open-auri/preset@2`) and cloud versions. Never in `#p=` links, S1, curveId or the gate.
 * Without the app (SSR before mount, isolated renders) the names live in a local state.
 *
 * The Curva page may lay a view over them (`provideBandLabelView`): during the free preview the
 * editor shows a memory-only draft whose filters may be in another order than the stored
 * curve's. Then the names shown are the draft's, and a rename of draft slot i is written to the
 * stored slot the view maps it to, so it lands on the filter it was given to.
 */
import { getContext, setContext } from 'svelte';
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

/** A view over the stored names, in the editor's slot order (the free-preview draft's). */
export interface BandLabelView {
	/** Names by editor slot; null (or missing) where the automatic name applies. */
	readonly labels: readonly (string | null)[];
	/** The stored curve's slot of the filter at editor slot `index`: where its rename goes. */
	storedSlot(index: number): number;
}
type ViewSource = () => BandLabelView | null;

const VIEW_KEY = Symbol('curva-band-label-view');
const NO_VIEW: ViewSource = () => null;

/**
 * Lays `view` over the names for this component's descendants (call during component
 * initialization). Read at every access: return null while the stored order applies.
 */
export function provideBandLabelView(view: ViewSource): void {
	setContext(VIEW_KEY, view);
}

function optionalContext(): AppContext | null {
	try {
		return getAppContext();
	} catch {
		return null;
	}
}

function isViewSource(value: unknown): value is ViewSource {
	return typeof value === 'function';
}

function optionalView(): ViewSource {
	try {
		const view: unknown = getContext(VIEW_KEY);
		return isViewSource(view) ? view : NO_VIEW;
	} catch {
		// Outside a component's initialization: no page lays a view.
		return NO_VIEW;
	}
}

/** Call during component initialization. */
export function useBandLabels(): BandLabels {
	const context = optionalContext();
	const view = optionalView();
	let local = $state.raw<readonly (string | null)[]>([]);
	const store = () => context?.client?.state.curve ?? null;
	return {
		get labels() {
			return view()?.labels ?? store()?.labels ?? local;
		},
		rename(index, name) {
			const checked = checkLabel(name);
			if (!checked.ok) return checked;
			const target = store();
			if (target) {
				// Through the view (the free-preview draft), the stored slot of that filter.
				const slot = view()?.storedSlot(index) ?? index;
				target.setLabels(withLabel(target.labels, slot, checked.label));
			} else {
				local = withLabel(local, index, checked.label);
			}
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
