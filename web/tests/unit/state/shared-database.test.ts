import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { NEUTRO } from 'open-auri/catalog';
import { createAudioEngine } from '../../../src/lib/audio/engine.ts';
import { createLibraryStore, createStorage } from '../../../src/lib/state/index.ts';
import { MemoryStorage } from './fakes.ts';

const disposables: { dispose(): void }[] = [];
function own<T extends { dispose(): void }>(value: T): T {
	disposables.push(value);
	return value;
}
afterEach(() => {
	for (const disposable of disposables.reverse()) disposable.dispose();
	disposables.length = 0;
});

function library(indexedDB: IDBFactory) {
	const storage = own(
		createStorage({
			local: new MemoryStorage(),
			session: new MemoryStorage(),
			indexedDB,
			channel: null
		})
	);
	return own(createLibraryStore({ storage, now: () => 1000 }));
}

describe('shared open-auri database', () => {
	// Regression: on a fresh profile the audio engine's boot `restore()` can create the database
	// before the state layer. It used to create `library`/`outbox` without `keyPath: 'id'`, so every
	// library `put` failed: the item stayed in memory only and the library error was shown.
	it('persists library saves when the audio engine created the database first', async () => {
		const indexedDB = new IDBFactory();
		const engine = createAudioEngine({ AudioContext: null, indexedDB, document: null });
		await engine.restore();

		const store = library(indexedDB);
		await store.ready;
		const saved = await store.save({
			name: 'Importado',
			source: 'import',
			preampDb: NEUTRO.preampDb,
			bands: NEUTRO.bands
		});
		expect(saved?.name).toBe('Importado');
		expect(store.error).toBeNull();

		const reloaded = library(indexedDB);
		await reloaded.ready;
		expect(reloaded.items.map((item) => item.id)).toEqual([saved?.id]);
		expect(reloaded.error).toBeNull();
	});
});
