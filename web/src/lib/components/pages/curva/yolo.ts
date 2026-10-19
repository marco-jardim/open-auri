/**
 * Modo YOLO rules of the Curva editor (pure; the state lives in lib/state/yolo.svelte.ts).
 *
 * - The editor's gate profile: standard, YOLO, or codec-only during "Prévia sem limites".
 * - Writing is disabled during the free preview.
 * - "Trazer para o modo normal" only when the curve passes the standard gate; "Trazer para os
 *   limites padrão" (`standardCurve`) only when clamping the bands and the automatic preamp give
 *   a curve that does.
 * - Exits (library, `#p=` link, .txt, S5, .bin, account save, publication) are class-based, with
 *   the core's `classifyCurve` (cached, gate-verdicts.ts): a standard curve leaves as it is; a
 *   YOLO curve leaves everywhere, whether or not YOLO is on in this tab, and carries the YOLO
 *   mark (badge, `-yolo` file name, the .txt header, the publish acknowledgement); only a
 *   rejected curve (class 1, or a preamp below −25,5 dB that S1 v1/v2 cannot encode) is refused.
 *   The class is always derived from the curve: S1 and S5 never carry a YOLO marker.
 */
import { autoPreamp, clampToAbs } from 'open-auri/safety';
import { curveClassification, type CurveClassification } from '#lib/gate-verdicts.ts';
import type { EditorProfile } from '#lib/workers/gate-handler.ts';
import { hasExperimental, verdictFor, type Band, type Curve } from './model.ts';
import { firstReasonText, type Reason } from './reasons.ts';

export type { CurveClassification };

/** Gate profile of the editor's drags and edits. */
export function editorProfile(enabled: boolean, freePreview: boolean): EditorProfile {
	if (!enabled) return 'standard';
	return freePreview ? 'codec' : 'yolo';
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
 * "Trazer para os limites padrão": every band clamped to the absolute ranges (`clampToAbs`, D7
 * included), then the standard automatic preamp. The result only when it passes the standard
 * gate (`canBringBack`), else null (the action is not offered).
 */
export function standardCurve(curve: Curve): Curve | null {
	const bands: Band[] = curve.bands.map((band) => clampToAbs(band));
	const preampDb = autoPreamp(bands, { experimental: hasExperimental(bands) });
	if (preampDb === null) return null;
	const next: Curve = { bands, preampDb };
	return canBringBack(next) ? next : null;
}

/** The class of a curve (standard, YOLO with its waived codes, rejected with its codes). */
export function classOf(curve: Curve): CurveClassification {
	return curveClassification(curve.bands, curve.preampDb);
}

/** Whether the curve is YOLO: refused by the standard gate on waivable reasons only. */
export function isYoloCurve(curve: Curve): boolean {
	return classOf(curve).class === 'yolo';
}

/**
 * The mark a curve carries when it leaves the editor: `{ waived }` for a YOLO curve (the codes
 * the YOLO profile waived), null for a standard or rejected one.
 */
export function exitMark(curve: Curve): { readonly waived: readonly string[] } | null {
	const classification = classOf(curve);
	return classification.class === 'yolo' ? { waived: classification.waived } : null;
}

/**
 * Why `curve` may not be saved to the library, shared, exported or published: only a rejected
 * curve (class 1, or a preamp below −25,5 dB) is refused, with the gate's reasons for its
 * blocking codes. Standard and YOLO curves leave (YOLO with its mark), whatever the profile.
 */
export interface ExitRefusal {
	readonly kind: 'gate';
	readonly reasons: readonly Reason[];
}

export function exitRefusal(curve: Curve): ExitRefusal | null {
	const classification = classOf(curve);
	if (classification.class !== 'rejected') return null;
	return { kind: 'gate', reasons: blockingReasons(curve, classification.reasons) };
}

/** The gate's reasons behind `codes` (standard first, then YOLO-only codes); never empty. */
function blockingReasons(curve: Curve, codes: readonly string[]): readonly Reason[] {
	const wanted = new Set(codes);
	const standard = verdictFor(curve, 'standard').reasons;
	const own = standard.filter((reason) => wanted.has(reason.code));
	if (own.length > 0) return own;
	const yolo = verdictFor(curve, 'yolo').reasons.filter((reason) => wanted.has(reason.code));
	return yolo.length > 0 ? yolo : standard;
}

/** The disabled-button text of an exit refusal: the first blocking reason (band, frequency). */
export function exitRefusalText(refusal: ExitRefusal, curve: Curve, locale?: string): string {
	return firstReasonText(refusal.reasons, { bands: curve.bands, locale });
}

/** `exitRefusal` and its text in one call: null when `curve` may leave. */
export function exitReason(curve: Curve, locale?: string): string | null {
	const refusal = exitRefusal(curve);
	return refusal === null ? null : exitRefusalText(refusal, curve, locale);
}
