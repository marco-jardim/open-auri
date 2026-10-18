/**
 * Modo YOLO rules of the Curva editor (pure; the state lives in lib/state/yolo.svelte.ts).
 *
 * - The editor's gate profile: standard, YOLO, or codec-only during "Prévia sem limites".
 * - Every way a curve leaves the editor other than the cable is disabled in YOLO, with a reason:
 *   S5 envelope, `#p=` link, .txt and .bin export, save to the library, publish and save to the
 *   account. YOLO curves are never saved, shared or published.
 * - Writing is disabled during the free preview.
 * - "Trazer para o modo normal" only when the curve passes the standard gate.
 * - Whether or not YOLO is on, a curve leaves for the library, a link, a file, the account or a
 *   publication only when the **standard** gate accepts it (`exitRefusal`). YOLO lives in memory
 *   only, so a reload turns it off while the YOLO-only curve it left in `oa.current` comes back
 *   to the editor: checking whether YOLO is on is not enough.
 */
import type { EditorProfile } from '#lib/workers/gate-handler.ts';
import { m } from '#lib/paraglide/messages.js';
import { verdictFor, type Curve } from './model.ts';
import { firstReasonText, type Reason } from './reasons.ts';

/** Every export, share and save path of the editor (all disabled in Modo YOLO). */
export const YOLO_BLOCKED_ACTIONS = Object.freeze([
	's5',
	'link',
	'txt',
	'bin',
	'library',
	'publish',
	'account'
] as const);

export type EditorExit = (typeof YOLO_BLOCKED_ACTIONS)[number];

/** Gate profile of the editor's drags and edits. */
export function editorProfile(enabled: boolean, freePreview: boolean): EditorProfile {
	if (!enabled) return 'standard';
	return freePreview ? 'codec' : 'yolo';
}

/** Why `action` is unavailable: `'yolo'` while Modo YOLO is on, otherwise null. */
export function exitBlock(action: EditorExit, yoloEnabled: boolean): 'yolo' | null {
	return yoloEnabled && YOLO_BLOCKED_ACTIONS.includes(action) ? 'yolo' : null;
}

/** Whether every export, share and save path is disabled (Modo YOLO on). */
export function exportsDisabled(yoloEnabled: boolean): boolean {
	return YOLO_BLOCKED_ACTIONS.every((action) => exitBlock(action, yoloEnabled) !== null);
}

/** Why writing is disabled by Modo YOLO itself (the free preview), or null. */
export function yoloWriteBlock(enabled: boolean, freePreview: boolean): 'free-preview' | null {
	return enabled && freePreview ? 'free-preview' : null;
}

/** "Trazer para o modo normal": allowed only when the curve passes the standard gate. */
export function canBringBack(curve: Curve): boolean {
	return verdictFor(curve, 'standard').ok;
}

/**
 * Why `curve` may not be saved to the library, shared, exported or published: `'yolo'` while
 * Modo YOLO is on (nothing leaves), `'gate'` (with the gate's reasons) when the standard gate
 * refuses it, else null. The standard profile is used whatever the editor's profile is, so a
 * curve that passes only under YOLO (class 2 waived) is refused with YOLO off as well.
 */
export type ExitRefusal =
	| { readonly kind: 'yolo' }
	| { readonly kind: 'gate'; readonly reasons: readonly Reason[] };

export function exitRefusal(curve: Curve, yoloEnabled = false): ExitRefusal | null {
	if (yoloEnabled) return { kind: 'yolo' };
	const verdict = verdictFor(curve, 'standard');
	return verdict.ok ? null : { kind: 'gate', reasons: verdict.reasons };
}

/**
 * The disabled-button text of an exit refusal: `yolo_reason_no_export` in Modo YOLO, otherwise
 * the standard gate's first reason (band and frequency from `curve`).
 */
export function exitRefusalText(refusal: ExitRefusal, curve: Curve, locale?: string): string {
	if (refusal.kind === 'yolo') return m.yolo_reason_no_export();
	return firstReasonText(refusal.reasons, { bands: curve.bands, locale });
}

/** `exitRefusal` and its text in one call: null when `curve` may leave. */
export function exitReason(curve: Curve, yoloEnabled = false, locale?: string): string | null {
	const refusal = exitRefusal(curve, yoloEnabled);
	return refusal === null ? null : exitRefusalText(refusal, curve, locale);
}
