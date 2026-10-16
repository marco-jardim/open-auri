import { encodePayload, quantizedPreampDb, SAMPLE_RATE, sectionDb } from 'open-auri/dsp';
import { sectionAnalysis } from 'open-auri/safety';
import type { Curve } from './response.ts';
import { linePath, type Point } from './scales.ts';

/** Roots are chart geometry; coefficient design/quantization stays in core. */
function roots(a: number, b: number, c: number): Point[] {
	if (a === 0) return b === 0 ? [] : [{ x: -c / b, y: 0 }];
	const discriminant = b * b - 4 * a * c;
	if (discriminant < 0) {
		const real = -b / (2 * a);
		const imaginary = Math.sqrt(-discriminant) / (2 * Math.abs(a));
		return [
			{ x: real, y: imaginary },
			{ x: real, y: -imaginary }
		];
	}
	const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
	return q === 0
		? [
				{ x: 0, y: 0 },
				{ x: 0, y: 0 }
			]
		: [
				{ x: q / a, y: 0 },
				{ x: c / q, y: 0 }
			];
}

export function poleZeroGeometry(bands: Curve['bands']) {
	return bands.map((band, index) => {
		const analysis = sectionAnalysis(band);
		const { b0, b1, b2, a1, a2 } = analysis.section;
		return {
			index,
			words: analysis.words,
			radius: analysis.poleRadius,
			poles: roots(1, a1, a2),
			zeros: roots(b0, b1, b2)
		};
	});
}

export interface PolarSample {
	freqHz: number;
	real: number;
	imaginary: number;
}

/**
 * Phase is not exposed by core. Only phase projection is implemented here;
 * magnitude, quantized coefficients and preamp are always obtained from core.
 * No stability verdict is inferred from this open-loop response diagram.
 */
export function polarResponse(curve: Curve, count = 721): PolarSample[] {
	if (!Number.isInteger(count) || count < 2) throw new RangeError('Invalid polar sample count');
	encodePayload(curve.bands, curve.preampDb);
	const sections = curve.bands.map((band) => sectionAnalysis(band).section);
	const preamp = quantizedPreampDb(curve.preampDb);
	return Array.from({ length: count }, (_, i) => {
		const freqHz =
			i === 0
				? 0
				: i === count - 1
					? SAMPLE_RATE / 2
					: (SAMPLE_RATE / 2) ** ((i - 1) / (count - 2));
		const w = (2 * Math.PI * freqHz) / SAMPLE_RATE;
		const phaseOf = (a: number, b: number, c: number) =>
			Math.atan2(-b * Math.sin(w) - c * Math.sin(2 * w), a + b * Math.cos(w) + c * Math.cos(2 * w));
		const phase = sections.reduce(
			(sum, s) => sum + phaseOf(s.b0, s.b1, s.b2) - phaseOf(1, s.a1, s.a2),
			0
		);
		const db = sections.reduce((sum, section) => sum + sectionDb(section, freqHz), preamp);
		const magnitude = 10 ** (db / 20);
		return { freqHz, real: magnitude * Math.cos(phase), imaginary: magnitude * Math.sin(phase) };
	});
}

export function polarGeometry(
	samples: readonly PolarSample[],
	center: Point = { x: 240, y: 160 },
	radius = 110
) {
	const extent = Math.max(1.15, ...samples.map((p) => Math.hypot(p.real, p.imaginary) * 1.1));
	const scale = radius / extent;
	const project = (conjugate: boolean) =>
		linePath(
			samples.map((p) => ({
				x: center.x + p.real * scale,
				y: center.y - p.imaginary * scale * (conjugate ? -1 : 1)
			}))
		);
	return { positive: project(false), negative: project(true), scale, extent };
}
