import { describe, expect, test } from 'vitest';
import { PADRAO_AURI } from 'open-auri/catalog';
import { encodeReports } from 'open-auri/dsp';
import { payloadCrc } from '#lib/components/pages/curva/format.ts';
import { txLog } from '#lib/components/pages/curva/reports.ts';

describe('sequencer TX log', () => {
	test('9 reports of 31 bytes plus the commit, with nominal timing', () => {
		const curve = { bands: PADRAO_AURI.bands, preampDb: PADRAO_AURI.preampDb };
		const log = txLog(curve);
		expect(log.payload).toHaveLength(220);
		expect(log.rows).toHaveLength(10);
		const reports = encodeReports(curve.bands, curve.preampDb);
		log.rows.slice(0, 9).forEach((row, i) => {
			expect(row.index).toBe(i);
			expect(row.bytes).toHaveLength(31);
			expect([...row.bytes]).toEqual([...(reports[i] ?? [])]);
			expect(row.atMs).toBe(i * 16);
		});
		expect(log.rows.map((row) => row.dataBytes)).toEqual([30, 30, 30, 30, 30, 30, 30, 10, 0, 0]);
		const commit = log.rows[9];
		expect(commit?.index).toBeNull();
		expect([...(commit?.bytes ?? []).slice(0, 5)]).toEqual([0x01, 0x65, 0x00, 0x01, 0xff]);
		expect(commit?.atMs).toBe(294);
		expect(log.totalMs).toBe(294);
		expect(payloadCrc(log.payload)).toBe(
			`0x${PADRAO_AURI.crc.toString(16).toUpperCase().padStart(4, '0')}`
		);
	});
});
