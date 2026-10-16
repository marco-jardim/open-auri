import { describe, expect, it } from 'vitest';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { curveId, encodeS1 } from 'open-auri/share';
import {
	ORIGINS_KEY,
	ORIGINS_MAX,
	originOf,
	rememberOrigin,
	type OriginsStorage
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
