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
import type { GateClient } from '#lib/components/pages/curva/drag.ts';
import { payloadCrc } from '#lib/components/pages/curva/format.ts';
import { verdictFor, type Band, type Curve } from '#lib/components/pages/curva/model.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

const CUT: Band = { kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 };
const pad = (bands: Band[]): Band[] => [...bands, ...NEUTRO.bands.slice(bands.length)];
const STORED: Curve = { bands: pad([CUT]), preampDb: -1 };
/** Shift+↑ on the handle adds 10 dB: +4 dB at −1 dB preamp, about +3 dB out. */
const LOUD: Curve = { bands: pad([{ ...CUT, gainDb: 4 }]), preampDb: -1 };

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

/** Holds each commit answer until `release` (a slow gate worker). */
interface Hold {
	release: (() => void) | null;
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
			if (hold) {
				await new Promise<void>((resolve) => {
					hold.release = resolve;
				});
			}
			return response;
		}
	};
}

async function setup(hold?: Hold) {
	const fake = fakeAppOptions();
	const yolo = createYoloState();
	const app = createClientApp({ ...fake.options, yolo });
	apps.push(app);
	await app.state.ready;
	app.state.curve.set({ name: 'Editor', source: 'custom', ...STORED });
	await render(CurvaPage, {
		app,
		layer: 'engenharia',
		hash: '',
		pageUrl: new URL('https://example.test/'),
		onlayer: vi.fn(),
		gateClient: gateClient(hold),
		clearLinkHash: vi.fn()
	});
	expect(yolo.enable(YOLO_PHRASE, 'engenharia')).toBe(true);
	yolo.setFreePreview(true);
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

/** Shift+↑ on the first handle: a release only the codec accepts. */
async function loudEdit() {
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
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
