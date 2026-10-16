// Where a curve came from in the community. Pages that open a published curve (Comunidade,
// /c/[id], Biblioteca, profiles) remember its lineage under the curve id (content address of the
// S1); the activity bridges (previewed in Curva, installed after a real cable write) look the
// current S1 up here, so an event is only attributed when the exact published bytes are in use.
import { curveId } from 'open-auri/share';

export const ORIGINS_KEY = 'oa.social.origins';
export const ORIGINS_MAX = 300;

export interface CurveOrigin {
	lineageId: string;
	versionId: string;
	at: number;
}

export interface OriginsStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export interface OriginsOptions {
	storage?: OriginsStorage | null;
	now?: () => number;
}

type OriginMap = Record<string, CurveOrigin>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function defaultStorage(): OriginsStorage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch (error) {
		console.warn(JSON.stringify({ event: 'social.origins.storage', error: (error as Error).name }));
		return null;
	}
}

function isOrigin(value: unknown): value is CurveOrigin {
	if (typeof value !== 'object' || value === null) return false;
	const { lineageId, versionId, at } = value as Record<string, unknown>;
	return (
		typeof lineageId === 'string' &&
		ID.test(lineageId) &&
		typeof versionId === 'string' &&
		ID.test(versionId) &&
		typeof at === 'number' &&
		Number.isFinite(at)
	);
}

function read(storage: OriginsStorage): OriginMap {
	let parsed: unknown;
	try {
		parsed = JSON.parse(storage.getItem(ORIGINS_KEY) ?? '{}');
	} catch {
		return {};
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
	const out: OriginMap = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (ID.test(key) && isOrigin(value)) {
			out[key] = { lineageId: value.lineageId, versionId: value.versionId, at: value.at };
		}
	}
	return out;
}

function write(storage: OriginsStorage, map: OriginMap): void {
	const kept = Object.entries(map)
		.sort(([, a], [, b]) => b.at - a.at)
		.slice(0, ORIGINS_MAX);
	try {
		storage.setItem(ORIGINS_KEY, JSON.stringify(Object.fromEntries(kept)));
	} catch (error) {
		console.warn(JSON.stringify({ event: 'social.origins.write', error: (error as Error).name }));
	}
}

async function idOf(s1: string): Promise<string | null> {
	try {
		return await curveId(s1);
	} catch {
		return null;
	}
}

/** Remembers that `s1` is the published version `versionId` of `lineageId`. Never throws. */
export async function rememberOrigin(
	input: { s1: string; lineageId: string; versionId: string },
	options: OriginsOptions = {}
): Promise<void> {
	const storage = options.storage === undefined ? defaultStorage() : options.storage;
	if (!storage || !ID.test(input.lineageId) || !ID.test(input.versionId)) return;
	const id = await idOf(input.s1);
	if (id === null) return;
	const map = read(storage);
	map[id] = {
		lineageId: input.lineageId,
		versionId: input.versionId,
		at: (options.now ?? Date.now)()
	};
	write(storage, map);
}

/** The published lineage whose exact bytes are `s1`, or null. Never throws. */
export async function originOf(
	s1: string,
	options: OriginsOptions = {}
): Promise<CurveOrigin | null> {
	const storage = options.storage === undefined ? defaultStorage() : options.storage;
	if (!storage) return null;
	const id = await idOf(s1);
	if (id === null) return null;
	return read(storage)[id] ?? null;
}
