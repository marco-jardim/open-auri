import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { curveId, encodeS1 } from 'open-auri/share';
import {
	ORIGINS_KEY,
	ORIGINS_MAX,
	originOf,
	originsKey,
	purgeOrigins,
	rememberOrigin,
	setOriginsActor,
	type OriginsStorage,
	type PurgeableOriginsStorage
} from '#lib/social/origins.ts';

function memory(): OriginsStorage & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value)
	};
}

const neutro = encodeS1({ bands: NEUTRO.bands, preampDb: NEUTRO.preampDb });
const padrao = encodeS1({ bands: PADRAO_AURI.bands, preampDb: PADRAO_AURI.preampDb });

describe('curve origins', () => {
	it('remembers a published curve by its exact bytes', async () => {
		const storage = memory();
		await rememberOrigin({ s1: neutro, lineageId: 'lin_a', versionId: 'ver_a' }, { storage });
		expect(await originOf(neutro, { storage })).toMatchObject({
			lineageId: 'lin_a',
			versionId: 'ver_a'
		});
		expect(await originOf(padrao, { storage })).toBeNull();
		const stored = JSON.parse(storage.map.get(ORIGINS_KEY) ?? '{}') as Record<string, unknown>;
		expect(Object.keys(stored)).toEqual([await curveId(neutro)]);
	});

	it('ignores invalid ids, undecodable S1 and corrupt storage', async () => {
		const storage = memory();
		await rememberOrigin({ s1: neutro, lineageId: 'bad id', versionId: 'v' }, { storage });
		await rememberOrigin({ s1: 'not-an-s1', lineageId: 'l', versionId: 'v' }, { storage });
		expect(storage.map.size).toBe(0);
		expect(await originOf('not-an-s1', { storage })).toBeNull();
		storage.map.set(ORIGINS_KEY, '{oops');
		expect(await originOf(neutro, { storage })).toBeNull();
		storage.map.set(ORIGINS_KEY, JSON.stringify({ [await curveId(neutro)]: { lineageId: 1 } }));
		expect(await originOf(neutro, { storage })).toBeNull();
	});

	it('works without storage and keeps only the most recent entries', async () => {
		expect(await originOf(neutro, { storage: null })).toBeNull();
		await rememberOrigin({ s1: neutro, lineageId: 'l', versionId: 'v' }, { storage: null });
		const storage = memory();
		const id = await curveId(padrao);
		const filler = Object.fromEntries(
			Array.from({ length: ORIGINS_MAX }, (_, i) => [
				`c${i}`,
				{ lineageId: `l${i}`, versionId: `v${i}`, at: 1000 + i }
			])
		);
		storage.map.set(ORIGINS_KEY, JSON.stringify(filler));
		await rememberOrigin(
			{ s1: padrao, lineageId: 'lin_new', versionId: 'ver_new' },
			{ storage, now: () => 10_000 }
		);
		const stored = JSON.parse(storage.map.get(ORIGINS_KEY) ?? '{}') as Record<string, unknown>;
		expect(Object.keys(stored)).toHaveLength(ORIGINS_MAX);
		expect(stored[id]).toBeDefined();
		expect(stored['c0']).toBeUndefined();
	});
});

function purgeable(): PurgeableOriginsStorage & { map: Map<string, string> } {
	const base = memory();
	return {
		...base,
		removeItem: (key) => void base.map.delete(key),
		key: (index) => [...base.map.keys()][index] ?? null,
		get length() {
			return base.map.size;
		}
	};
}

describe('curve origins per account (FX4.10)', () => {
	afterEach(() => {
		setOriginsActor(null);
	});

	it('keeps each account under its own key; anonymous uses the plain key', async () => {
		const storage = memory();
		expect(originsKey(null)).toBe(ORIGINS_KEY);
		expect(originsKey('user-a')).toBe(`${ORIGINS_KEY}:user-a`);

		await rememberOrigin({ s1: neutro, lineageId: 'lin_pub', versionId: 'v1' }, { storage });
		setOriginsActor('user-a');
		await rememberOrigin({ s1: padrao, lineageId: 'lin_priv', versionId: 'v1' }, { storage });
		expect(storage.map.get(originsKey('user-a'))).toContain('lin_priv');
		expect(storage.map.get(ORIGINS_KEY)).not.toContain('lin_priv');

		// The bound account reads only its own origins.
		expect((await originOf(padrao, { storage }))?.lineageId).toBe('lin_priv');
		expect(await originOf(neutro, { storage })).toBeNull();
		// Another account and anonymous never see them.
		expect(await originOf(padrao, { storage, actor: 'user-b' })).toBeNull();
		expect(await originOf(padrao, { storage, actor: null })).toBeNull();
		expect((await originOf(neutro, { storage, actor: null }))?.lineageId).toBe('lin_pub');

		setOriginsActor(null);
		expect(await originOf(padrao, { storage })).toBeNull();
	});

	it("purges every other account's origins and the anonymous key", () => {
		const storage = purgeable();
		storage.map.set(ORIGINS_KEY, '{}');
		storage.map.set(originsKey('user-a'), '{}');
		storage.map.set(originsKey('user-b'), '{}');
		storage.map.set('oa.other', 'x');

		expect(purgeOrigins('user-a', { storage })).toBe(2);
		expect([...storage.map.keys()].sort()).toEqual([originsKey('user-a'), 'oa.other'].sort());

		expect(purgeOrigins(null, { storage })).toBe(1);
		expect([...storage.map.keys()]).toEqual(['oa.other']);
		expect(purgeOrigins(null, { storage: null })).toBe(0);
	});

	it('logs a purge failure without throwing', () => {
		const storage = purgeable();
		storage.map.set(originsKey('user-b'), '{}');
		storage.removeItem = () => {
			throw new DOMException('denied', 'SecurityError');
		};
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(purgeOrigins('user-a', { storage })).toBe(0);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('social.origins.purge'));
		warn.mockRestore();
	});
});
