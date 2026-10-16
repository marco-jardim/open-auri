import { afterEach, describe, expect, it } from 'vitest';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { WRITTEN_STORAGE_KEY, createCurveStore } from '../../../src/lib/state/curve.svelte.ts';
import { createStorage } from '../../../src/lib/state/index.ts';
import { createTabs, MemoryStorage } from './fakes.ts';

const disposables: { dispose(): void }[] = [];
function own<T extends { dispose(): void }>(value: T): T {
	disposables.push(value);
	return value;
}
afterEach(() => {
	for (const disposable of disposables.reverse()) disposable.dispose();
	disposables.length = 0;
});

function adapter(local = new MemoryStorage()) {
	const session = new MemoryStorage();
	return own(createStorage({ local, session, indexedDB: null, channel: null }));
}

describe('FX2.3/E1 unsaved indicator and persisted written snapshot', () => {
	it('uses the oa.curve.written key', () => {
		expect(WRITTEN_STORAGE_KEY).toBe('oa.curve.written');
	});

	it('shows nothing on a fresh profile until the user edits, while dirty stays conservative', () => {
		const store = own(createCurveStore({ storage: adapter() }));
		expect(store.lastWritten).toBeNull();
		expect(store.dirty).toBe(true);
		expect(store.unsaved).toBe(false);
		// A no-op set (same DSP and metadata) is not an edit.
		expect(store.set(store.current)).toBe(true);
		expect(store.unsaved).toBe(false);
		store.loadPreset(PADRAO_AURI.id);
		expect(store.unsaved).toBe(true);
	});

	it('persists the written snapshot so a reload after a write is clean', () => {
		const local = new MemoryStorage();
		const first = own(createCurveStore({ storage: adapter(local) }));
		first.loadPreset(PADRAO_AURI.id);
		expect(first.markWritten(first.current)).toBe(true);
		expect(first.unsaved).toBe(false);
		expect(JSON.parse(local.getItem(WRITTEN_STORAGE_KEY) ?? 'null')).toEqual(first.current);

		const reloaded = own(createCurveStore({ storage: adapter(local) }));
		expect(reloaded.lastWritten?.bands).toEqual(PADRAO_AURI.bands);
		expect(reloaded.dirty).toBe(false);
		expect(reloaded.unsaved).toBe(false);
		// With a known write, any DSP difference is unsaved even without edits this session.
		const updatedAt = reloaded.current.updatedAt + 1;
		local.setItem('oa.current', JSON.stringify({ ...reloaded.current, preampDb: -3, updatedAt }));
		const diverged = own(createCurveStore({ storage: adapter(local) }));
		expect(diverged.dirty).toBe(true);
		expect(diverged.unsaved).toBe(true);
	});

	it.each(['{', 'null', '[]', '42', '"broken"', JSON.stringify({ schema: 1, bands: [] })])(
		'drops a corrupt written snapshot defensively: %s',
		(raw) => {
			const local = new MemoryStorage();
			local.setItem(WRITTEN_STORAGE_KEY, raw);
			const store = own(createCurveStore({ storage: adapter(local) }));
			expect(store.lastWritten).toBeNull();
			expect(store.dirty).toBe(true);
			expect(store.unsaved).toBe(false);
			expect(store.current.bands).toEqual(NEUTRO.bands);
			if (raw !== 'null') expect(store.error?.kind).toBe('invalid');
		}
	);

	it('rejects an invalid snapshot without persisting it', () => {
		const local = new MemoryStorage();
		const store = own(createCurveStore({ storage: adapter(local) }));
		expect(store.markWritten({ ...store.current, preampDb: Number.NaN })).toBe(false);
		expect(local.getItem(WRITTEN_STORAGE_KEY)).toBeNull();
		expect(store.lastWritten).toBeNull();
	});

	it('keeps the written snapshot in memory when storage fails', () => {
		const local = new MemoryStorage();
		const store = own(createCurveStore({ storage: adapter(local) }));
		local.failure = new Error('quota');
		expect(store.markWritten(store.current)).toBe(true);
		expect(store.dirty).toBe(false);
		expect(store.error?.kind).toBe('unavailable');
	});

	it('follows another tab writing to the cable', () => {
		const tabs = createTabs();
		const writer = own(createCurveStore({ storage: own(createStorage(tabs.options(0))) }));
		const reader = own(createCurveStore({ storage: own(createStorage(tabs.options(1))) }));
		expect(reader.lastWritten).toBeNull();
		writer.markWritten(writer.current);
		tabs.deliver();
		expect(reader.lastWritten?.bands).toEqual(writer.current.bands);
		expect(reader.dirty).toBe(false);
		tabs.local.removeItem(WRITTEN_STORAGE_KEY);
		tabs.emit(1, { area: 'local', key: WRITTEN_STORAGE_KEY, newValue: null });
		expect(reader.lastWritten).toBeNull();
	});
});
