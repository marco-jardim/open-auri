import '../../primitives/design-system.ts';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { autoPreamp, THRESHOLDS } from 'open-auri/safety';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { createYoloState, YOLO_PHRASE } from '#lib/state/yolo.svelte.ts';
import { editorVerdict } from '#lib/components/pages/curva/edit.ts';
import { m } from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import { handleGateRequest } from '#lib/workers/gate-handler.ts';
import CurvaPage from '#lib/components/pages/curva/CurvaPage.svelte';
import {
	PREAMP_MAX_DB,
	PREAMP_MIN_DB,
	PREAMP_STEP_DB
} from '#lib/components/pages/curva/OutputPanel.svelte';
import type { GateClient } from '#lib/components/pages/curva/drag.ts';
import { formatNumber, formatSignedDb } from '#lib/components/pages/curva/format.ts';
import type { Layer } from '#lib/components/pages/curva/layers.ts';
import { verdictFor, type Band, type Curve } from '#lib/components/pages/curva/model.ts';
import { firstReasonText } from '#lib/components/pages/curva/reasons.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

const locale = getLocale();
const cut: Band = { kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 };
const boost: Band = { kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 };
const pad = (bands: Band[]) => [...bands, ...NEUTRO.bands.slice(bands.length)];
const apps: ClientApp[] = [];

afterEach(async () => {
	await cleanup();
	for (const app of apps.splice(0)) app.dispose();
	vi.restoreAllMocks();
});

function gateClient(): GateClient {
	let id = 0;
	return {
		async drag(input) {
			const result = handleGateRequest({ ...input, type: 'drag', id: ++id });
			if (result.type !== 'drag') throw new Error('Unexpected drag response');
			return result;
		},
		async commit(input) {
			const result = handleGateRequest({ ...input, type: 'commit', id: ++id });
			if (result.type !== 'commit') throw new Error('Unexpected commit response');
			return result;
		}
	};
}

async function setup(layer: Layer, curve: Curve, yolo = false) {
	const state = createYoloState();
	if (yolo && !state.enable(YOLO_PHRASE, layer)) throw new Error('YOLO needs Engenharia');
	const app = createClientApp({ ...fakeAppOptions().options, yolo: state });
	apps.push(app);
	await app.state.ready;
	app.state.curve.set({ ...curve, name: 'Editor', source: 'custom' });
	const screen = await render(CurvaPage, {
		app,
		layer,
		hash: '',
		pageUrl: new URL('https://example.test/'),
		onlayer: vi.fn(),
		gateClient: gateClient(),
		clearLinkHash: vi.fn()
	});
	await tick();
	return { app, screen };
}

const field = () => page.getByRole('spinbutton', { name: m.curva_out_preamp(), exact: true });
const down = () => page.getByRole('button', { name: m.curva_preamp_down(), exact: true });
const up = () => page.getByRole('button', { name: m.curva_preamp_up(), exact: true });

function input(): HTMLInputElement {
	const element = field().element();
	if (!(element instanceof HTMLInputElement)) throw new Error('Missing preamp field');
	return element;
}
function key(name: string, init: KeyboardEventInit = {}) {
	input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init }));
}
/** A click dispatched on the element (an aria-disabled button blocks Playwright's own click). */
function click(button: Element, init: MouseEventInit = {}) {
	button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
}

test('the range and the step are the gate and codec ones', () => {
	expect(PREAMP_MIN_DB).toBe(THRESHOLDS.preampMinDb);
	expect(PREAMP_MAX_DB).toBe(THRESHOLDS.preampMaxDb);
	expect([PREAMP_MIN_DB, PREAMP_MAX_DB, PREAMP_STEP_DB]).toEqual([-25.5, -0.5, 0.1]);
});

test('steps, keys and typed values change the preamp through the gate, one undo step each', async () => {
	const { app } = await setup('ajustar', { bands: pad([cut]), preampDb: -1 });
	await expect.element(field()).toHaveAttribute('aria-valuetext', formatSignedDb(-1, locale));
	await expect.element(field()).toHaveAttribute('aria-valuemin', String(PREAMP_MIN_DB));
	await expect.element(field()).toHaveAttribute('aria-valuemax', String(PREAMP_MAX_DB));
	await expect.element(field()).not.toHaveAttribute('aria-disabled');
	await expect.element(field()).toHaveAccessibleDescription(m.curva_preamp_hint());
	const undoBase = app.state.curve.undoCount;

	await down().click();
	expect(app.state.curve.current.preampDb).toBe(-1.1);
	click(up().element(), { shiftKey: true });
	expect(app.state.curve.current.preampDb).toBe(-0.6);

	key('ArrowDown');
	expect(app.state.curve.current.preampDb).toBe(-0.7);
	key('PageDown');
	expect(app.state.curve.current.preampDb).toBe(-1.7);
	key('ArrowDown', { shiftKey: true });
	expect(app.state.curve.current.preampDb).toBe(-2.2);

	// Typed: decimal comma, real minus, off the grid (snapped to 0,1 dB); Enter applies.
	await field().fill('\u22123,24');
	expect(app.state.curve.current.preampDb).toBe(-2.2);
	key('Enter');
	expect(app.state.curve.current.preampDb).toBe(-3.2);
	// Out of range: clamped to the gate's floor, never offered beyond it.
	await field().fill('-40');
	key('Enter');
	expect(app.state.curve.current.preampDb).toBe(PREAMP_MIN_DB);
	await expect.element(down()).toHaveAttribute('aria-disabled', 'true');
	await expect
		.element(down())
		.toHaveAccessibleDescription(
			m.curva_preamp_at_min({ value: formatSignedDb(PREAMP_MIN_DB, locale) })
		);
	// Unreadable text proposes nothing and the field shows the last accepted value again.
	await field().fill('abc');
	key('Enter');
	expect(app.state.curve.current.preampDb).toBe(PREAMP_MIN_DB);
	await tick();
	expect(input().value).toBe(formatNumber(PREAMP_MIN_DB, locale, 1));

	expect(app.state.curve.undoCount).toBe(undoBase + 7);
	expect(app.state.curve.current.bands).toEqual(pad([cut]));
	expect(app.pendingWrite).toBeNull();
});

test('a refused preamp keeps the last accepted value and shows the gate reason', async () => {
	const bands = pad([boost]);
	const top = autoPreamp(bands);
	if (top === null || top >= PREAMP_MAX_DB) throw new Error('Expected a gate-bounded preamp');
	const { app, screen } = await setup('engenharia', { bands, preampDb: top });
	const before = app.state.curve.current;
	const undoBase = app.state.curve.undoCount;
	const message = () => screen.container.querySelector('.ps-out .pre-msg')?.textContent ?? null;
	const refusal = (preampDb: number) =>
		m.curva_preamp_refused({
			value: formatSignedDb(preampDb, locale),
			reason: firstReasonText(verdictFor({ bands, preampDb }).reasons, { bands, locale })
		});

	// One step above the highest accepted preamp: the gate refuses it.
	const above = Math.round(top * 10 + 1) / 10;
	expect(verdictFor({ bands, preampDb: above }).ok).toBe(false);
	await up().click();
	await vi.waitFor(() => expect(message()).toBe(refusal(above)));
	expect(app.state.curve.current).toEqual(before);
	await expect.element(field()).toHaveAttribute('aria-valuetext', formatSignedDb(top, locale));

	// Typed: refused too, and the field goes back to the last accepted value.
	await field().fill(formatNumber(PREAMP_MAX_DB, locale, 1));
	key('Enter');
	await vi.waitFor(() => expect(message()).toBe(refusal(PREAMP_MAX_DB)));
	await tick();
	expect(input().value).toBe(formatNumber(top, locale, 1));
	expect(app.state.curve.current).toEqual(before);
	expect(app.state.curve.undoCount).toBe(undoBase);

	// An accepted value clears the refusal.
	await down().click();
	expect(app.state.curve.current.preampDb).toBe(Math.round(top * 10 - 1) / 10);
	await vi.waitFor(() => expect(message()).toBeNull());
});

test('Ouvir shows the preamp read-only and says why; loading and writing say why too', async () => {
	const { app, screen } = await setup('ouvir', { bands: pad([cut]), preampDb: -1 });
	const before = app.state.curve.current;
	const reason = m.curva_preamp_ouvir_reason();
	await expect.element(field()).toHaveAttribute('aria-valuetext', formatSignedDb(-1, locale));
	await expect.element(field()).toHaveAttribute('aria-disabled', 'true');
	await expect.element(field()).toHaveAttribute('readonly');
	await expect.element(field()).toHaveAccessibleDescription(reason);
	for (const button of [down(), up()]) {
		await expect.element(button).toHaveAttribute('aria-disabled', 'true');
		await expect.element(button).toHaveAccessibleDescription(reason);
		click(button.element());
		click(button.element(), { shiftKey: true });
	}
	for (const name of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Enter']) key(name);
	await tick();
	expect(app.state.curve.current).toEqual(before);
	// "Máximo sem clipping" stays next to it.
	await expect
		.element(page.getByRole('button', { name: m.curva_maxclip(), exact: true }))
		.not.toHaveAttribute('aria-disabled');

	await screen.rerender({ app: null });
	await expect.element(field()).toHaveAttribute('aria-disabled', 'true');
	await expect.element(field()).toHaveAccessibleDescription(m.curva_v2_loading_reason());

	const state = vi
		.spyOn(app, 'cableState', 'get')
		.mockReturnValue({ ...app.cableState, writing: true });
	await screen.rerender({ app, layer: 'ajustar' });
	await expect.element(field()).toHaveAttribute('aria-disabled', 'true');
	await expect.element(field()).toHaveAccessibleDescription(m.curva_v2_writing_reason());
	await expect.element(down()).toHaveAccessibleDescription(m.curva_v2_writing_reason());
	key('PageDown');
	await tick();
	expect(app.state.curve.current).toEqual(before);

	state.mockRestore();
	await screen.rerender({ app: null });
	await screen.rerender({ app });
	await expect.element(field()).not.toHaveAttribute('aria-disabled');
	key('ArrowDown');
	expect(app.state.curve.current.preampDb).toBe(-1.1);
});

test('undo and redo restore preamp changes', async () => {
	const { app } = await setup('ajustar', { bands: pad([cut]), preampDb: -1 });
	await down().click();
	await field().fill('-4');
	key('Enter');
	expect(app.state.curve.current.preampDb).toBe(-4);

	await page.getByRole('button', { name: m.curva_undo(), exact: true }).click();
	expect(app.state.curve.current.preampDb).toBe(-1.1);
	await expect.element(field()).toHaveAttribute('aria-valuetext', formatSignedDb(-1.1, locale));
	await page.getByRole('button', { name: m.curva_undo(), exact: true }).click();
	expect(app.state.curve.current.preampDb).toBe(-1);
	await expect.element(field()).toHaveAttribute('aria-valuetext', formatSignedDb(-1, locale));
	await page.getByRole('button', { name: m.curva_redo(), exact: true }).click();
	expect(app.state.curve.current.preampDb).toBe(-1.1);
	await expect.element(field()).toHaveAttribute('aria-valuetext', formatSignedDb(-1.1, locale));
	expect(app.pendingWrite).toBeNull();
});

// M2: a curve the standard gate refuses only on class-2 reasons ("subsônica", HP 30 Hz).
const subsonic: Curve = {
	bands: pad([{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]),
	preampDb: -0.5
};

test('in YOLO the manual preamp uses the YOLO gate, up to 0 dB, never below −25,5 dB', async () => {
	expect(verdictFor(subsonic).ok).toBe(false);
	expect(verdictFor(subsonic, 'yolo').ok).toBe(true);
	const { app, screen } = await setup('engenharia', subsonic, true);
	const message = () => screen.container.querySelector('.ps-out .pre-msg')?.textContent ?? null;
	await expect.element(field()).toHaveAttribute('aria-valuemin', String(PREAMP_MIN_DB));
	await expect.element(field()).toHaveAttribute('aria-valuemax', '0');

	// The YOLO gate takes what the standard gate refuses: one undoable step.
	const undoBase = app.state.curve.undoCount;
	await down().click();
	expect(app.state.curve.current.preampDb).toBe(-0.6);
	expect(app.state.curve.undoCount).toBe(undoBase + 1);

	// The clamp is wider (0 dB, not −0,5 dB); the YOLO gate still judges the value.
	await field().fill('3');
	key('Enter');
	const atZero = editorVerdict({ bands: subsonic.bands, preampDb: 0 }, 'yolo');
	expect(atZero.ok).toBe(false);
	const refusal = m.curva_preamp_refused({
		value: formatSignedDb(0, locale),
		reason: firstReasonText(atZero.reasons, { bands: subsonic.bands, locale })
	});
	await vi.waitFor(() => expect(message()).toBe(refusal));
	expect(app.state.curve.current.preampDb).toBe(-0.6);

	// The floor stays −25,5 dB (S1), not the codec's: a YOLO curve stays storable.
	await field().fill('-40');
	key('Enter');
	expect(app.state.curve.current.preampDb).toBe(PREAMP_MIN_DB);
	await expect.element(down()).toHaveAttribute('aria-disabled', 'true');
	expect(app.pendingWrite).toBeNull();
});

test('with YOLO off the same preamp step is refused by the standard gate', async () => {
	const { app, screen } = await setup('engenharia', subsonic);
	const before = app.state.curve.current;
	const message = () => screen.container.querySelector('.ps-out .pre-msg')?.textContent ?? null;
	await expect.element(field()).toHaveAttribute('aria-valuemax', String(PREAMP_MAX_DB));
	await down().click();
	const refusal = m.curva_preamp_refused({
		value: formatSignedDb(-0.6, locale),
		reason: firstReasonText(verdictFor({ bands: subsonic.bands, preampDb: -0.6 }).reasons, {
			bands: subsonic.bands,
			locale
		})
	});
	await vi.waitFor(() => expect(message()).toBe(refusal));
	expect(app.state.curve.current).toEqual(before);
});
