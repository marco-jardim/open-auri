import { describe, expect, it } from 'vitest';
import { OFFICIAL_PRESETS, NEUTRO } from 'open-auri/catalog';
import {
	curveResponseDb,
	encodePayload,
	GRID,
	magnitudeDb,
	quantizedPreampDb
} from 'open-auri/dsp';
import {
	dbScale,
	dbTicks,
	frequencyLabel,
	linePath,
	logScale,
	numberLabel,
	RESPONSE_BOX
} from '../../../src/lib/charts/scales.ts';
import { miniCurvePath, responseGeometry } from '../../../src/lib/charts/response.ts';
import { hexBytes, payloadRegions, reportTimeline } from '../../../src/lib/charts/protocol.ts';
import { polarGeometry, polarResponse, poleZeroGeometry } from '../../../src/lib/charts/plane.ts';
import {
	curveErrors,
	errorHeatGeometry,
	wiggleGeometry
} from '../../../src/lib/charts/diagnostics.ts';

describe('chart scales and SVG paths', () => {
	it('maps log frequency endpoints and geometric midpoint exactly', () => {
		const x = logScale(20, 20000, 48, 788);
		expect(x(20)).toBe(48);
		expect(x(20000)).toBe(788);
		expect(x(Math.sqrt(20 * 20000))).toBeCloseTo(418, 10);
		expect(() => logScale(0, 20000)).toThrow(RangeError);
	});

	it('uses upward dB coordinates and readable localized ticks', () => {
		const y = dbScale(-24, 12, 330, 20);
		expect(y(-24)).toBe(330);
		expect(y(12)).toBe(20);
		expect(dbTicks()).toEqual([-24, -18, -12, -6, 0, 6, 12]);
		expect(dbTicks(-7, 7, 3)).toEqual([-6, -3, 0, 3, 6]);
		expect(() => dbTicks(-24, 12, 0)).toThrow(RangeError);
		expect(() => dbScale(12, -24)).toThrow(RangeError);
		expect(numberLabel(-1.2, 'pt-BR', 1)).toBe('−1,2');
		expect(frequencyLabel(2500, 'en-US')).toBe('2.5k');
	});

	it('breaks paths at missing data and handles empty traces', () => {
		expect(linePath([])).toBe('');
		expect(
			linePath([
				{ x: 0, y: 1 },
				{ x: NaN, y: 2 },
				{ x: 3, y: 4 }
			])
		).toBe('M0.000,1.000M3.000,4.000');
		expect(linePath([{ x: 0, y: 0 }], true)).toBe('M0.000,0.000Z');
	});

	it.each([...OFFICIAL_PRESETS, NEUTRO])('projects core response and preamp: $id', (curve) => {
		const geometry = responseGeometry(curve);
		expect(geometry.eq).toEqual(curveResponseDb({ bands: curve.bands }, GRID));
		expect(geometry.output).toEqual(curveResponseDb(curve, GRID));
		expect(geometry.eq[0]).toBe(magnitudeDb(curve.bands, 20));
		expect(geometry.output[0] - geometry.eq[0]).toBeCloseTo(curve.preampDb, 12);
		expect(geometry.eqPath).toMatch(/^M66\.000,/);
		expect(geometry.outputPath).toContain('L788.000,');
		expect(geometry.outputPath.match(/[ML]/g)).toHaveLength(GRID.length);
		expect(geometry.outputPath).not.toMatch(/NaN|Infinity/);
		expect(miniCurvePath(curve)).toMatch(/^M1\.000,/);
		expect(geometry.y(12)).toBe(RESPONSE_BOX.top);
	});
});

describe('wire diagrams', () => {
	it.each([...OFFICIAL_PRESETS, NEUTRO])('partitions the exact 220-byte payload: $id', (curve) => {
		const regions = payloadRegions(curve);
		expect(regions.map((region) => region.length)).toEqual([14, 4, ...Array(10).fill(20), 2]);
		expect(regions.reduce((total, region) => total + region.length, 0)).toBe(220);
		expect(regions.flatMap((region) => region.bytes)).toEqual(
			encodePayload(curve.bands, curve.preampDb)
		);
		expect(regions.at(-1)?.offset).toBe(218);
		for (let i = 1; i < regions.length; i++) {
			expect(regions[i].offset).toBe(regions[i - 1].offset + regions[i - 1].length);
		}
	});

	it('has nine real frames, 16 ms spacing, a 150 ms wait and a 0.294 s commit', () => {
		const timeline = reportTimeline(NEUTRO);
		expect(timeline.reports).toHaveLength(9);
		expect(timeline.reports.map((report) => report.dataBytes)).toEqual([
			30, 30, 30, 30, 30, 30, 30, 10, 0
		]);
		expect(timeline.reports.every((report) => report.endMs - report.atMs === 16)).toBe(true);
		expect(timeline.reportsEndMs).toBe(144);
		expect(timeline.commitAtMs - timeline.reportsEndMs).toBe(150);
		expect(timeline.totalMs / 1000).toBeCloseTo(0.294, 10);
		expect(hexBytes(timeline.commitBytes)).toBe('01 65 00 01 FF');
	});
});

describe('quantized complex plane', () => {
	it.each([...OFFICIAL_PRESETS, NEUTRO])('plots Q27 poles within the unit circle: $id', (curve) => {
		for (const section of poleZeroGeometry(curve.bands)) {
			expect(section.words).toHaveLength(5);
			const radii = section.poles.map((p) => Math.hypot(p.x, p.y));
			expect(Math.max(...radii)).toBeCloseTo(section.radius, 12);
			expect(radii.every((radius) => radius < 1)).toBe(true);
		}
		const samples = polarResponse(curve, 97);
		expect(samples[0].freqHz).toBe(0);
		expect(samples.at(-1)?.freqHz).toBe(48000);
		expect(polarGeometry(samples).positive).not.toMatch(/NaN|Infinity/);
		expect(polarGeometry(samples).negative).toMatch(/^M/);
	});

	it('plots neutral at its Q23 linear gain with zero imaginary component', () => {
		const samples = polarResponse(NEUTRO, 3);
		const gain = 10 ** (quantizedPreampDb(NEUTRO.preampDb) / 20);
		for (const sample of samples) {
			expect(sample.real).toBeCloseTo(gain, 12);
			expect(sample.imaginary).toBe(0);
		}
		expect(() => polarResponse(NEUTRO, 1)).toThrow(RangeError);
	});
});

describe('data-only diagnostic traces', () => {
	it('computes errors through the core response and covers the whole heat-map width', () => {
		const grid = [20, 1000, 20000];
		const errors = curveErrors(NEUTRO, [-1, 0, 1], grid);
		expect(errors).toEqual([0.5, -0.5, -1.5]);
		const cells = errorHeatGeometry([errors], grid, 720);
		expect(cells.reduce((sum, cell) => sum + cell.width, 0)).toBeCloseTo(720, 10);
		expect(cells[0].x).toBe(0);
		expect(cells.at(-1)?.intensity).toBe(0.25);
		expect(() => curveErrors(NEUTRO, [], grid)).toThrow(RangeError);
		expect(() => errorHeatGeometry([[1]], grid)).toThrow(RangeError);
	});

	it('maps a real signed trace around its baseline without decorative samples', () => {
		expect(wiggleGeometry([-1, 0, 1], 100, 100).path).toBe(
			'M0.000,98.000L50.000,50.000L100.000,2.000'
		);
		expect(wiggleGeometry([]).path).toBe('');
		expect(() => wiggleGeometry([], 720, 100, 0)).toThrow(RangeError);
	});
});
