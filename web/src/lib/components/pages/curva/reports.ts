/**
 * Sequencer data for the current curve: the 9 HID reports a write would send (core
 * `encodePayload` + `reportsFromPayload`, cross-checked against `encodeReports`), the commit
 * report and the nominal TX timing (9 × 16 ms, a 150 ms wait, then the commit). Nothing is sent.
 */
import {
	commitReport,
	encodePayload,
	encodeReports,
	PAYLOAD_SIZE,
	reportsFromPayload
} from 'open-auri/dsp';
import type { Curve } from './model.ts';

export const REPORT_INTERVAL_MS = 16;
export const COMMIT_WAIT_MS = 150;

export interface TxRow {
	/** 0…8 for data reports, `null` for the commit. */
	index: number | null;
	bytes: Uint8Array;
	/** Payload bytes carried by this report (the report 7 has 10, the report 8 none). */
	dataBytes: number;
	atMs: number;
}

export interface TxLog {
	payload: Uint8Array;
	rows: TxRow[];
	totalMs: number;
}

export function txLog(curve: Curve): TxLog {
	const payload = Uint8Array.from(encodePayload(curve.bands, curve.preampDb));
	const reports = reportsFromPayload(payload);
	const direct = encodeReports(curve.bands, curve.preampDb);
	if (
		direct.length !== reports.length ||
		direct.some((report, i) => report.some((byte, j) => byte !== reports[i]?.[j]))
	) {
		throw new Error('encodeReports and reportsFromPayload disagree');
	}
	const rows: TxRow[] = reports.map((bytes, index) => ({
		index,
		bytes,
		dataBytes: Math.max(0, Math.min(30, PAYLOAD_SIZE - index * 30)),
		atMs: index * REPORT_INTERVAL_MS
	}));
	// Same nominal schedule as the chart timeline: 9 × 16 ms + 150 ms = 294 ms.
	const commitAt = reports.length * REPORT_INTERVAL_MS + COMMIT_WAIT_MS;
	rows.push({ index: null, bytes: commitReport(), dataBytes: 0, atMs: commitAt });
	return { payload, rows, totalMs: commitAt };
}
