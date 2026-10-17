// Where a curve came from in the community. Pages that open a published curve (Comunidade,
// /c/[id], Biblioteca, profiles) remember its lineage under the curve id (content address of the
// S1); the activity bridges (previewed in Curva, installed after a real cable write) look the
// current S1 up here, so an event is only attributed when the exact published bytes are in use.
//
// Per account (FX4.10): a signed-in account's origins live under
// `oa.social.origins:<accountId>` (they may hold its private lineage ids, e.g. from Minha
// Biblioteca); the plain `oa.social.origins` key is the anonymous one (public/unlisted curves
// opened while signed out, or before the session is known). The actor is the one bound by `setOriginsActor` (SocialSync binds the signed-in
// account of the tab) unless `options.actor` says otherwise. `purgeOrigins(keep)` removes every
// other account's key and the anonymous key; SocialSync calls it with the outbox purge (on the
// first signed-in account seen, on a switch and on a definitive sign-out), so another account's
// private lineage ids are never kept nor read.
import { curveId } from 'open-auri/share';

/** Anonymous key; signed-in accounts use `${ORIGINS_KEY}:<accountId>` (`originsKey`). */
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

/** What `purgeOrigins` needs on top of reads and writes (`localStorage` has it all). */
export interface PurgeableOriginsStorage extends OriginsStorage {
	removeItem(key: string): void;
	key(index: number): string | null;
	readonly length: number;
}

export interface OriginsOptions {
	storage?: OriginsStorage | null;
	now?: () => number;
	/** Whose origins: an account id, or null for the anonymous key. Default: `setOriginsActor`. */
	actor?: string | null;
}

type OriginMap = Record<string, CurveOrigin>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Account bound by `setOriginsActor`; null = anonymous (also before any session is known). */
let boundActor: string | null = null;

/**
 * Binds the account whose origins `rememberOrigin` and `originOf` use by default (null =
 * anonymous). SocialSync calls it whenever the tab's signed-in account changes.
 */
export function setOriginsActor(actor: string | null): void {
	boundActor = actor !== null && actor !== '' ? actor : null;
}

/** Storage key of `actor`'s origins (the plain key for anonymous). */
export function originsKey(actor: string | null): string {
	return actor === null || actor === '' ? ORIGINS_KEY : `${ORIGINS_KEY}:${actor}`;
}

function defaultStorage(): PurgeableOriginsStorage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch (error) {
		console.warn(JSON.stringify({ event: 'social.origins.storage', error: (error as Error).name }));
		return null;
	}
}

function keyFor(options: OriginsOptions): string {
	return originsKey(options.actor === undefined ? boundActor : options.actor);
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

function read(storage: OriginsStorage, key: string): OriginMap {
	let parsed: unknown;
	try {
		parsed = JSON.parse(storage.getItem(key) ?? '{}');
	} catch {
		return {};
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
	const out: OriginMap = {};
	for (const [id, value] of Object.entries(parsed)) {
		if (ID.test(id) && isOrigin(value)) {
			out[id] = { lineageId: value.lineageId, versionId: value.versionId, at: value.at };
		}
	}
	return out;
}

function write(storage: OriginsStorage, key: string, map: OriginMap): void {
	const kept = Object.entries(map)
		.sort(([, a], [, b]) => b.at - a.at)
		.slice(0, ORIGINS_MAX);
	try {
		storage.setItem(key, JSON.stringify(Object.fromEntries(kept)));
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
	// Resolved after the hash, so a call made while the tab's session was still being bound lands
	// under the account bound meanwhile.
	const key = keyFor(options);
	const map = read(storage, key);
	map[id] = {
		lineageId: input.lineageId,
		versionId: input.versionId,
		at: (options.now ?? Date.now)()
	};
	write(storage, key, map);
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
	return read(storage, keyFor(options))[id] ?? null;
}

/**
 * Removes the origins of every account but `keep`, and the anonymous key (its entries may have
 * been written by whoever was signed in before the session was known). `keep = null` (definitive
 * sign-out) removes them all. Returns the number of keys removed; never throws.
 */
export function purgeOrigins(
	keep: string | null,
	options: { storage?: PurgeableOriginsStorage | null } = {}
): number {
	const storage = options.storage === undefined ? defaultStorage() : options.storage;
	if (!storage) return 0;
	const kept = keep === null ? null : originsKey(keep);
	const prefix = `${ORIGINS_KEY}:`;
	let removed = 0;
	try {
		const doomed: string[] = [];
		for (let index = 0; index < storage.length; index += 1) {
			const key = storage.key(index);
			if (key === null || key === kept) continue;
			if (key === ORIGINS_KEY || key.startsWith(prefix)) doomed.push(key);
		}
		for (const key of doomed) {
			storage.removeItem(key);
			removed += 1;
		}
	} catch (error) {
		console.warn(JSON.stringify({ event: 'social.origins.purge', error: (error as Error).name }));
	}
	return removed;
}
