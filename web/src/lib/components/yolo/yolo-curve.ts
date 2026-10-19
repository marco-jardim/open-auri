/**
 * Helpers of the YOLO curve marks outside the editor: the waived codes as display text (for
 * `YoloCurveNotice`), the badge of a stored curve, and the publication rules the client follows
 * (the server decides: migration 0013, docs/api.md).
 *
 * - A YOLO curve opened to others (unlisted or public) needs the owner's acknowledgement
 *   (`acknowledge: 'yolo'`); a private save never does.
 * - 409 `YOLO_ACK_REQUIRED`: show the acknowledgement step; 403 `YOLO_PUBLICATION_OFF`: YOLO
 *   publication is off, save it as private; 403 `FORBIDDEN` with `reason: 'account-age'`: the
 *   account is too new to open a YOLO curve.
 */
import { lampOf } from '#lib/cable/checklist.ts';
import type { LampLabelKey } from '#lib/cable/types.ts';
import { lampLabel } from '#lib/components/cable/i18n.ts';
import { m } from '#lib/paraglide/messages.js';
import { isSocialApiError } from '#lib/social/api.ts';

export type Visibility = 'private' | 'unlisted' | 'public';

/** Lamp names of the waived codes, once each, in the page's language. */
export function waivedLabels(codes: readonly string[] | undefined): string[] {
	if (!codes) return [];
	const keys = [...new Set(codes.map((code): LampLabelKey => `cable_lamp_${lampOf(code)}`))];
	return keys.map((key) => lampLabel[key]());
}

/** Badge of a stored or listed curve: YOLO, a warning (refused today), or nothing. */
export type CurveBadge = 'yolo' | 'warn' | 'none';

export function curveBadge(curve: { gateOk?: boolean; yolo?: boolean }): CurveBadge {
	if (curve.yolo === true) return 'yolo';
	return curve.gateOk === false ? 'warn' : 'none';
}

/** Whether publishing a curve of this class with `visibility` needs the YOLO acknowledgement. */
export function needsYoloAck(yolo: boolean, visibility: Visibility): boolean {
	return yolo && visibility !== 'private';
}

/** What a failed YOLO publication asks for, or null when the error is not a YOLO rule. */
export type YoloPublishBlock = 'ack' | 'off' | 'account-age';

export function yoloPublishBlock(cause: unknown): YoloPublishBlock | null {
	if (!isSocialApiError(cause)) return null;
	if (cause.code === 'YOLO_ACK_REQUIRED') return 'ack';
	if (cause.code === 'YOLO_PUBLICATION_OFF') return 'off';
	if (cause.code === 'FORBIDDEN') {
		const details = cause.details;
		if (
			typeof details === 'object' &&
			details !== null &&
			!Array.isArray(details) &&
			Reflect.get(details, 'reason') === 'account-age'
		) {
			return 'account-age';
		}
	}
	return null;
}

/** The waived codes of a 409 `YOLO_ACK_REQUIRED` (`details.waived`), or []. */
export function ackWaived(cause: unknown): string[] {
	if (!isSocialApiError(cause)) return [];
	const details = cause.details;
	if (typeof details !== 'object' || details === null || Array.isArray(details)) return [];
	const waived: unknown = Reflect.get(details, 'waived');
	return Array.isArray(waived)
		? waived.filter((code): code is string => typeof code === 'string')
		: [];
}

/** The message of a YOLO publication refusal the acknowledgement cannot fix. */
export function yoloPublishText(block: 'off' | 'account-age'): string {
	return block === 'off' ? m.yolopub_error_off() : m.yolopub_error_account_age();
}
