/**
 * C1 (hearing safety): an edit made in "Prévia sem limites" (curves only the codec accepts) lives
 * in the Curva page's memory only. It never reaches `curve.set`, `oa.current` (so no reload and
 * no other tab sees it), nor the editor's undo history, and leaving the free preview or YOLO
 * discards it. The store's own refusals (other tabs, undo, load) are in
 * tests/unit/state/curve-adoption.test.ts; the preview protection in preview.svelte.test.ts.
 */
import '../../primitives/design-system.ts';
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { CURRENT_STORAGE_KEY, createCurveStore } from '#lib/state/curve.svelte.ts';
import { createStorage } from '#lib/state/storage.ts';
import { createYoloState, YOLO_PHRASE } from '#lib/state/yolo.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { codecAccepts, handleGateRequest } from '#lib/workers/gate-handler.ts';
import CurvaPage from '#lib/components/pages/curva/CurvaPage.svelte';
import CurvaInContext from './CurvaInContext.svelte';
import type { GateClient } from '#lib/components/pages/curva/drag.ts';
import { payloadCrc } from '#lib/components/pages/curva/format.ts';
import { verdictFor, type Band, type Curve } from '#lib/components/pages/curva/model.ts';
import { defaultOrder } from '#lib/components/pages/curva/edit.ts';
import { curveSignature, type CurveSource } from '#lib/state/model.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

const CUT: Band = { kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 };
const pad = (bands: Band[]): Band[] => [...bands, ...NEUTRO.bands.slice(bands.length)];
const STORED: Curve = { bands: pad([CUT]), preampDb: -1 };
/** Shift+↑ on the handle adds 10 dB: +4 dB at −1 dB preamp, about +3 dB out. */
const LOUD: Curve = { bands: pad([{ ...CUT, gainDb: 4 }]), preampDb: -1 };
/** A boost before the cut: not the default order (cuts first), so "Ordem padrão" moves both. */
const ORDERED: Curve = {
	bands: pad([{ kind: 'PK', freqHz: 200, gainDb: 2, qFactor: 1 }, CUT]),
	preampDb: -3
};
const DEFAULT_ORDER: Curve = { bands: defaultOrder(ORDERED.bands), preampDb: ORDERED.preampDb };
const NEUTRAL: Curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
/** Ten label entries; missing ones are null. */
const ten = (entries: (string | null)[]) =>
	Array.from({ length: 10 }, (_, index) => entries[index] ?? null);

/** The names the filter bank shows, slot by slot (the first `count`). */
function bankNames(count = 2): string[] {
	return Array.from(
		document.querySelectorAll('li.module .mod-name'),
		(node) => node.textContent?.trim() ?? ''
	).slice(0, count);
}

/** The filter bank's own "Ordem padrão" button (the nearest one around its modules). */
function bankOrderButton(): HTMLElement {
	let scope = document.querySelector('li.module')?.parentElement ?? null;
	while (scope) {
		const button = Array.from(scope.querySelectorAll('button')).find(
			(candidate) => candidate.textContent?.trim() === m.curva_order_reset()
		);
		if (button) return button;
		scope = scope.parentElement;
	}
	throw new Error('No default-order button around the bank');
}

/** Renames bank slot `index` through its field, as a person does (Enter). */
async function renameSlot(index: number, name: string) {
	const button = document.querySelector(`[data-rename="${index}"]`);
	if (!(button instanceof HTMLElement)) throw new Error(`No rename button for slot ${index}`);
	await userEvent.click(button);
	await expect.poll(() => document.querySelector('li.module input.mod-input')).not.toBeNull();
	const field = document.querySelector('li.module input.mod-input');
	if (!(field instanceof HTMLInputElement)) throw new Error('No rename field');
	await userEvent.fill(field, name);
	await userEvent.keyboard('{Enter}');
	await tick();
}

let apps: ClientApp[] = [];
afterEach(async () => {
	await cleanup();
	for (const app of apps) app.dispose();
	apps = [];
});

/** The CRC the nameplate shows for `curve` (it identifies the curve in the editor). */
function crc(curve: Curve): string {
	const payload = verdictFor(curve, 'yolo').metrics.payload;
	if (!payload) throw new Error('No payload');
	return payloadCrc(payload);
}

/**
 * Holds each commit answer until `release` (a slow gate worker). Once `open`, the later answers
 * of the same release (a snap's bisection) are not held.
 */
interface Hold {
	release: (() => void) | null;
	open?: boolean;
}

/** Lets every held and later answer through, then waits for the page to settle. */
async function releaseAll(hold: Hold) {
	hold.open = true;
	hold.release?.();
	await new Promise((resolve) => setTimeout(resolve, 50));
	await tick();
}

function gateClient(hold?: Hold): GateClient {
	let id = 0;
	return {
		async drag(input) {
			const response = handleGateRequest({ ...input, type: 'drag', id: ++id });
			if (response.type !== 'drag') throw new Error('unexpected');
			return response;
		},
		async commit(input) {
			const response = handleGateRequest({ ...input, type: 'commit', id: ++id });
			if (response.type !== 'commit') throw new Error('unexpected');
			if (hold && !hold.open) {
				await new Promise<void>((resolve) => {
					hold.release = resolve;
				});
			}
			return response;
		}
	};
}

interface SetupOptions {
	/** The stored curve the editor starts on (STORED by default). */
	stored?: Curve;
	/** Its name ('Editor' by default) and source ('custom' by default). */
	name?: string;
	source?: CurveSource;
	labels?: (string | null)[];
	/** "Prévia sem limites" on (default) or YOLO alone. */
	freePreview?: boolean;
	/**
	 * Under the app context, as in production: the bank and the scope then show and rename the
	 * stored labels (without it they keep local names). Off by default, as the tests above ran.
	 */
	context?: boolean;
}

async function setup(hold?: Hold, options: SetupOptions = {}) {
	const fake = fakeAppOptions();
	const yolo = createYoloState();
	const app = createClientApp({ ...fake.options, yolo });
	apps.push(app);
	await app.state.ready;
	app.state.curve.set({
		name: options.name ?? 'Editor',
		source: options.source ?? 'custom',
		...(options.stored ?? STORED),
		labels: options.labels ? ten(options.labels) : null
	});
	const props = {
		app,
		layer: 'engenharia' as const,
		hash: '',
		pageUrl: new URL('https://example.test/'),
		onlayer: vi.fn(),
		gateClient: gateClient(hold),
		clearLinkHash: vi.fn()
	};
	if (options.context) await render(CurvaInContext, props);
	else await render(CurvaPage, props);
	expect(yolo.enable(YOLO_PHRASE, 'engenharia')).toBe(true);
	yolo.setFreePreview(options.freePreview ?? true);
	await tick();
	return {
		app,
		yolo,
		local: fake.local,
		stored: app.state.curve.current,
		persisted: fake.local.getItem(CURRENT_STORAGE_KEY),
		undoCount: app.state.curve.undoCount
	};
}

const editorState = () => page.getByTestId('editor-state');

/** Shift+↑ on a handle (the first by default): a release only the codec accepts. */
async function loudEdit(filter: 'A' | 'B' = 'A') {
	const handle = page.getByRole('slider', { name: new RegExp(`^Filtro ${filter},`) }).element();
	if (handle instanceof HTMLElement || handle instanceof SVGElement) handle.focus();
	await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
}

test('the fixture is codec-only: the YOLO gate refuses it, the codec accepts it', () => {
	expect(verdictFor(STORED).ok).toBe(true);
	expect(verdictFor(LOUD, 'yolo').ok).toBe(false);
	expect(codecAccepts(LOUD.bands, LOUD.preampDb)).toBe(true);
	expect(crc(LOUD)).not.toBe(crc(STORED));
});

test('a free-preview edit is heard from memory only: never the store, oa.current, undo or a reload', async () => {
	const { app, yolo, local, stored, persisted, undoCount } = await setup();
	await expect.element(editorState()).toMatchTextContent(crc(STORED));
	await loudEdit();
	// The editor shows (and the preview plays) the draft…
	await expect.element(editorState()).toMatchTextContent(crc(LOUD));
	// …while the store, oa.current (what a reload and other tabs read) and the history keep
	// the stored curve.
	expect(app.state.curve.current).toBe(stored);
	expect(local.getItem(CURRENT_STORAGE_KEY)).toBe(persisted);
	expect(app.state.curve.undoCount).toBe(undoCount);
	const storage = createStorage({ local, session: null, indexedDB: null, channel: null });
	const reloaded = createCurveStore({ storage });
	try {
		expect(reloaded.current).toMatchObject({ bands: STORED.bands, preampDb: STORED.preampDb });
	} finally {
		reloaded.dispose();
		storage.dispose();
	}

	// Desfazer and Refazer step through the draft only.
	await page.getByRole('button', { name: m.curva_undo(), exact: true }).click();
	await expect.element(editorState()).toMatchTextContent(crc(STORED));
	await page.getByRole('button', { name: m.curva_redo(), exact: true }).click();
	await expect.element(editorState()).toMatchTextContent(crc(LOUD));
	expect(app.state.curve.current).toBe(stored);
	expect(app.state.curve.undoCount).toBe(undoCount);

	// Leaving the free preview discards the draft; turning it on again does not bring it back.
	yolo.setFreePreview(false);
	await tick();
	await expect.element(editorState()).toMatchTextContent(crc(STORED));
	yolo.setFreePreview(true);
	await tick();
	await expect.element(editorState()).toMatchTextContent(crc(STORED));
	expect(app.state.curve.current).toBe(stored);
	expect(local.getItem(CURRENT_STORAGE_KEY)).toBe(persisted);
});

test('turning YOLO off (the bar, or leaving Engenharia) discards the draft', async () => {
	const { app, yolo, local, stored, persisted, undoCount } = await setup();
	await loudEdit();
	await expect.element(editorState()).toMatchTextContent(crc(LOUD));
	yolo.disable();
	await tick();
	await expect.element(editorState()).toMatchTextContent(crc(STORED));
	expect(app.state.curve.current).toBe(stored);
	expect(app.state.curve.undoCount).toBe(undoCount);
	expect(local.getItem(CURRENT_STORAGE_KEY)).toBe(persisted);
});

test('the reorder fixtures: both orders pass, and the default order differs', () => {
	expect(verdictFor(ORDERED).ok).toBe(true);
	expect(verdictFor(DEFAULT_ORDER, 'yolo').ok).toBe(true);
	expect(DEFAULT_ORDER.bands.slice(0, 2)).toEqual([ORDERED.bands[1], ORDERED.bands[0]]);
	expect(crc(DEFAULT_ORDER)).not.toBe(crc(ORDERED));
});

test('a free-preview reorder moves the names with their filters; a rename lands on the stored slot', async () => {
	const { app, yolo, stored, undoCount } = await setup(undefined, {
		stored: ORDERED,
		labels: ['Kick', 'Vocal'],
		context: true
	});
	expect(stored.labels).toEqual(ten(['Kick', 'Vocal']));
	// No draft yet: the bank shows the stored labels.
	await expect.poll(() => bankNames()).toEqual(['Kick', 'Vocal']);
	await userEvent.click(bankOrderButton());
	// The draft has the cut first, and its name went with it; the store is untouched.
	await expect.element(editorState()).toMatchTextContent(crc(DEFAULT_ORDER));
	await expect.poll(() => bankNames()).toEqual(['Vocal', 'Kick']);
	expect(app.state.curve.current).toBe(stored);
	// The draft's Desfazer and Refazer move the names back and forth with the filters.
	await page.getByRole('button', { name: m.curva_undo(), exact: true }).click();
	await expect.element(editorState()).toMatchTextContent(crc(ORDERED));
	await expect.poll(() => bankNames()).toEqual(['Kick', 'Vocal']);
	await page.getByRole('button', { name: m.curva_redo(), exact: true }).click();
	await expect.element(editorState()).toMatchTextContent(crc(DEFAULT_ORDER));
	await expect.poll(() => bankNames()).toEqual(['Vocal', 'Kick']);

	// Draft slot 0 holds the cut, stored slot 1: the new name is written there.
	await renameSlot(0, 'Lead');
	await expect.poll(() => app.state.curve.current.labels).toEqual(ten(['Kick', 'Lead']));
	// Labels only: the stored bands, preamp and order are the same, and the draft stays live.
	expect(curveSignature(app.state.curve.current)).toBe(curveSignature(stored));
	expect(app.state.curve.undoCount).toBe(undoCount + 1);
	await expect.element(editorState()).toMatchTextContent(crc(DEFAULT_ORDER));
	await expect.poll(() => bankNames()).toEqual(['Lead', 'Kick']);

	// The draft ends: the stored order, and the new name still on the cut.
	yolo.setFreePreview(false);
	await tick();
	await expect.element(editorState()).toMatchTextContent(crc(ORDERED));
	await expect.poll(() => bankNames()).toEqual(['Kick', 'Lead']);
});

/** A boost, a cut and a cut: the standard gate accepts it. */
const THREE: Curve = {
	bands: pad([
		{ kind: 'PK', freqHz: 200, gainDb: 2, qFactor: 1 },
		CUT,
		{ kind: 'PK', freqHz: 5000, gainDb: -6, qFactor: 1 }
	]),
	preampDb: -3
};
/** Shift+↑ on Filtro B: the cut becomes +4 dB, about +1 dB out (codec-only). */
const THREE_LOUD: Curve = {
	bands: THREE.bands.map((band, index) => (index === 1 ? { ...CUT, gainDb: 4 } : band)),
	preampDb: THREE.preampDb
};
/** "Ordem padrão" of that draft: the 5 kHz cut first, then both boosts (still codec-only). */
const THREE_DEFAULT: Curve = {
	bands: defaultOrder(THREE_LOUD.bands),
	preampDb: THREE_LOUD.preampDb
};

test('the discrete-edit fixtures: only the codec accepts the draft, in either order', () => {
	expect(verdictFor(THREE).ok).toBe(true);
	for (const curve of [THREE_LOUD, THREE_DEFAULT]) {
		expect(verdictFor(curve, 'yolo').ok).toBe(false);
		expect(codecAccepts(curve.bands, curve.preampDb)).toBe(true);
	}
	expect(THREE_DEFAULT.bands.slice(0, 3)).toEqual([
		THREE_LOUD.bands[2],
		THREE_LOUD.bands[0],
		THREE_LOUD.bands[1]
	]);
	expect(crc(THREE_DEFAULT)).not.toBe(crc(THREE_LOUD));
});

test('a discrete edit of a codec-only draft is judged by the codec and stays in the draft', async () => {
	const { app, local, stored, persisted, undoCount } = await setup(undefined, { stored: THREE });
	await expect.element(editorState()).toMatchTextContent(crc(THREE));
	await loudEdit('B');
	await expect.element(editorState()).toMatchTextContent(crc(THREE_LOUD));
	// "Ordem padrão" on the draft: the YOLO gate would refuse it; the codec, as for drags, accepts.
	await userEvent.click(bankOrderButton());
	await expect.element(editorState()).toMatchTextContent(crc(THREE_DEFAULT));
	// Into the memory-only draft (`applyFree`): never the store, oa.current or the undo history.
	expect(app.state.curve.current).toBe(stored);
	expect(local.getItem(CURRENT_STORAGE_KEY)).toBe(persisted);
	expect(app.state.curve.undoCount).toBe(undoCount);
	// It is a draft step: Desfazer goes back to the loud draft, then to the stored curve.
	await page.getByRole('button', { name: m.curva_undo(), exact: true }).click();
	await expect.element(editorState()).toMatchTextContent(crc(THREE_LOUD));
	await page.getByRole('button', { name: m.curva_undo(), exact: true }).click();
	await expect.element(editorState()).toMatchTextContent(crc(THREE));
	expect(app.state.curve.current).toBe(stored);
	expect(app.state.curve.undoCount).toBe(undoCount);
});

test('a commit answer is dropped when the stored curve changed while the gate answered', async () => {
	const hold: Hold = { release: null };
	const { app, local } = await setup(hold);
	await loudEdit();
	await vi.waitFor(() => expect(hold.release).not.toBeNull());
	// Another curve is stored meanwhile (Neutro, as another tab or a preset would).
	expect(app.loadNeutral()).toBe(true);
	await tick();
	const neutral = app.state.curve.current;
	const persisted = local.getItem(CURRENT_STORAGE_KEY);
	await releaseAll(hold);
	// The answer was about the old curve: no draft over Neutro, nothing stored.
	await expect.element(editorState()).toMatchTextContent(crc(NEUTRAL));
	expect(app.state.curve.current).toBe(neutral);
	expect(local.getItem(CURRENT_STORAGE_KEY)).toBe(persisted);
});

test('a commit answer is dropped when the gate profile changed while the gate answered', async () => {
	const hold: Hold = { release: null };
	const { app, yolo, local, stored, persisted, undoCount } = await setup(hold, {
		freePreview: false
	});
	// Modo YOLO alone: the release is judged in the YOLO profile and would be stored.
	await loudEdit();
	await vi.waitFor(() => expect(hold.release).not.toBeNull());
	yolo.disable();
	await tick();
	await releaseAll(hold);
	// Judged in a profile that no longer applies: dropped, the stored curve stays.
	await expect.element(editorState()).toMatchTextContent(crc(STORED));
	expect(app.state.curve.current).toBe(stored);
	expect(app.state.curve.undoCount).toBe(undoCount);
	expect(local.getItem(CURRENT_STORAGE_KEY)).toBe(persisted);
});

test('the same release with no change while the gate answers is stored (YOLO alone)', async () => {
	const hold: Hold = { release: null };
	const { app, stored, undoCount } = await setup(hold, { freePreview: false });
	await loudEdit();
	await vi.waitFor(() => expect(hold.release).not.toBeNull());
	await releaseAll(hold);
	// Control for the test above: nothing changed, so the gate's answer is applied.
	await expect.poll(() => app.state.curve.current).not.toBe(stored);
	expect(app.state.curve.undoCount).toBe(undoCount + 1);
});

/** ↑ (or another key) on the first handle: one dB, a release the YOLO gate also accepts. */
async function gentleEdit(key = '{ArrowUp}') {
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
	if (handle instanceof HTMLElement || handle instanceof SVGElement) handle.focus();
	await userEvent.keyboard(key);
}
/** STORED after ↑: −5 dB at −1 dB preamp. */
const GENTLE: Curve = { bands: pad([{ ...CUT, gainDb: -5 }]), preampDb: -1 };

test('the gentle fixture passes the YOLO gate: it is not preview-only', () => {
	expect(verdictFor(GENTLE, 'yolo').ok).toBe(true);
	expect(crc(GENTLE)).not.toBe(crc(STORED));
});

test.each([
	['ended', false],
	['ended, then on again', true]
] as const)(
	'an answer that passes the YOLO gate is dropped once the free preview it began in %s',
	async (_, again) => {
		const hold: Hold = { release: null };
		const { app, yolo, local, stored, persisted, undoCount } = await setup(hold);
		await gentleEdit();
		await vi.waitFor(() => expect(hold.release).not.toBeNull());
		// YOLO stays on: the gate profile ('yolo') is the same, only the free preview changed.
		yolo.setFreePreview(false);
		await tick();
		if (again) {
			yolo.setFreePreview(true);
			await tick();
		}
		await releaseAll(hold);
		// C1: begun as a memory-only draft edit, it reaches neither a draft nor the store.
		await expect.element(editorState()).toMatchTextContent(crc(STORED));
		expect(app.state.curve.current).toBe(stored);
		expect(app.state.curve.undoCount).toBe(undoCount);
		expect(local.getItem(CURRENT_STORAGE_KEY)).toBe(persisted);
	}
);

test('a free-preview answer is dropped after a draft Desfazer while the gate answered (#38)', async () => {
	const hold: Hold = { release: null, open: true };
	const { app, stored, undoCount } = await setup(hold);
	// A first draft step, answered at once.
	await loudEdit();
	await expect.element(editorState()).toMatchTextContent(crc(LOUD));
	// The next release waits for the gate…
	hold.open = false;
	hold.release = null;
	await gentleEdit('{ArrowDown}');
	await vi.waitFor(() => expect(hold.release).not.toBeNull());
	// …while the draft steps back to the stored curve.
	await page.getByRole('button', { name: m.curva_undo(), exact: true }).click();
	await expect.element(editorState()).toMatchTextContent(crc(STORED));
	await releaseAll(hold);
	// The answer was about the step undone: it does not come back over the Desfazer.
	await expect.element(editorState()).toMatchTextContent(crc(STORED));
	expect(app.state.curve.current).toBe(stored);
	expect(app.state.curve.undoCount).toBe(undoCount);
});

test('a free-preview answer is dropped after a draft reorder while the gate answered (#38)', async () => {
	const hold: Hold = { release: null };
	const { app, stored } = await setup(hold, { stored: ORDERED });
	await expect.poll(() => document.querySelector('li.module')).not.toBeNull();
	// Filtro A is the 200 Hz boost: +2 → +3 dB, held by the gate…
	await gentleEdit();
	await vi.waitFor(() => expect(hold.release).not.toBeNull());
	// …while "Ordem padrão" reorders the draft.
	await userEvent.click(bankOrderButton());
	await expect.element(editorState()).toMatchTextContent(crc(DEFAULT_ORDER));
	await releaseAll(hold);
	// The answer, in the old order, does not undo the reorder.
	await expect.element(editorState()).toMatchTextContent(crc(DEFAULT_ORDER));
	expect(app.state.curve.current).toBe(stored);
});

test('turning YOLO off restores the whole curve before it: name, source, labels, bands, preamp', async () => {
	const { app, yolo } = await setup(undefined, {
		name: 'Arquivo',
		source: 'import',
		labels: ['Kick'],
		freePreview: false
	});
	// A YOLO-only experiment or import renames the curve and gives it another source.
	const yoloOnly = pad([{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]);
	expect(verdictFor({ bands: yoloOnly, preampDb: -0.5 }).ok).toBe(false);
	const renamed = { name: 'Subsônica', source: 'custom' as const, labels: null };
	expect(app.state.curve.set({ ...renamed, bands: yoloOnly, preampDb: -0.5 })).toBe(true);
	yolo.disable();
	await tick();
	await expect
		.poll(() => app.state.curve.current)
		.toMatchObject({
			name: 'Arquivo',
			source: 'import',
			labels: ten(['Kick']),
			bands: STORED.bands,
			preampDb: STORED.preampDb
		});
	await expect.element(editorState()).toMatchTextContent(crc(STORED));
});

test('a codec-only answer that arrives after the free preview ended is dropped', async () => {
	const hold: Hold = { release: null };
	const { app, yolo, local, stored, persisted } = await setup(hold);
	await loudEdit();
	await vi.waitFor(() => expect(hold.release).not.toBeNull());
	yolo.setFreePreview(false);
	await tick();
	hold.release?.();
	await new Promise((resolve) => setTimeout(resolve, 50));
	await tick();
	await expect.element(editorState()).toMatchTextContent(crc(STORED));
	expect(app.state.curve.current).toBe(stored);
	expect(local.getItem(CURRENT_STORAGE_KEY)).toBe(persisted);
});
