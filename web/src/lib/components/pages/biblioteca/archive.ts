import { OFFICIAL_PRESETS } from 'open-auri/catalog';
import { curveResponseDb, distance, logGrid, levelDb } from 'open-auri/dsp';
import { encodeS1, envelopeFormat, normalizeLabels, serializeEnvelope } from 'open-auri/share';
import type { CurveData } from '#lib/state/model.ts';
import type { LibraryItem } from '#lib/state/library.svelte.ts';
import type { gateForWrite } from 'open-auri/safety';
import { curveClassification, type CurveClassification } from '#lib/gate-verdicts.ts';
import type { CurveBadge } from '#lib/components/yolo/yolo-curve.ts';

export type GateResult = ReturnType<typeof gateForWrite>;
export const ANALYSIS_GRID = Object.freeze(logGrid(601));

export type Tag = 'bass' | 'bright' | 'dark' | 'lean' | 'flat';
export type Sort = 'official' | 'name' | 'pre' | 'distance';
export type Shelf = 'preferencia' | 'referencia' | 'local';
export type Locale = 'pt-BR' | 'en-US';
export interface Tape extends CurveData {
	id: string;
	group: Shelf;
	order: number;
	description: string;
	descriptionEn: string | null;
	favorite: boolean;
	createdAt: number | null;
	tags: readonly Tag[];
}

function mean(values: readonly number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Shape only: preamp deliberately excluded. Bands and response math belong to the core. */
export function automaticTags(curve: Pick<CurveData, 'bands'> & { preampDb?: number }): Tag[] {
	const response = curveResponseDb({ bands: curve.bands, preampDb: 0 }, ANALYSIS_GRID);
	const region = (low: number, high: number) =>
		mean(
			response.filter((_, index) => ANALYSIS_GRID[index] >= low && ANALYSIS_GRID[index] <= high)
		);
	const mid = region(300, 1000);
	const bass = region(20, 200) - mid;
	const treble = region(6000, 12000) - mid;
	const tags: Tag[] = [];
	if (bass >= 2) tags.push('bass');
	if (bass <= -2) tags.push('lean');
	if (treble >= 2) tags.push('bright');
	if (treble <= -2) tags.push('dark');
	return tags.length ? tags : ['flat'];
}

export function archiveTapes(local: readonly LibraryItem[]): Tape[] {
	return [
		...OFFICIAL_PRESETS.map((preset) => ({
			id: `official:${preset.id}`,
			name: preset.label,
			source: `preset:${preset.id}` as const,
			preampDb: preset.preampDb,
			bands: preset.bands,
			group: preset.group,
			order: preset.order,
			description: preset.description,
			descriptionEn: preset.descriptionEn,
			favorite: false,
			createdAt: null,
			tags: automaticTags(preset)
		})),
		...local.map((item, index) => ({
			...item,
			id: `local:${item.id}`,
			group: 'local' as const,
			order: index,
			// The user's own text (S5 rules, `library.update`): never translated, '' when unset.
			description: item.description ?? '',
			descriptionEn: null,
			tags: automaticTags(item)
		}))
	];
}

function fold(text: string): string {
	return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

export function selectTapes(
	tapes: readonly Tape[],
	options: {
		query: string;
		tag: Tag | 'all';
		sort: Sort;
		current: CurveData;
		locale: Locale;
		tagLabels: Record<Tag, string>;
	}
): Tape[] {
	const query = fold(options.query.trim());
	const ranked = tapes
		.filter((tape) => {
			const text = [
				tape.name,
				tape.id,
				tape.description,
				tape.descriptionEn ?? '',
				...tape.tags.flatMap((tag) => [tag, options.tagLabels[tag]])
			].join(' ');
			return (
				(!query || fold(text).includes(query)) &&
				(options.tag === 'all' || tape.tags.includes(options.tag))
			);
		})
		.map((tape) => ({
			tape,
			distance:
				options.sort === 'distance'
					? distance(tape, options.current, { levelMatch: false, grid: ANALYSIS_GRID }).rmsDb
					: 0
		}));
	const collator = new Intl.Collator(options.locale, { numeric: true, sensitivity: 'base' });
	return ranked
		.sort((a, b) => {
			let result = 0;
			switch (options.sort) {
				case 'name':
					result = collator.compare(a.tape.name, b.tape.name);
					break;
				case 'pre':
					result = a.tape.preampDb - b.tape.preampDb;
					break;
				case 'distance':
					result = a.distance - b.distance;
					break;
				case 'official':
					result = a.tape.order - b.tape.order;
			}
			return result || a.tape.order - b.tape.order || a.tape.id.localeCompare(b.tape.id);
		})
		.map(({ tape }) => tape);
}

export function dataReadings(curve: CurveData, current: CurveData, verdict: GateResult | null) {
	const level = levelDb(curve.bands, curve.preampDb);
	const comparison = distance(curve, current, { levelMatch: false, grid: ANALYSIS_GRID });
	return {
		levelDb: level,
		preampDb: curve.preampDb,
		peakDb: verdict?.metrics.outputAudible?.db ?? null,
		jumpDb: level - levelDb(current.bands, current.preampDb),
		rmsDb: comparison.rmsDb,
		maxDb: comparison.maxDb,
		maxFreqHz: comparison.maxFreqHz
	};
}

/** RMS difference in dB between a tape and the comparison reference (same grid as the sort). */
export function rmsTo(curve: CurveData, reference: CurveData): number {
	return distance(curve, reference, { levelMatch: false, grid: ANALYSIS_GRID }).rmsDb;
}

/** Visual correlation shown on the DATA console: max(−1, 1 − RMS / 6), calculated, never audio. */
export function correlationIndex(rmsDb: number): number {
	return Math.max(-1, Math.min(1, 1 - rmsDb / 6));
}

export function number(value: number | null | undefined, locale: Locale, digits = 1): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return '∅';
	return new Intl.NumberFormat(locale, {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	})
		.format(value)
		.replace(/-/g, '−');
}

/**
 * Badge of a tape, from its class (core `classifyCurve`, derived every time, never stored):
 * `yolo` for a YOLO curve, `warn` for one that passes neither profile today (a tape saved by an
 * older build), `none` for a standard one.
 */
export function tapeBadge(curve: Pick<CurveData, 'bands' | 'preampDb'>): CurveBadge {
	return classBadge(curveClassification(curve.bands, curve.preampDb));
}

/**
 * Badge of a class (`tapeBadge`); `none` while the class is not known yet (a shelf card waiting
 * for the background classifier, workers/classifier.svelte.ts `peek`).
 */
export function classBadge(classification: CurveClassification | null): CurveBadge {
	const kind = classification?.class ?? 'standard';
	return kind === 'yolo' ? 'yolo' : kind === 'rejected' ? 'warn' : 'none';
}

/**
 * No rights are invented for official presets. This is a view-only S5 draft until licensed.
 * Class-based like every exit: a rejected tape is view-only, a YOLO tape exports as it is (the
 * envelope carries no YOLO marker; `yolo` tells the caller to mark the file name).
 */
export function envelopeView(
	tape: Tape,
	locale: Locale,
	license: '' | 'CC0-1.0' | 'CC-BY-4.0' = '',
	author = ''
): { json: string; exportable: boolean; yolo: boolean } {
	const kind = curveClassification(tape.bands, tape.preampDb).class;
	const allowed =
		tape.group === 'local' &&
		!tape.source.startsWith('preset:') &&
		license !== '' &&
		kind !== 'rejected';
	if (allowed && license === 'CC-BY-4.0' && !author.trim()) {
		throw new TypeError('CC-BY requires attribution');
	}
	// Filter labels (or a band above 20 kHz) make the draft preset@2; otherwise the unchanged @1.
	const labels = normalizeLabels(tape.labels ?? null, { lenient: true });
	const envelope = {
		format: envelopeFormat({ bands: tape.bands, labels }),
		name: tape.name,
		description: tape.description,
		...(author ? { author } : {}),
		source: tape.source,
		license: allowed ? license : null,
		code: encodeS1(tape),
		preampDb: tape.preampDb,
		bands: tape.bands,
		...(labels ? { labels } : {}),
		lang: locale,
		createdAt: tape.createdAt === null ? null : new Date(tape.createdAt).toISOString()
	};
	const yolo = kind === 'yolo';
	return allowed
		? { json: serializeEnvelope(envelope), exportable: true, yolo }
		: { json: JSON.stringify(envelope, null, 2), exportable: false, yolo };
}

/** S9 contains all 11 official presets, in catalog order, with per-curve rights status. */
export function referencePack(): string {
	return JSON.stringify(
		{
			format: 'open-auri/pack@1',
			name: 'Pack de referência Auri',
			presets: OFFICIAL_PRESETS.map((preset) => ({
				id: preset.id,
				name: preset.label,
				source: 'https://equalizador.kuba.audio',
				license: null,
				licenseStatus: preset.licenseStatus,
				code: encodeS1(preset),
				preampDb: preset.preampDb,
				bands: preset.bands
			}))
		},
		null,
		2
	);
}
