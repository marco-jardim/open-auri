import {
	COMMIT_COMMAND,
	encodePayload,
	PAYLOAD_SIZE,
	PREAMBLE,
	REPORT_COUNT,
	REPORT_SIZE,
	reportsFromPayload
} from 'open-auri/dsp';
import type { Curve } from './response.ts';

export const WORD_LABELS = ['b₀', 'b₂', '−a₁', 'b₁', '−a₂'] as const;
export type PayloadRegionKind = 'header' | 'preamp' | 'section' | 'crc';
export interface PayloadRegion {
	kind: PayloadRegionKind;
	offset: number;
	length: number;
	section?: number;
	bytes: readonly number[];
}

export function payloadRegions(curve: Curve): PayloadRegion[] {
	const payload = encodePayload(curve.bands, curve.preampDb);
	const region = (
		kind: PayloadRegionKind,
		offset: number,
		length: number,
		section?: number
	): PayloadRegion => ({
		kind,
		offset,
		length,
		section,
		bytes: payload.slice(offset, offset + length)
	});
	const preampOffset = PREAMBLE.length;
	return [
		region('header', 0, preampOffset),
		region('preamp', preampOffset, 4),
		...Array.from({ length: 10 }, (_, i) => region('section', preampOffset + 4 + i * 20, 20, i)),
		region('crc', PAYLOAD_SIZE - 2, 2)
	];
}

export const REPORT_DELAY_MS = 16;
export const COMMIT_DELAY_MS = 150;

/** Nominal protocol delays, not measured USB or flash completion time. */
export function reportTimeline(curve: Curve) {
	const payload = encodePayload(curve.bands, curve.preampDb);
	const reports = reportsFromPayload(payload).map((bytes, index) => ({
		index,
		bytes,
		atMs: index * REPORT_DELAY_MS,
		endMs: (index + 1) * REPORT_DELAY_MS,
		dataBytes: Math.max(0, Math.min(REPORT_SIZE - 1, PAYLOAD_SIZE - index * (REPORT_SIZE - 1)))
	}));
	const reportsEndMs = REPORT_COUNT * REPORT_DELAY_MS;
	return {
		reports,
		reportsEndMs,
		commitAtMs: reportsEndMs + COMMIT_DELAY_MS,
		totalMs: reportsEndMs + COMMIT_DELAY_MS,
		commitBytes: COMMIT_COMMAND
	};
}

export function hexBytes(bytes: ArrayLike<number>): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
