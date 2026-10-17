import type { DocsContent } from '#lib/content/docs/types.ts';
import { creditSources } from '#lib/content/docs/credits.ts';
import { OFFICIAL_PRESETS } from 'open-auri/catalog';
import { softRangeRows, thresholdRows } from './model.ts';
import { glossaryEntries } from './glossary-entries.ts';

const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function buildSearchIndex(content: DocsContent) {
	return content.sections.map((section) => {
		const additions = {
			glossario: [
				...glossaryEntries().flatMap((entry) => [entry.title, entry.body]),
				...content.glossary.flat()
			].join(' '),
			envelope: [
				content.safetyCaveat,
				...thresholdRows(content).map((row) => `${row.label} ${row.value}`),
				...softRangeRows(content.locale).map((row) => Object.values(row).join(' '))
			].join(' '),
			memoria: content.flashNotice,
			creditos: creditSources.map((credit) => credit.label).join(' '),
			'pagina-oficial': OFFICIAL_PRESETS.map(
				(preset) => `${preset.label} ${preset.description}`
			).join(' ')
		};
		const extra = Object.hasOwn(additions, section.id)
			? additions[section.id as keyof typeof additions]
			: '';
		const text = [
			...section.paragraphs,
			...(section.items ?? []),
			...(section.links ?? []).map((link) => link.label),
			extra
		].join(' ');
		return {
			id: section.id,
			title: section.title,
			text,
			normalized: normalize(`${section.title} ${text}`)
		};
	});
}

export function searchSections(index: ReturnType<typeof buildSearchIndex>, query: string) {
	const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
	return index.filter((entry) => tokens.every((token) => entry.normalized.includes(token)));
}

export function isSearchShortcut(
	event: Pick<
		KeyboardEvent,
		'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'isComposing' | 'defaultPrevented'
	>
) {
	return (
		!event.defaultPrevented &&
		!event.repeat &&
		!event.isComposing &&
		!event.altKey &&
		(event.ctrlKey || event.metaKey) &&
		event.key.toLowerCase() === 'k'
	);
}

/** Last heading above the sticky chrome, with an explicit document-end rule. */
export function activeSection(
	positions: readonly { id: string; top: number }[],
	offset: number,
	atEnd = false
) {
	if (atEnd) return positions.at(-1)?.id ?? '';
	let active = positions[0]?.id ?? '';
	for (const position of positions) {
		if (position.top > offset + 1) break;
		active = position.id;
	}
	return active;
}
