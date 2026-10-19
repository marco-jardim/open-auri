import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { gateForWrite } from 'open-auri/safety';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { m } from '#lib/paraglide/messages.js';
import { handleGateRequest } from '#lib/workers/gate-handler.ts';
import CurvaPage from '#lib/components/pages/curva/CurvaPage.svelte';
import type { GateClient } from '#lib/components/pages/curva/drag.ts';
import { verdictFor, type Band, type Curve } from '#lib/components/pages/curva/model.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

// Core's gain band (PK/LS/HS share one type), so `cut.gainDb` and spreads keep a gain.
const cut: Extract<Band, { kind: 'PK' | 'LS' | 'HS' }> = {
	kind: 'PK',
	freqHz: 1000,
	gainDb: -6,
	qFactor: 1
};
const pad = (bands: Band[]) => [...bands, ...NEUTRO.bands.slice(bands.length)];
const start: Curve = { bands: pad([cut]), preampDb: -1 };
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

async function setup(gate: GateClient) {
	const app = createClientApp(fakeAppOptions().options);
	apps.push(app);
	await app.state.ready;
	app.state.curve.set({ ...start, name: 'Editor', source: 'custom' });
	const screen = await render(CurvaPage, {
		app,
		layer: 'ajustar',
		hash: '',
		pageUrl: new URL('https://example.test/'),
		onlayer: vi.fn(),
		gateClient: gate
	});
	await tick();
	return { app, screen };
}

/** Pointer events on handle 1, at a fraction of the scope overlay (synthetic: no capture slot). */
function pointerEditor(container: HTMLElement) {
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
	vi.spyOn(handle, 'setPointerCapture').mockImplementation(() => undefined);
	const overlay = container.querySelector('svg.handles');
	if (!overlay) throw new Error('Missing handle overlay');
	const rect = overlay.getBoundingClientRect();
	return (type: string, horizontal = 0.4, vertical = 0.65) =>
		handle.dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				cancelable: true,
				pointerId: 7,
				clientX: rect.left + rect.width * horizontal,
				clientY: rect.top + rect.height * vertical
			})
		);
}

/** The fixed text of a message around its `{reason}`. */
const lead = (text: string) => text.split('\u0000')[0] ?? text;

test('outside the envelope the handle keeps following the pointer, coloured, with a reason', async () => {
	const client = gateClient();
	const commit = vi.spyOn(client, 'commit');
	const { app, screen } = await setup(client);
	const pointer = pointerEditor(screen.container);
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
	pointer('pointerdown');
	// Top of the scope: +9.2 dB with a −1 dB preamp is far over the output and internal limits.
	pointer('pointermove', 0.4, 0.05);
	await vi.waitFor(() => expect(handle.classList.contains('outside')).toBe(true));
	const outside = lead(m.curva_drag_outside({ reason: '\u0000' }));
	await vi.waitFor(() => expect(screen.container.textContent).toContain(outside));
	// The reason names the band (gate stage → band number); no placeholder anywhere.
	expect(screen.container.textContent).toContain(m.curva_where_band_bare({ index: '1' }));
	expect(screen.container.querySelector('.scope-msg')?.textContent).not.toContain('?');
	// Not frozen: the handle still moves while the advisory verdict says "outside".
	const there = handle.getAttribute('aria-valuenow');
	pointer('pointermove', 0.5, 0.05);
	await vi.waitFor(() => expect(handle.getAttribute('aria-valuenow')).not.toBe(there));
	// Back inside: the colour and the message clear, still without committing anything.
	pointer('pointermove', 0.6, 0.65);
	await vi.waitFor(() => expect(handle.classList.contains('outside')).toBe(false));
	await vi.waitFor(() => expect(screen.container.textContent).not.toContain(outside));
	expect(commit).not.toHaveBeenCalled();
	expect(app.state.curve.current.bands[0]).toEqual(cut);
	expect(app.pendingWrite).toBeNull();
});

test('a release outside stops at the last safe point, names the band and never writes', async () => {
	const { app, screen } = await setup(gateClient());
	const pointer = pointerEditor(screen.container);
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
	pointer('pointerdown');
	pointer('pointermove', 0.4, 0.05);
	await vi.waitFor(() => expect(handle.getAttribute('aria-valuenow')).not.toBe('1000'));
	pointer('pointerup', 0.4, 0.05);
	const snapped = lead(m.curva_drag_snapped({ index: '1', reason: '\u0000' }));
	await vi.waitFor(() => expect(screen.container.textContent).toContain(snapped));
	const band = app.state.curve.current.bands[0];
	if (band?.kind !== 'PK') throw new Error('Expected PK band');
	expect(band.gainDb).toBeGreaterThan(cut.gainDb);
	expect(band.gainDb).toBeLessThan(9.2);
	expect(verdictFor(app.state.curve.current).ok).toBe(true);
	expect(app.pendingWrite).toBeNull();
	// The handle eases to the committed point (no draft left behind).
	await vi.waitFor(() => expect(handle.getAttribute('aria-valuenow')).toBe(String(band.freqHz)));
	expect(screen.container.querySelector('.scope-msg')?.textContent).not.toContain('?');
});

test('a release the gate refuses everywhere goes back to where it was and shakes', async () => {
	const client = gateClient();
	const refusedCurve: Curve = {
		bands: pad([{ ...cut, gainDb: 9 }]),
		preampDb: -1
	};
	const refused = gateForWrite(refusedCurve.bands, refusedCurve.preampDb);
	expect(refused.ok).toBe(false);
	vi.spyOn(client, 'commit').mockResolvedValue({ type: 'commit', id: 0, verdict: refused });
	const { app, screen } = await setup(client);
	const pointer = pointerEditor(screen.container);
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
	pointer('pointerdown');
	pointer('pointermove', 0.4, 0.1);
	pointer('pointerup', 0.4, 0.1);
	const reverted = lead(m.curva_drag_reverted({ index: '1', reason: '\u0000' }));
	await vi.waitFor(() => {
		expect(screen.container.textContent).toContain(reverted);
		expect(handle.classList.contains('refused')).toBe(true);
	});
	expect(app.state.curve.current.bands[0]).toEqual(cut);
	await vi.waitFor(() => expect(handle.getAttribute('aria-valuenow')).toBe('1000'));
});

test('"Máximo sem clipping" sets the highest gate-approved preamp in the editor only', async () => {
	const { app, screen } = await setup(gateClient());
	const write = vi.spyOn(app, 'requestWrite');
	const output = page.getByRole('region', { name: m.curva_out_heading(), exact: true });
	const button = output.getByRole('button', { name: m.curva_maxclip(), exact: true });
	await button.click();
	// Cuts only: the preamp can go to the top of its range.
	await vi.waitFor(() => expect(app.state.curve.current.preampDb).toBe(-0.5));
	expect(app.state.curve.current.bands).toEqual(start.bands);
	expect(verdictFor(app.state.curve.current).ok).toBe(true);
	await expect.element(output.getByText(m.curva_maxclip_done({ value: '−0,5 dB' }))).toBeVisible();
	await button.click();
	await expect.element(output.getByText(m.curva_maxclip_same({ value: '−0,5 dB' }))).toBeVisible();
	expect(app.state.curve.canUndo).toBe(true);
	// The message belongs to that curve: an undo hides it.
	app.state.curve.undo();
	await vi.waitFor(() => expect(app.state.curve.current.preampDb).toBe(-1));
	await vi.waitFor(() => expect(screen.container.querySelector('.maxclip-msg')).toBeNull());
	expect(write).not.toHaveBeenCalled();
	expect(app.pendingWrite).toBeNull();
});

test('the wheel over a handle changes Q and commits once after the last notch', async () => {
	const client = gateClient();
	const commit = vi.spyOn(client, 'commit');
	const { app } = await setup(client);
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
	const notch = () =>
		handle.dispatchEvent(
			new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
		);
	expect(notch()).toBe(false);
	expect(notch()).toBe(false);
	await vi.waitFor(() => expect(app.state.curve.current.bands[0]).toMatchObject({ qFactor: 1.2 }));
	expect(commit).toHaveBeenCalledOnce();
	expect(app.pendingWrite).toBeNull();
});
