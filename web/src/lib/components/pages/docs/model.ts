import { OFFICIAL_PRESETS } from 'open-auri/catalog';
import { crc16Ccitt, encodePayload, preampWord, reportsFromPayload } from 'open-auri/dsp';
import { SOFT_RANGES, THRESHOLDS } from 'open-auri/safety';
import type { DocsContent } from '#lib/content/docs/types.ts';

export const auriPreset = OFFICIAL_PRESETS.find((preset) => preset.id === 'padrao')!;
export const auriPayload = encodePayload(auriPreset.bands, auriPreset.preampDb);
export const hex = (bytes: Iterable<number>) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
export const tapeHex = hex(auriPayload);
export const reportHex = reportsFromPayload(auriPayload)
	.map((bytes, index) => `${index}: ${hex(bytes)}`)
	.join('\n');

/** Full JS decimal precision, localized without rounding the safety limits. */
export function exactNumber(value: number, locale: DocsContent['locale']) {
	return String(value)
		.replace('-', '−')
		.replace('.', locale === 'pt-BR' ? ',' : '.');
}

export function thresholdRows(content: DocsContent) {
	const t = THRESHOLDS;
	const number = (value: number) => exactNumber(value, content.locale);
	return [
		...t.coefficientPositions.map((position, index) => ({
			id: `coefficient-${index}`,
			label: `|${position.replace('-', '−')}|`,
			value: `${number(t.coefficientAbs[index])} · ${t.coefficientAbsWords[index]} LSB`
		})),
		...[t.poleRadius, t.sectionPeakDb, t.internalAudibleDb, t.outputAudibleDb, t.outputFullDb].map(
			(value, index) => ({
				id: ['poleRadius', 'sectionPeakDb', 'internalAudibleDb', 'outputAudibleDb', 'outputFullDb'][
					index
				],
				label: content.thresholdLabels[index],
				value: `≤ ${number(value)}${index === 0 ? '' : ' dB'}`
			})
		),
		{
			id: 'preamp',
			label: content.thresholdLabels[5],
			value: `${number(t.preampMinDb)} … ${number(t.preampMaxDb)} dB`
		},
		{ id: 'dbTolerance', label: content.thresholdLabels[6], value: number(t.dbNumericalTolerance) },
		{
			id: 'radiusTolerance',
			label: content.thresholdLabels[7],
			value: number(t.radiusNumericalTolerance)
		}
	];
}

export function softRangeRows(locale: DocsContent['locale']) {
	const range = (value: { min: number; max: number }) =>
		`${exactNumber(value.min, locale)}…${exactNumber(value.max, locale)}`;
	return Object.entries(SOFT_RANGES).map(([profile, values]) => ({
		profile,
		frequency: range(values.freqHz),
		gain: values.gainDb ? range(values.gainDb) : null,
		q: range(values.qFactor)
	}));
}

export function q23Example(input: string) {
	const normalized = input.trim().replace('−', '-').replace(',', '.');
	if (!normalized || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
	const db = Number(normalized);
	if (!Number.isFinite(db) || db > 0) return null;
	try {
		const word = preampWord(db);
		const bytes = new Uint8Array(4);
		new DataView(bytes.buffer).setInt32(0, word, true);
		return { word, bytes: hex(bytes) };
	} catch (cause) {
		if (cause instanceof Error) return null;
		throw cause;
	}
}

export function crcExample(text: string) {
	const crc = crc16Ccitt(new TextEncoder().encode(text));
	return {
		value: `0x${crc.toString(16).padStart(4, '0').toUpperCase()}`,
		bytes: hex([crc & 255, crc >>> 8])
	};
}
