import { isKindAllowed, isExperimentalKind, LAYER_KINDS } from 'open-auri/safety';

export type Layer = keyof typeof LAYER_KINDS;

/** Ouvir ⊂ Ajustar ⊂ Engenharia: every layer keeps what the previous one shows. */
export const LAYERS: readonly Layer[] = ['ouvir', 'ajustar', 'engenharia'];
export const DEFAULT_LAYER: Layer = 'ouvir';
export const LAYER_PARAM = 'camada';

export function isLayer(value: unknown): value is Layer {
	return LAYERS.some((layer) => layer === value);
}

/** Unknown or missing values fall back to Ouvir; the URL is never trusted beyond the three names. */
export function parseLayer(value: string | null | undefined): Layer {
	return isLayer(value) ? value : DEFAULT_LAYER;
}

export function layerRank(layer: Layer): number {
	return LAYERS.indexOf(layer);
}

/** Whether `layer` shows everything `minimum` shows (the inclusion of the layer model). */
export function includesLayer(layer: Layer, minimum: Layer): boolean {
	return layerRank(layer) >= layerRank(minimum);
}

/** Anything with an absolute `href`: a URL or SvelteKit's read-only `page.url`. */
export interface UrlLike {
	readonly href: string;
}

/** URL for `layer`, keeping every other query parameter and the hash (`#p=` links survive). */
export function layerUrl(current: UrlLike, layer: Layer): URL {
	const next = new URL(current.href);
	if (layer === DEFAULT_LAYER) next.searchParams.delete(LAYER_PARAM);
	else next.searchParams.set(LAYER_PARAM, layer);
	return next;
}

/** Keys 1/2/3 select a layer; anything else returns null. */
export function layerFromKey(key: string): Layer | null {
	const index = ['1', '2', '3'].indexOf(key);
	return index < 0 ? null : (LAYERS[index] ?? null);
}

/** Ignore layer keys while typing, with modifiers or while a dialog is open. */
export function isLayerKeyEvent(event: {
	key: string;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	repeat: boolean;
	defaultPrevented: boolean;
	isComposing?: boolean;
	target: EventTarget | null;
}): boolean {
	if (event.defaultPrevented || event.repeat || event.isComposing) return false;
	if (event.altKey || event.ctrlKey || event.metaKey) return false;
	const target = event.target;
	if (
		typeof Element !== 'undefined' &&
		target instanceof Element &&
		target.closest(
			'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"]'
		)
	) {
		return false;
	}
	return layerFromKey(event.key) !== null;
}

export function kindsForLayer(layer: Layer): readonly string[] {
	return LAYER_KINDS[layer];
}

export function kindAllowed(kind: string, layer: Layer): boolean {
	return kind === 'OFF' || isKindAllowed(kind, layer);
}

/** HS/LP/HP are visible everywhere but editable only in Engenharia (experimental). */
export function isLockedKind(kind: string, layer: Layer): boolean {
	return isExperimentalKind(kind) && layer !== 'engenharia';
}
