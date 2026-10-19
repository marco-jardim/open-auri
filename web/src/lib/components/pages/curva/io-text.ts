import { m } from '#lib/paraglide/messages.js';
import type { IoFailure } from './io.ts';
import { firstReasonText } from './reasons.ts';

/** Plain-language explanation of an import/export failure (gate failures name the gate reason). */
export function ioFailureText(failure: IoFailure): string {
	switch (failure.error) {
		case 'gate':
			return firstReasonText(failure.reasons);
		case 'too-many':
			return m.curva_io_error_too_many();
		case 'experimental-layer':
			return m.curva_io_error_experimental();
		case 'ultrasonic-layer':
			return m.yolopub_io_error_ultrasonic();
		case 'link':
			// An S1 version this build does not know: the link comes from a newer open-auri.
			return failure.detail === 's1:version'
				? m.yolopub_io_error_link_newer()
				: m.curva_io_error_link();
		case 'envelope':
			return m.curva_io_error_envelope();
		case 'grid':
			return m.curva_io_error_grid();
		case 'format':
			return m.curva_io_error_format();
	}
}
