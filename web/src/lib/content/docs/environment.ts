import type { DocsContent } from './types.ts';

/** Project before rendering AND indexing search. All anchors survive in both environments. */
export function docsForEnvironment(content: DocsContent, inApp: boolean): DocsContent {
	return {
		...content,
		sections: content.sections.map(({ browserOnly, appOnly, ...section }) => {
			const extra = inApp ? appOnly : browserOnly;
			if (!extra) return section;
			const links = [...(section.links ?? []), ...(extra.links ?? [])];
			return {
				...section,
				paragraphs: [...section.paragraphs, ...(extra.paragraphs ?? [])],
				// Keep `links` absent when empty: the page renders a links row for any array.
				...(links.length > 0 ? { links } : {})
			};
		})
	};
}
