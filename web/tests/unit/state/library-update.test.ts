// LIBEDIT: local library descriptions and `update(id, { name, description })` (S5 text rules).
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import { createLibraryStore, createStorage } from '../../../src/lib/state/index.ts';
import type { ClientStorage, CurveData } from '../../../src/lib/state/index.ts';
import {
	LibraryUpdateError,
	type LibraryTextIssue
} from '../../../src/lib/state/library.svelte.ts';
import { MemoryStorage } from './fakes.ts';

const disposables: { dispose(): void }[] = [];
function own<T extends { dispose(): void }>(value: T): T {
	disposables.push(value);
	return value;
}
afterEach(() => {
	for (const disposable of disposables.reverse()) disposable.dispose();
	disposables.length = 0;
	vi.restoreAllMocks();
});

function adapter(indexedDB: IDBFactory | null = new IDBFactory()) {
	return own(
		createStorage({
			local: new MemoryStorage(),
			session: new MemoryStorage(),
			indexedDB,
			channel: null
		})
	);
}
function curve(name = 'Neutro'): CurveData {
	return { name, source: 'custom', preampDb: NEUTRO.preampDb, bands: NEUTRO.bands };
}
async function seed(storage: ClientStorage, values: Record<string, unknown>[]) {
	await storage.updateRecords('library', () => ({ put: values }));
}
/** The update's rejection, asserted to be a typed LibraryUpdateError. */
async function refusal(promise: Promise<unknown>): Promise<LibraryUpdateError> {
	const error = await promise.then(
		() => null,
		(cause: unknown) => cause
	);
	if (!(error instanceof LibraryUpdateError)) throw new Error('Expected a LibraryUpdateError');
	return error;
}

describe('library item description', () => {
	it('loads legacy records without a description as an empty one, no migration', async () => {
		const storage = adapter();
		const legacy = {
			...curve('Antiga'),
			id: 'legacy',
			favorite: false,
			s1: encodeS1(curve()),
			createdAt: 1,
			updatedAt: 2
		};
		await seed(storage, [legacy]);
		const library = own(createLibraryStore({ storage }));
		await library.ready;
		expect(library.items).toHaveLength(1);
		expect(library.items[0]).toMatchObject({ id: 'legacy', name: 'Antiga', description: '' });
		expect(library.error).toBeNull();
		// The record on disk is untouched until the user edits it.
		const [stored] = await storage.loadRecords('library');
		expect(Object.hasOwn(stored, 'description')).toBe(false);
	});

	it('keeps a stored description and drops records whose description is not S5-sized text', async () => {
		const storage = adapter();
		const base = { favorite: false, s1: encodeS1(curve()), createdAt: 1, updatedAt: 2 };
		const padrao = {
			...curve('Padrão'),
			preampDb: PADRAO_AURI.preampDb,
			bands: PADRAO_AURI.bands,
			s1: encodeS1(PADRAO_AURI)
		};
		await seed(storage, [
			{ ...curve('Com texto'), ...base, id: 'kept', description: 'Duas\nlinhas' },
			{ ...curve('Número'), ...base, id: 'number', description: 3, updatedAt: 3 },
			{ ...padrao, ...base, s1: padrao.s1, id: 'long', description: 'x'.repeat(281) }
		]);
		const library = own(createLibraryStore({ storage }));
		await library.ready;
		expect(library.items.map((item) => [item.id, item.description])).toEqual([
			['kept', 'Duas\nlinhas']
		]);
		expect(library.error?.kind).toBe('invalid');
	});

	it('counts the 280 limit in code points, not UTF-16 units', async () => {
		const storage = adapter();
		const description = '🎧'.repeat(280);
		expect(description.length).toBe(560);
		await seed(storage, [
			{
				...curve(),
				id: 'emoji',
				favorite: false,
				s1: encodeS1(curve()),
				createdAt: 1,
				updatedAt: 2,
				description
			}
		]);
		const library = own(createLibraryStore({ storage }));
		await library.ready;
		expect(library.items[0]?.description).toBe(description);
	});

	it('save keeps the existing description when it deduplicates, and still takes the new name', async () => {
		const library = own(createLibraryStore({ storage: adapter(), now: () => 1000 }));
		await library.ready;
		const first = await library.save(curve('Primeira'));
		if (!first) throw new Error('save failed');
		await library.update(first.id, { description: 'Minha nota.' });
		const reordered = { ...curve('Reordenada'), bands: [...NEUTRO.bands].reverse() };
		const second = await library.save(reordered);
		expect(second).toMatchObject({
			id: first.id,
			name: 'Reordenada',
			description: 'Minha nota.'
		});
		expect(library.items).toHaveLength(1);
		expect(library.items[0]).toMatchObject({ name: 'Reordenada', description: 'Minha nota.' });
		// A new curve starts with no description.
		const other = await library.save({ ...curve('Outra'), preampDb: -6 });
		expect(other?.description).toBe('');
	});
});

describe('library update', () => {
	it('persists the normalised name and description with a newer updatedAt', async () => {
		const indexedDB = new IDBFactory();
		let clock = 1000;
		const library = own(createLibraryStore({ storage: adapter(indexedDB), now: () => clock }));
		await library.ready;
		const saved = await library.save(curve('Antes'));
		if (!saved) throw new Error('save failed');
		clock = 5000;
		const updated = await library.update(saved.id, {
			name: '  Graves   de domingo ',
			description: '  Para ouvir   jazz.  \n  Sem pressa. '
		});
		expect(updated).toMatchObject({
			id: saved.id,
			name: 'Graves de domingo',
			description: 'Para ouvir jazz.\nSem pressa.',
			s1: saved.s1,
			bands: saved.bands,
			preampDb: saved.preampDb,
			favorite: saved.favorite,
			createdAt: saved.createdAt,
			updatedAt: 5000
		});
		expect(library.items).toEqual([updated]);
		// Another store on the same database reads the edit back.
		const reader = own(createLibraryStore({ storage: adapter(indexedDB) }));
		await reader.ready;
		expect(reader.items[0]).toMatchObject({
			name: 'Graves de domingo',
			description: 'Para ouvir jazz.\nSem pressa.',
			updatedAt: 5000
		});
		// Each field is optional; the other keeps its value.
		const renamed = await library.update(saved.id, { name: 'Só o nome' });
		expect(renamed).toMatchObject({
			name: 'Só o nome',
			description: 'Para ouvir jazz.\nSem pressa.'
		});
		expect(renamed.updatedAt).toBeGreaterThan(5000);
		const cleared = await library.update(saved.id, { description: '' });
		expect(cleared).toMatchObject({ name: 'Só o nome', description: '' });
	});

	it('an unchanged text writes nothing and keeps updatedAt', async () => {
		let clock = 1000;
		const library = own(createLibraryStore({ storage: adapter(), now: () => clock }));
		await library.ready;
		const saved = await library.save(curve('Igual'));
		if (!saved) throw new Error('save failed');
		clock = 9000;
		expect(await library.update(saved.id, { name: ' Igual ', description: '' })).toMatchObject({
			name: 'Igual',
			updatedAt: saved.updatedAt
		});
		expect(await library.update(saved.id, {})).toMatchObject({ updatedAt: saved.updatedAt });
	});

	it.each<[string, { name?: string; description?: string }, LibraryTextIssue[]]>([
		['an empty name', { name: '   ' }, [{ field: 'name', code: 'env:length' }]],
		['a 49 code point name', { name: 'n'.repeat(49) }, [{ field: 'name', code: 'env:length' }]],
		['a link in the name', { name: 'Veja www.exemplo.com' }, [{ field: 'name', code: 'env:url' }]],
		['a scheme in the name', { name: 'https://x.test' }, [{ field: 'name', code: 'env:url' }]],
		['a tab in the name', { name: 'Com\ttab' }, [{ field: 'name', code: 'env:pattern' }]],
		[
			'a 281 code point description',
			{ description: 'd'.repeat(281) },
			[{ field: 'description', code: 'env:length' }]
		],
		[
			'six description lines',
			{ description: '1\n2\n3\n4\n5\n6' },
			[{ field: 'description', code: 'env:length' }]
		],
		[
			'a domain in the description',
			{ description: 'Ouça em exemplo.com hoje' },
			[{ field: 'description', code: 'env:url' }]
		],
		[
			'a missing sentence space',
			{ description: 'Grave.Agudo' },
			[{ field: 'description', code: 'env:url-like' }]
		],
		[
			'both fields at once',
			{ name: '', description: 'www.exemplo.com' },
			[
				{ field: 'name', code: 'env:length' },
				{ field: 'description', code: 'env:url' }
			]
		]
	])('rejects %s with typed issues and writes nothing', async (_, patch, issues) => {
		let clock = 1000;
		const library = own(createLibraryStore({ storage: adapter(), now: () => clock }));
		await library.ready;
		const saved = await library.save(curve('Original'));
		if (!saved) throw new Error('save failed');
		clock = 9000;
		const error = await refusal(library.update(saved.id, patch));
		expect(error.code).toBe('invalid-text');
		expect(error.issues).toEqual(issues);
		expect(library.items).toEqual([saved]);
		// Refused text is the user's input, not a storage failure.
		expect(library.error).toBeNull();
	});

	it('accepts the S5 bounds exactly: 48 code point name, 280 code points over five lines', async () => {
		const library = own(createLibraryStore({ storage: adapter() }));
		await library.ready;
		const saved = await library.save(curve());
		if (!saved) throw new Error('save failed');
		const name = 'ç'.repeat(47) + '🎧';
		// Five lines of 55 code points, four line breaks and one more character: 280.
		const description = ['a', 'b', 'c', 'd', 'e']
			.map((letter, index) => letter.repeat(index === 4 ? 56 : 55))
			.join('\n');
		expect([...description].length).toBe(280);
		const updated = await library.update(saved.id, { name, description });
		expect(updated).toMatchObject({ name, description });
	});

	it('rejects an unknown id as not-found, and the queue keeps working afterwards', async () => {
		const library = own(createLibraryStore({ storage: adapter() }));
		await library.ready;
		const error = await refusal(library.update('missing', { name: 'Nada' }));
		expect(error.code).toBe('not-found');
		expect(error.issues).toEqual([]);
		const saved = await library.save(curve('Depois'));
		expect(saved?.name).toBe('Depois');
		if (!saved) throw new Error('save failed');
		expect((await library.update(saved.id, { name: 'Renomeada' })).name).toBe('Renomeada');
		await library.remove(saved.id);
		expect((await refusal(library.update(saved.id, { name: 'Removida' }))).code).toBe('not-found');
	});

	it('keeps the edit in memory when IndexedDB is unavailable', async () => {
		const library = own(createLibraryStore({ storage: adapter(null) }));
		await library.ready;
		const saved = await library.save(curve('Memória'));
		if (!saved) throw new Error('save failed');
		const updated = await library.update(saved.id, { name: 'Ainda aqui', description: 'Nota' });
		expect(updated).toMatchObject({ name: 'Ainda aqui', description: 'Nota' });
		expect((await library.list())[0]).toMatchObject({ name: 'Ainda aqui', description: 'Nota' });
	});

	it('setFavorite keeps the description', async () => {
		const library = own(createLibraryStore({ storage: adapter() }));
		await library.ready;
		const saved = await library.save(curve('Favorita'));
		if (!saved) throw new Error('save failed');
		await library.update(saved.id, { description: 'Fica.' });
		await library.setFavorite(saved.id, true);
		expect(library.items[0]).toMatchObject({ favorite: true, description: 'Fica.' });
	});
});
