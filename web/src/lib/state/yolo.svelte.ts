/**
 * Modo YOLO (plan §0.12.1, 1a): per tab, per page session, memory only.
 *
 * - Never persisted: no localStorage, sessionStorage, IndexedDB, cookie or URL. A reload or a
 *   closed tab starts with YOLO off, and another tab never sees this tab's YOLO.
 * - Only in the Engenharia layer: `enable` refuses any other layer, and `syncLayer` turns YOLO
 *   off as soon as the page leaves Engenharia.
 * - Turning it on requires the typed phrase ASSUMO O RISCO, compared after NFKC, trim and
 *   uppercasing (nothing else is forgiven).
 * - "Prévia sem limites" (`freePreview`) is a sub-mode of YOLO: any curve the codec accepts can
 *   be previewed, behind the preview limiter, and writing is disabled while it is on.
 *
 * The cable service reads `enabled` through its `yoloSession` port at every checklist
 * evaluation, so turning YOLO off refuses a YOLO write that was already being confirmed.
 */

/** The phrase that turns Modo YOLO on (pt-BR in every locale: it is a legal acknowledgement). */
export const YOLO_PHRASE = 'ASSUMO O RISCO';

/** The only layer where Modo YOLO exists. */
export const YOLO_LAYER = 'engenharia';

/** NFKC, trim and uppercase: the only normalization the typed phrase gets. */
export function normalizeYoloPhrase(text: string): string {
	return text.normalize('NFKC').trim().toUpperCase();
}

/** Whether `text` is the typed phrase (strings only; nothing is coerced). */
export function isYoloPhrase(text: unknown): boolean {
	return typeof text === 'string' && normalizeYoloPhrase(text) === YOLO_PHRASE;
}

export type YoloProfile = 'standard' | 'yolo';

/** Why a YOLO curve cannot be written right now (null: it can, if the checklist passes). */
export type YoloWriteBlock = 'free-preview' | null;

export interface YoloState {
	/** Modo YOLO is on in this tab (phrase typed, Engenharia layer). */
	readonly enabled: boolean;
	/** "Prévia sem limites": codec-only preview; writing is disabled while it is on. */
	readonly freePreview: boolean;
	/** `Date.now()` when YOLO was turned on (null when off). Memory only. */
	readonly enabledAt: number | null;
	/** Gate profile the editor and the cable use: `'yolo'` only while enabled. */
	readonly profile: YoloProfile;
	/** Turns YOLO on when `phrase` is the typed phrase and `layer` is Engenharia. */
	enable(phrase: unknown, layer: string): boolean;
	/** Turns YOLO (and the free preview) off. */
	disable(): void;
	/** Turns the free preview on or off (only while YOLO is on). */
	setFreePreview(on: boolean): void;
	/** Leaving Engenharia turns YOLO off. */
	syncLayer(layer: string): void;
	/** Reason a YOLO write is disabled now, or null. */
	writeBlock(): YoloWriteBlock;
}

/** A fresh, independent YOLO state (one per tab: the module singleton below). */
export function createYoloState(now: () => number = () => Date.now()): YoloState {
	let enabled = $state(false);
	let freePreview = $state(false);
	let enabledAt = $state<number | null>(null);

	return {
		get enabled() {
			return enabled;
		},
		get freePreview() {
			return enabled && freePreview;
		},
		get enabledAt() {
			return enabledAt;
		},
		get profile(): YoloProfile {
			return enabled ? 'yolo' : 'standard';
		},
		enable(phrase: unknown, layer: string): boolean {
			if (layer !== YOLO_LAYER || !isYoloPhrase(phrase)) return false;
			enabled = true;
			freePreview = false;
			enabledAt = now();
			return true;
		},
		disable() {
			enabled = false;
			freePreview = false;
			enabledAt = null;
		},
		setFreePreview(on: boolean) {
			freePreview = enabled && on === true;
		},
		syncLayer(layer: string) {
			if (layer !== YOLO_LAYER && enabled) {
				enabled = false;
				freePreview = false;
				enabledAt = null;
			}
		},
		writeBlock(): YoloWriteBlock {
			return enabled && freePreview ? 'free-preview' : null;
		}
	};
}

/** This tab's Modo YOLO. Module memory only: gone on reload, absent in other tabs. */
export const yolo: YoloState = createYoloState();
