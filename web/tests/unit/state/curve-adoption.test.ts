/**
 * C1 (hearing safety): what the curve store adopts without a gated edit of its own. A curve
 * accepted only by the free preview's codec must never come back to the editor (another tab,
 * undo/redo, a reload); a YOLO-only curve only while Modo YOLO is on in this tab.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotBands } from 'open-auri/dsp';
import { gateForWrite, isExperimentalKind } from 'open-auri/safety';
import { NEUTRO } from 'open-auri/catalog';
import {
	CURRENT_STORAGE_KEY,
	createCurveStore,
	gateAccepts
} from '../../../src/lib/state/curve.svelte.ts';
import { createStorage } from '../../../src/lib/state/storage.ts';
import type { CurveData } from '../../../src/lib/state/model.ts';
import type { YoloProfile } from '../../../src/lib/state/yolo.svelte.ts';
import { codecAccepts, type Band } from '../../../src/lib/workers/gate-handler.ts';
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

function curve(name: string, preampDb: number, active: Band[]): CurveData {
	const bands = [...active, ...NEUTRO.bands.slice(active.length)];
	return { name, source: 'custom', preampDb, bands: snapshotBands(bands, 10) };
}
/** Passes the standard gate. */
const STANDARD = curve('Corte', -1, [{ kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 }]);
/** Fails the standard gate on class-2 reasons only: the YOLO gate accepts it ("subsônica"). */
const YOLO_ONLY = curve('Subsônica', -0.5, [{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]);
/** Only the codec accepts it (the free preview): +11,5 dB out, far over every output limit. */
const CODEC_ONLY = curve('Alto', -0.5, [{ kind: 'PK', freqHz: 1000, gainDb: 12, qFactor: 1 }]);

function judge(data: CurveData, profile: YoloProfile): boolean {
	const experimental = data.bands.some((band) => isExperimentalKind(band.kind));
	return gateForWrite(
		data.bands,
		data.preampDb,
		profile === 'yolo' ? { experimental, profile: 'yolo' } : { experimental }
	).ok;
}
const same = (data: Pick<CurveData, 'bands' | 'preampDb'>) => ({
	bands: data.bands,
	preampDb: data.preampDb
});
const adapter = (local = new MemoryStorage()) =>
	own(createStorage({ local, session: new MemoryStorage(), indexedDB: null, channel: null }));

it('the fixtures are what they claim: standard, YOLO-only, codec-only', () => {
	expect(judge(STANDARD, 'standard')).toBe(true);
	expect(judge(YOLO_ONLY, 'standard')).toBe(false);
	expect(judge(YOLO_ONLY, 'yolo')).toBe(true);
	expect(judge(CODEC_ONLY, 'yolo')).toBe(false);
	expect(codecAccepts(CODEC_ONLY.bands, CODEC_ONLY.preampDb)).toBe(true);
});

describe('another tab (storage event)', () => {
	function twoTabs(profileB: () => YoloProfile) {
		const tabs = createTabs();
		const a = own(
			createCurveStore({
				storage: own(createStorage(tabs.options(0))),
				now: () => 1000,
				profile: () => 'yolo'
			})
		);
		const b = own(
			createCurveStore({
				storage: own(createStorage(tabs.options(1))),
				now: () => 2000,
				profile: profileB
			})
		);
		b.set(STANDARD);
		tabs.deliver();
		return { tabs, a, b };
	}

	it('never adopts a codec-only curve, in any profile, and keeps its own history', () => {
		for (const profile of ['standard', 'yolo'] as const) {
			const { tabs, a, b } = twoTabs(() => profile);
			b.update({ preampDb: -2 });
			const before = b.current;
			const undoCount = b.undoCount;
			// The other tab's store got it somehow (an older build, a hand edit): it is persisted…
			expect(a.set(CODEC_ONLY)).toBe(true);
			tabs.deliver();
			// …but this tab neither plays nor edits it.
			expect(b.current).toBe(before);
			expect(b.undoCount).toBe(undoCount);
			expect(b.canUndo).toBe(true);
			expect(JSON.parse(tabs.local.getItem(CURRENT_STORAGE_KEY) ?? 'null')).toMatchObject(
				same(CODEC_ONLY)
			);
		}
	});

	it('adopts a YOLO-only curve only while YOLO is on in this tab', () => {
		let profile: YoloProfile = 'standard';
		const { tabs, a, b } = twoTabs(() => profile);
		a.set(YOLO_ONLY);
		tabs.deliver();
		expect(b.current).toMatchObject(same(STANDARD));
		profile = 'yolo';
		a.update({ name: 'Subsônica 2' });
		tabs.deliver();
		expect(b.current).toMatchObject({ ...same(YOLO_ONLY), name: 'Subsônica 2' });
	});

	it('adopts a standard curve in every profile', () => {
		const { tabs, a, b } = twoTabs(() => 'standard');
		a.set({ ...STANDARD, name: 'Outra aba', preampDb: -3 });
		tabs.deliver();
		expect(b.current).toMatchObject({ name: 'Outra aba', preampDb: -3 });
	});
});

describe('undo and redo', () => {
	it('skip steps this tab may not adopt now, and come back to them with YOLO on', () => {
		let profile: YoloProfile = 'standard';
		const store = own(createCurveStore({ storage: adapter(), profile: () => profile }));
		store.set(STANDARD);
		profile = 'yolo';
		store.set(YOLO_ONLY);
		// `set` is the editor's own, already gated path; a codec-only curve must never get here,
		// but if it does, history never brings it back.
		store.set(CODEC_ONLY);
		expect(store.undo()).toBe(true);
		expect(store.current).toMatchObject(same(YOLO_ONLY));
		// Redo would bring back the codec-only curve: refused in every profile.
		expect(store.canRedo).toBe(false);
		expect(store.redo()).toBe(false);
		expect(store.current).toMatchObject(same(YOLO_ONLY));

		// YOLO off: the YOLO-only step cannot come back either.
		expect(store.undo()).toBe(true);
		expect(store.current).toMatchObject(same(STANDARD));
		profile = 'standard';
		expect(store.canRedo).toBe(false);
		expect(store.redo()).toBe(false);
		expect(store.current).toMatchObject(same(STANDARD));
		// YOLO on again: it can.
		profile = 'yolo';
		expect(store.canRedo).toBe(true);
		expect(store.redo()).toBe(true);
		expect(store.current).toMatchObject(same(YOLO_ONLY));
	});

	it('jumps over refused steps to the newest adoptable one and drops them', () => {
		let profile: YoloProfile = 'yolo';
		const store = own(createCurveStore({ storage: adapter(), profile: () => profile }));
		store.set(STANDARD);
		store.set(YOLO_ONLY);
		store.set(CODEC_ONLY);
		store.set({ ...YOLO_ONLY, name: 'Subsônica 2' });
		profile = 'standard';
		expect(store.canUndo).toBe(true);
		expect(store.undo()).toBe(true);
		// The codec-only and the YOLO-only steps in between are gone.
		expect(store.current).toMatchObject(same(STANDARD));
		expect(store.undoCount).toBe(1);
		expect(store.undo()).toBe(true);
		expect(store.current).toMatchObject(same(NEUTRO));
		expect(store.canUndo).toBe(false);
		expect(store.undo()).toBe(false);
	});
});

describe('reload (oa.current on load)', () => {
	const stored = (data: CurveData) =>
		JSON.stringify({ ...data, schema: 1, labels: null, updatedAt: 500 });

	it('refuses a codec-only curve: the editor starts on Neutro', () => {
		const local = new MemoryStorage();
		local.setItem(CURRENT_STORAGE_KEY, stored(CODEC_ONLY));
		const store = own(createCurveStore({ storage: adapter(local) }));
		expect(store.current).toMatchObject(same(NEUTRO));
		expect(store.canUndo).toBe(false);
	});

	it('restores the YOLO-only and the standard curve a tab left there', () => {
		for (const data of [YOLO_ONLY, STANDARD]) {
			const local = new MemoryStorage();
			local.setItem(CURRENT_STORAGE_KEY, stored(data));
			const store = own(createCurveStore({ storage: adapter(local), profile: () => 'standard' }));
			expect(store.current).toMatchObject({ ...same(data), name: data.name });
		}
	});
});

it('gateAccepts judges each frozen curve once per profile', () => {
	const store = own(createCurveStore({ storage: adapter() }));
	store.set(YOLO_ONLY);
	const current = store.current;
	expect(gateAccepts(current, 'standard')).toBe(false);
	expect(gateAccepts(current, 'yolo')).toBe(true);
	expect(gateAccepts(current, 'standard')).toBe(false);
});
