/**
 * Modo YOLO rules of the Curva editor (pure; the state lives in lib/state/yolo.svelte.ts).
 *
 * - The editor's gate profile: standard, YOLO, or codec-only during "Prévia sem limites".
 * - Every way a curve leaves the editor other than the cable is disabled in YOLO, with a reason:
 *   S5 envelope, `#p=` link, .txt and .bin export, save to the library, publish and save to the
 *   account. YOLO curves are never saved, shared or published.
 * - Writing is disabled during the free preview.
 * - "Trazer para o modo normal" only when the curve passes the standard gate.
 */
import type { EditorProfile } from '#lib/workers/gate-handler.ts';
import { verdictFor, type Curve } from './model.ts';

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
