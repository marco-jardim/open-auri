/** Stable opaque public author ids (not auth ids); curve targets are lineage ids. */
export const HIDDEN_LIMIT = 500;
export const HIDDEN_STORAGE_KEY = 'oa.hidden.v1';
export type HiddenType = 'author' | 'curve';
export interface HiddenTarget {
	targetType: HiddenType;
	targetId: string;
}
export interface HiddenLabels {
	authors: Record<string, string>;
	curves: Record<string, string>;
}
export interface HiddenList {
	authors: string[];
	curves: string[];
	/** Plain-text labels cached when hidden, including when the target is later removed. */
	labels?: HiddenLabels;
}

export function hiddenLabelText(value: string): string {
	return Array.from(value).filter((char) => {
		const code = char.codePointAt(0) ?? 0;
		return code >= 0x20 && code !== 0x7f;
	}).join('').trim().slice(0, 80);
}

export function hiddenLabel(list: HiddenList, type: HiddenType, id: string): string | null {
	const labels = list.labels?.[type === 'author' ? 'authors' : 'curves'];
	return labels && Object.hasOwn(labels, id) && typeof labels[id] === 'string' ? labels[id] : null;
}

/** Nickname fallback only for old cached cards and pre-FXP-B fixtures. */
export function authorHiddenId(author: { id?: string; username: string } | null | undefined): string | null {
	return author ? (author.id ?? author.username.toLowerCase()) : null;
}

export function hiddenId(type: HiddenType, value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const id = type === 'author' ? value.toLowerCase() : value;
	return (type === 'author' ? /^[a-z0-9._-]{1,64}$/ : /^[A-Za-z0-9_-]{1,64}$/).test(id)
		? id
		: null;
}

export function normalizeHidden(value: unknown): HiddenList & { labels: HiddenLabels } {
	const object = typeof value === 'object' && value !== null ? value : {};
	function ids(key: 'authors' | 'curves', type: HiddenType): string[] {
		const input: unknown = Reflect.get(object, key);
		if (!Array.isArray(input)) return [];
		return [...new Set(input.map((id: unknown) => hiddenId(type, id)).filter((id) => id !== null))]
			.slice(0, HIDDEN_LIMIT);
	}
	const authors = ids('authors', 'author');
	const curves = ids('curves', 'curve');
	const labels: HiddenLabels = { authors: {}, curves: {} };
	const rawLabels: unknown = Reflect.get(object, 'labels');
	if (typeof rawLabels === 'object' && rawLabels !== null) {
		for (const key of ['authors', 'curves'] as const) {
			const entries: unknown = Reflect.get(rawLabels, key);
			if (typeof entries !== 'object' || entries === null) continue;
			for (const id of key === 'authors' ? authors : curves) {
				const label: unknown = Object.hasOwn(entries, id) ? Reflect.get(entries, id) : undefined;
				if (typeof label === 'string' && label.trim()) {
					const text = hiddenLabelText(label);
					if (text) Object.defineProperty(labels[key], id, { value: text, enumerable: true });
				}
			}
		}
	}
	return { authors, curves, labels };
}

export function mergeHidden(left: HiddenList, right: HiddenList): HiddenList {
	return normalizeHidden({ authors: [...left.authors, ...right.authors], curves: [...left.curves, ...right.curves],
		labels: { authors: { ...left.labels?.authors, ...right.labels?.authors }, curves: { ...left.labels?.curves, ...right.labels?.curves } } });
}

export function isHidden(list: HiddenList, lineageId: string, author?: string | null): boolean {
	return list.curves.includes(lineageId) || (author != null && list.authors.includes(author.toLowerCase()));
}
