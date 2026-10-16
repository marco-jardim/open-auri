import { GRID } from 'open-auri/dsp';

export interface AutoEqEntry {
	id: string;
	name: string;
	brand: string;
	source: string;
	type: 'iem' | 'over-ear' | 'on-ear' | 'earbud' | 'target';
	pack: string;
	/** Byte offset, not an Int16 element index. */
	offset: number;
}

export interface AutoEqAttribution {
	name: string;
	measurements: number;
	attribution: string;
	link: string;
}

export interface AutoEqManifest {
	sha: string;
	commitDate: string | null;
	generatedAt: string;
	grid: { points: number; minHz: number; maxHz: number };
	counts: {
		measurements: number;
		targets: number;
		skipped: number;
		clampedValues: number;
		packs: number;
	};
	sources: AutoEqAttribution[];
	license: string;
	excluded: string[];
}

/** Accent/case folding is for search only. Source names and IDs retain their identity. */
function tokens(text: string): string[] {
	return (
		text
			.normalize('NFKD')
			.replace(/\p{M}/gu, '')
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? []
	);
}

/** At most one insertion, deletion or substitution, for forgiving longer query tokens. */
function oneEdit(a: string, b: string): boolean {
	if (Math.abs(a.length - b.length) > 1) return false;
	let i = 0;
	let j = 0;
	let edits = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			i++;
			j++;
			continue;
		}
		if (++edits > 1) return false;
		if (a.length >= b.length) i++;
		if (b.length >= a.length) j++;
	}
	return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}

function tokenScore(query: string, candidate: string): number {
	if (candidate === query) return 12;
	if (candidate.startsWith(query)) return 9;
	if (candidate.includes(query)) return 4;
	if (query.length >= 4 && oneEdit(query, candidate)) return 2;
	return 0;
}

/** All query tokens must match model, brand or source. Ties are deterministic by ID. */
export function searchEntries(
	entries: readonly AutoEqEntry[],
	query: string,
	limit = 50
): AutoEqEntry[] {
	const queryTokens = tokens(query);
	if (!Number.isInteger(limit) || limit < 0) throw new RangeError('Invalid search limit.');
	return entries
		.map((entry) => {
			const fields = [
				{ words: tokens(entry.name), weight: 3 },
				{ words: tokens(entry.brand), weight: 2 },
				{ words: tokens(entry.source), weight: 1 }
			];
			let score = 0;
			for (const token of queryTokens) {
				const best = Math.max(
					0,
					...fields.flatMap(({ words, weight }) =>
						words.map((word) => tokenScore(token, word) * weight)
					)
				);
				if (!best) return { entry, score: -1 };
				score += best;
			}
			return { entry, score };
		})
		.filter(({ score }) => score >= 0)
		.sort(
			(a, b) =>
				b.score - a.score || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0)
		)
		.slice(0, limit)
		.map(({ entry }) => entry);
}

/** An injectable client also keeps tests, SSR requests and alternative datasets isolated. */
export function createAutoEqClient({
	baseUrl = '/data/autoeq',
	fetchImpl = (input, init) => globalThis.fetch(input, init)
}: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
	const base = baseUrl.replace(/\/$/, '');
	let indexPromise: Promise<AutoEqEntry[]> | undefined;
	let manifestPromise: Promise<AutoEqManifest> | undefined;
	const packs = new Map<string, Promise<ArrayBuffer>>();

	async function request(file: string): Promise<Response> {
		const response = await fetchImpl(`${base}/${file}`);
		if (!response.ok) throw new Error(`AutoEq ${file}: HTTP ${response.status}`);
		return response;
	}

	function loadIndex(): Promise<AutoEqEntry[]> {
		indexPromise ??= request('index.json')
			.then((response) => response.json() as Promise<AutoEqEntry[]>)
			.catch((error) => {
				indexPromise = undefined;
				throw error;
			});
		return indexPromise;
	}

	function loadManifest(): Promise<AutoEqManifest> {
		manifestPromise ??= request('manifest.json')
			.then((response) => response.json() as Promise<AutoEqManifest>)
			.then((manifest) => {
				if (
					manifest.grid.points !== GRID.length ||
					manifest.grid.minHz !== GRID[0] ||
					manifest.grid.maxHz !== GRID[GRID.length - 1]
				)
					throw new Error('Unsupported AutoEq grid.');
				return manifest;
			})
			.catch((error) => {
				manifestPromise = undefined;
				throw error;
			});
		return manifestPromise;
	}

	async function search(query: string, limit = 50): Promise<AutoEqEntry[]> {
		return searchEntries(await loadIndex(), query, limit);
	}

	/** Packs are fetched only here, shared by concurrent requests, and retained in RAM.
	 * DataView makes little-endian decoding independent of the browser's architecture.
	 */
	async function loadEntry(
		entry: AutoEqEntry
	): Promise<{ frequencies: readonly number[]; values: number[] }> {
		if (
			!/^(?:measurements-[a-z0-9-]+|targets)-\d+\.bin$/.test(entry.pack) ||
			!Number.isSafeInteger(entry.offset) ||
			entry.offset < 0 ||
			entry.offset % (GRID.length * 2)
		) {
			throw new Error('Invalid AutoEq pack or byte offset.');
		}
		let pending = packs.get(entry.pack);
		if (!pending) {
			pending = request(entry.pack)
				.then((response) => response.arrayBuffer())
				.catch((error) => {
					packs.delete(entry.pack);
					throw error;
				});
			packs.set(entry.pack, pending);
		}
		const buffer = await pending;
		if (
			buffer.byteLength % (GRID.length * 2) ||
			entry.offset + GRID.length * 2 > buffer.byteLength
		) {
			packs.delete(entry.pack);
			throw new Error('Truncated AutoEq pack or out-of-bounds entry.');
		}
		const view = new DataView(buffer, entry.offset, GRID.length * 2);
		return {
			frequencies: GRID,
			values: GRID.map((_, index) => view.getInt16(index * 2, true) / 100)
		};
	}

	async function getAttribution(
		entry: AutoEqEntry | string
	): Promise<AutoEqAttribution | undefined> {
		const source = typeof entry === 'string' ? entry : entry.source;
		const manifest = await loadManifest();
		if (source === 'AutoEq targets') {
			return {
				name: source,
				measurements: 0,
				attribution: 'Alvos: AutoEq, Copyright (c) 2018-2022 Jaakko Pasanen, MIT.',
				link: `https://github.com/jaakkopasanen/AutoEq/tree/${manifest.sha}/targets`
			};
		}
		return manifest.sources.find((attribution) => attribution.name === source);
	}

	return { loadIndex, loadManifest, search, loadEntry, getAttribution };
}

const client = createAutoEqClient();
export const loadIndex = client.loadIndex;
export const loadManifest = client.loadManifest;
export const search = client.search;
export const loadEntry = client.loadEntry;
export const getAttribution = client.getAttribution;
