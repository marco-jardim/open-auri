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
		case 'link':
			return m.curva_io_error_link();
		case 'envelope':
			return m.curva_io_error_envelope();
		case 'grid':
			return m.curva_io_error_grid();
		case 'format':
			return m.curva_io_error_format();
	}
}
