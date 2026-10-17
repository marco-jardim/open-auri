import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick, type ComponentProps } from 'svelte';
import { NEUTRO, OFFICIAL_PRESETS, PADRAO_AURI } from 'open-auri/catalog';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { handleGateRequest } from '#lib/workers/gate-handler.ts';
import CurvaPage from '#lib/components/pages/curva/CurvaPage.svelte';
import FilterBank from '#lib/components/pages/curva/FilterBank.svelte';
import LayerSelector from '#lib/components/pages/curva/LayerSelector.svelte';
import MacroKnobs from '#lib/components/pages/curva/MacroKnobs.svelte';
import PresetTabs from '#lib/components/pages/curva/PresetTabs.svelte';
import ScopePanel from '#lib/components/pages/curva/ScopePanel.svelte';
import type { DragTarget, GateClient } from '#lib/components/pages/curva/drag.ts';
import type { Layer } from '#lib/components/pages/curva/layers.ts';
import { verdictFor, type Band, type Curve } from '#lib/components/pages/curva/model.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

const CUT: Band = { kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 };
const neutral: Curve = { bands: [...NEUTRO.bands], preampDb: NEUTRO.preampDb };
const withCut: Curve = { bands: [CUT, ...NEUTRO.bands.slice(1)], preampDb: -3 };

let apps: ClientApp[] = [];

afterEach(async () => {
	await cleanup();
	for (const app of apps) app.dispose();
	apps = [];
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

function gateClient(): GateClient {
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
			return response;
		}
	};
}

function pointer(element: Element, type: string, init: PointerEventInit = {}) {
	element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 5, ...init }));
}

function capture(element: Element) {
	vi.spyOn(element, 'setPointerCapture').mockImplementation(() => undefined);
}

async function curva(layer: Layer, bands?: Band[], preampDb = -0.5, withApp = true) {
	const app = withApp ? createClientApp(fakeAppOptions().options) : null;
	if (app) {
		apps.push(app);
		if (bands) app.state.curve.set({ name: 'Teste', source: 'custom', preampDb, bands });
	}
	const onlayer = vi.fn();
	const screen = await render(CurvaPage, {
		app,
		layer,
		hash: '',
		pageUrl: new URL('https://example.test/'),
		onlayer,
		gateClient: gateClient(),
		tourAutoOpen: false
	});
	return { app, onlayer, screen };
}

async function scope(overrides: Partial<ComponentProps<typeof ScopePanel>> = {}) {
	const onpark = vi.fn();
	const oncommit = vi.fn();
	const ondrag = vi.fn();
	const screen = await render(ScopePanel, {
		curve: withCut,
		committed: withCut,
		layer: 'ajustar',
		locale: 'pt-BR',
		spectrumMode: 'data',
		analyser: null,
		playing: false,
		side: 'B',
		referenceName: 'Auri',
		ondrag,
		oncommit,
		onpark,
		onpreview: vi.fn(),
		onside: vi.fn(),
		...overrides
	});
	return { screen, onpark, oncommit, ondrag };
}

// --- layer knob ------------------------------------------------------------------------------

test('the layer knob is a keyboard radiogroup with a lamp on the active layer', async () => {
	const onlayer = vi.fn();
	const screen = await render(LayerSelector, { layer: 'ajustar', onlayer });
	const group = page.getByRole('radiogroup', { name: m.curva_layer_aria() });
	await expect.element(group).toBeInTheDocument();
	const ajustar = page.getByRole('radio', { name: m.curva_layer_ajustar(), exact: true });
	await expect.element(ajustar).toHaveAttribute('aria-checked', 'true');
	await expect.element(ajustar).toHaveAttribute('tabindex', '0');
	const lit = screen.container.querySelectorAll('.lamp[data-on="true"]');
	expect(lit).toHaveLength(1);
	expect(lit[0]?.closest('[role="radio"]')?.getAttribute('aria-checked')).toBe('true');
	ajustar.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
	expect(onlayer).toHaveBeenLastCalledWith('ouvir');
	ajustar.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
	expect(onlayer).toHaveBeenLastCalledWith('engenharia');
	// The knob face turns one detent to the next layer (pointer shortcut).
	screen.container
		.querySelector('.dial')
		?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	expect(onlayer).toHaveBeenCalledTimes(3);
	expect(onlayer).toHaveBeenLastCalledWith('engenharia');
	expect(screen.container.querySelector('[data-tour="curva-layers"]')).not.toBeNull();
	expect(screen.container.querySelector('.pointer')?.getAttribute('style')).toContain('0deg');
});

// --- preset cards ----------------------------------------------------------------------------

test('preset cards: lamp on the loaded preset, mini curve, name as accessible name', async () => {
	const onload = vi.fn();
	const screen = await render(PresetTabs, { activeId: PADRAO_AURI.id, locale: 'pt-BR', onload });
	const cards = screen.container.querySelectorAll('button.tab');
	expect(cards).toHaveLength(OFFICIAL_PRESETS.length);
	for (const card of cards) {
		expect(card.querySelector('svg.tab-mini path')?.getAttribute('d')).toMatch(/^M0\.0 /);
	}
	const active = page.getByRole('button', { name: PADRAO_AURI.label, exact: true });
	await expect.element(active).toHaveAttribute('aria-pressed', 'true');
	expect(active.element().querySelector('.lamp')?.getAttribute('data-on')).toBe('true');
	expect(screen.container.querySelectorAll('.lamp[data-on="true"]')).toHaveLength(1);
	// Description line: name · description, then credit, licence, preamp and CRC.
	const desc = screen.container.querySelector('.desc')?.textContent ?? '';
	expect(desc).toContain(PADRAO_AURI.label);
	expect(desc).toContain(m.curva_preset_kuba());
	expect(desc).toContain('preamp −2,8 dB');
	expect(desc).toContain('CRC 0x1970');
	expect(screen.container.querySelector('[data-tour="curva-presets"]')).not.toBeNull();
	await page.getByRole('button', { name: OFFICIAL_PRESETS[1]?.label ?? '', exact: true }).click();
	expect(onload).toHaveBeenCalledExactlyOnceWith(OFFICIAL_PRESETS[1]?.id);
});

// --- macros ----------------------------------------------------------------------------------

test('a macro knob drags up and down and proposes once, on release', async () => {
	const onchange = vi.fn();
	const screen = await render(MacroKnobs, {
		values: [0, 0, 0, 0],
		scopes: [{ type: 'sections', count: 2 }],
		locale: 'pt-BR',
		onchange
	});
	const knob = screen.container.querySelector('.knob');
	if (!knob) throw new Error('Missing knob');
	capture(knob);
	// Graduated −6…+6 with labels at −6, −3, 0, +3, +6.
	expect([...knob.querySelectorAll('.grad text')].map((t) => t.textContent)).toEqual([
		'−6',
		'−3',
		'0',
		'+3',
		'+6'
	]);
	pointer(knob, 'pointerdown', { clientY: 200 });
	pointer(knob, 'pointermove', { clientY: 170 });
	await tick();
	expect(screen.container.querySelector('.lcd')?.textContent).toBe('+3,0 dB');
	await expect
		.element(page.getByRole('slider', { name: /Grave/ }))
		.toHaveAttribute('aria-valuetext', '+3,0 dB');
	expect(onchange).not.toHaveBeenCalled();
	pointer(knob, 'pointermove', { clientY: 100 });
	pointer(knob, 'pointerup', { clientY: 100 });
	// Clamped to +6 dB.
	expect(onchange).toHaveBeenCalledExactlyOnceWith(0, 6);
	// A press without travel proposes nothing; a cancelled drag proposes nothing.
	pointer(knob, 'pointerdown', { clientY: 50 });
	pointer(knob, 'pointerup', { clientY: 51 });
	pointer(knob, 'pointerdown', { clientY: 50 });
	pointer(knob, 'pointermove', { clientY: 10 });
	pointer(knob, 'pointercancel', { clientY: 10 });
	expect(onchange).toHaveBeenCalledTimes(1);
	await screen.rerender({ stopped: 0, disabled: true });
	expect(screen.container.querySelector('.macro')?.classList.contains('stopped')).toBe(true);
	pointer(knob, 'pointerdown', { clientY: 50 });
	pointer(knob, 'pointermove', { clientY: 0 });
	pointer(knob, 'pointerup', { clientY: 0 });
	expect(onchange).toHaveBeenCalledTimes(1);
});

// --- filter bank -----------------------------------------------------------------------------

test('bank strips: lamps, envelope strip, technical details and knob drags', async () => {
	const onmove = vi.fn<(index: number, target: DragTarget) => void>();
	const ondrag = vi.fn<(index: number, target: DragTarget) => void>();
	const curve: Curve = withCut;
	const screen = await render(FilterBank, {
		curve,
		verdict: verdictFor(curve),
		layer: 'ajustar',
		locale: 'pt-BR',
		stages: [],
		selected: 0,
		ondrag,
		onmove,
		onkind: vi.fn(),
		onorder: vi.fn()
	});
	const text = screen.container.textContent ?? '';
	expect(text).toContain(m.curva_v2_envelope_title());
	expect(text).not.toMatch(/GATE v2/i);
	expect(text).toContain(m.curva_filter({ index: '1' }));
	// Seven criteria, each lit while it passes.
	expect(screen.container.querySelectorAll('.gaterow li')).toHaveLength(7);
	expect(screen.container.querySelectorAll('.gaterow .lamp[data-on="true"]')).toHaveLength(7);
	// Real sign: the cut lamp of filter 1 is lit, its boost lamp is not.
	const first = screen.container.querySelector('li.module');
	if (!first) throw new Error('Missing strip');
	expect(first.classList.contains('sel')).toBe(true);
	const signs = [...first.querySelectorAll('.sign .lamp')].map((lamp) =>
		lamp.getAttribute('data-on')
	);
	expect(signs).toEqual(['true', 'false']);
	expect(first.querySelector('svg.mini path')).not.toBeNull();
	// Details: closed in Ajustar, seven rows with limits.
	const details = screen.container.querySelector('details.tech');
	expect(details?.hasAttribute('open')).toBe(false);
	expect(details?.querySelectorAll('tbody tr')).toHaveLength(7);
	// The bank's technical words are their own explainers: the strip title, "gate" in the note
	// and the Q label, each named by its visible word and "O que é isso?", with no "?" button.
	const ask = m.fux1_what_is_this();
	for (const word of [m.curva_v2_envelope_title(), 'gate', m.curva_q()]) {
		const trigger = page.getByRole('button', { name: `${word} ${ask}`, exact: true }).first();
		await expect.element(trigger).toHaveAttribute('aria-haspopup', 'dialog');
		expect(trigger.element().textContent).toBe(word);
	}
	expect(screen.container.querySelector('.q-help')).toBeNull();
	const explainers = screen.container.querySelectorAll('button[aria-haspopup="dialog"]');
	expect([...explainers].filter((button) => button.textContent?.includes('?'))).toHaveLength(0);
	// One Q explainer per active strip (only filter 1 is on here); the input keeps its name.
	expect(first.querySelectorAll('button[aria-haspopup="dialog"]')).toHaveLength(1);
	await expect
		.element(page.getByRole('spinbutton', { name: m.curva_q(), exact: true }).first())
		.toHaveValue(1);
	// Freq knob: drag previews every move, proposes once on release.
	const dial = first.querySelector('.kdial');
	if (!dial) throw new Error('Missing knob');
	capture(dial);
	pointer(dial, 'pointerdown', { clientY: 300 });
	pointer(dial, 'pointermove', { clientY: 264 });
	expect(ondrag).toHaveBeenCalledOnce();
	const call = ondrag.mock.calls[0];
	if (!call) throw new Error('No drag preview');
	const [index, target] = call;
	const freq = target.freqHz ?? 0;
	expect(index).toBe(0);
	expect(freq).toBeGreaterThan(1000);
	expect(Number.isInteger(freq)).toBe(true);
	await tick();
	await expect
		.element(page.getByRole('spinbutton', { name: 'Freq (Hz)', exact: true }).first())
		.toHaveValue(freq);
	expect(onmove).not.toHaveBeenCalled();
	pointer(dial, 'pointerup', { clientY: 264 });
	expect(onmove).toHaveBeenCalledExactlyOnceWith(0, { freqHz: freq });
	await screen.rerender({ layer: 'engenharia' });
	expect(screen.container.querySelector('details.tech')?.hasAttribute('open')).toBe(true);
});

test('a failing curve unlights nothing it cannot measure and marks the failing criterion', async () => {
	const curve: Curve = {
		bands: [{ kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 }, ...NEUTRO.bands.slice(1)],
		preampDb: -0.5
	};
	const screen = await render(FilterBank, {
		curve,
		verdict: verdictFor(curve),
		layer: 'ajustar',
		locale: 'pt-BR',
		stages: [],
		onmove: vi.fn(),
		onkind: vi.fn(),
		onorder: vi.fn()
	});
	const failing = screen.container.querySelectorAll('.gaterow li.fail');
	expect(failing.length).toBeGreaterThan(0);
	for (const item of failing) {
		expect(item.querySelector('.lamp')?.classList.contains('lamp--danger')).toBe(true);
		expect(item.textContent).toContain(m.curva_chip_outside());
	}
});

// --- scope: draw-in, safe box, detent, parked points -------------------------------------------

test('the trace draws in once per preset load, never under reduced motion', async () => {
	const { screen } = await scope({ reducedMotion: false });
	expect(screen.container.querySelector('path.tr-eq.draw')).toBeNull();
	await screen.rerender({ drawKey: 1 });
	expect(screen.container.querySelector('path.tr-eq.draw')).not.toBeNull();
	expect(screen.container.querySelector('path.tr-out.draw')).not.toBeNull();
	await screen.rerender({ drawKey: 2, reducedMotion: true });
	expect(screen.container.querySelector('path.draw')).toBeNull();
	expect(screen.container.querySelector('path.tr-eq')?.getAttribute('d')).toMatch(/^M/);
});

test('the safe box lights while a point is grabbed', async () => {
	const { screen, ondrag } = await scope({ selected: 0 });
	const handle = page.getByRole('slider', { name: /^Filtro 1:/ }).element();
	capture(handle);
	expect(screen.container.querySelector('rect.safe.lit')).toBeNull();
	pointer(handle, 'pointerdown');
	await tick();
	expect(screen.container.querySelector('rect.safe.lit')).not.toBeNull();
	pointer(handle, 'pointerup');
	await tick();
	expect(screen.container.querySelector('rect.safe.lit')).toBeNull();
	expect(ondrag).not.toHaveBeenCalled();
});

test('at the boundary: a 120 ms detent and the gate reason in the chip', async () => {
	const { screen } = await scope({ selected: 0 });
	await screen.rerender({ drag: { index: 0, status: 'checking' } });
	expect(screen.container.querySelector('.handle.detent')).toBeNull();
	await screen.rerender({
		drag: { index: 0, status: 'outside' },
		chipReason: 'A banda 1 passaria do limite.'
	});
	await tick();
	expect(screen.container.querySelector('.handle.detent')).not.toBeNull();
	expect(screen.container.querySelector('.chip')?.textContent).toContain(
		'A banda 1 passaria do limite.'
	);
	await vi.waitFor(() => expect(screen.container.querySelector('.handle.detent')).toBeNull(), {
		timeout: 1000
	});
	await screen.rerender({ drag: null });
	expect(screen.container.querySelector('.chip-why')).toBeNull();
});

test('Neutro: ten parked points at 0 dB with the hint; keys or drags create a filter', async () => {
	const { screen, onpark } = await scope({ curve: neutral, committed: neutral });
	await expect.element(page.getByText(m.empty_neutral_body(), { exact: true })).toBeVisible();
	const third = page.getByRole('slider', { name: m.curva_v2_parked({ index: '3' }), exact: true });
	await expect.element(third).toHaveAttribute('aria-valuetext', '400 Hz, 0,0 dB');
	expect(screen.container.querySelectorAll('.handle.parked')).toHaveLength(10);
	// Focus shows the safe box of the filter the point would become.
	const element = third.element();
	if (element instanceof SVGElement) element.focus();
	await vi.waitFor(() => expect(screen.container.querySelector('rect.safe')).not.toBeNull());
	element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
	expect(onpark).toHaveBeenCalledExactlyOnceWith(2, { gainDb: 1 });
	// Pointer: the point follows locally, release asks the page once.
	capture(element);
	pointer(element, 'pointerdown');
	pointer(element, 'pointermove', { clientX: 0, clientY: 0 });
	pointer(element, 'pointerup', { clientX: 0, clientY: 0 });
	expect(onpark).toHaveBeenCalledTimes(2);
	expect(onpark.mock.calls[1]?.[0]).toBe(2);
	// Ouvir: the points and the hint stay, without handles.
	await screen.rerender({ layer: 'ouvir' });
	expect(screen.container.querySelectorAll('.parked-dot')).toHaveLength(10);
	expect(screen.container.querySelector('.handle')).toBeNull();
	expect(screen.container.textContent).toContain(m.empty_neutral_body());
});

test('the preview lever says its state, warms audio on press and A/B explains itself', async () => {
	const onpreviewwarm = vi.fn();
	const onpreview = vi.fn();
	await scope({
		previewCaption: 'desligada · ruído rosa',
		onpreviewwarm,
		onpreview
	});
	const lever = page.getByRole('button', { name: m.curva_preview(), exact: true });
	await expect.element(lever).toHaveAccessibleDescription('desligada · ruído rosa');
	pointer(lever.element(), 'pointerdown');
	expect(onpreviewwarm).toHaveBeenCalledOnce();
	lever.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	expect(onpreviewwarm).toHaveBeenCalledTimes(2);
	await lever.click();
	expect(onpreview).toHaveBeenCalledOnce();
	const ab = page.getByRole('radiogroup', { name: m.curva_ab_label() });
	await expect.element(ab).toHaveAccessibleDescription(m.curva_v2_ab_unavailable());
});

// --- the page --------------------------------------------------------------------------------

test('the four tour anchors exist once each and the trigger opens the Curva tour', async () => {
	const { screen } = await curva('ajustar');
	await tick();
	for (const id of ['curva-layers', 'curva-chart', 'curva-presets', 'curva-write']) {
		expect(screen.container.querySelectorAll(`[data-tour="${id}"]`), id).toHaveLength(1);
	}
	expect(screen.container.querySelector('[data-tour="curva-write"]')?.textContent).toContain(
		m.curva_write()
	);
	// Auto-open is off here (as under automation); the header trigger opens step 1.
	expect(screen.container.textContent).not.toContain(m.tour_curva_layers_title());
	await page.getByRole('button', { name: m.tour_trigger_label() }).click();
	await vi.waitFor(() =>
		expect(screen.container.textContent).toContain(m.tour_curva_layers_title())
	);
});

test('explainers sit next to the technical terms of the page', async () => {
	const { screen } = await curva('ajustar');
	await tick();
	// FUX.B: the bank, the cabinet and the import panel are deferred islands (idle or near the
	// viewport, at the latest after 1.5 s): wait until every placeholder became its panel, so
	// the terms inside them are counted too.
	await expect
		.poll(() => screen.container.querySelectorAll('.deferred[aria-busy="true"]').length, {
			timeout: 5_000
		})
		.toBe(0);
	// "?" buttons are named "O que é isso? <term>"; the bank's inline terms (term variant) are
	// named by their visible word first, then "O que é isso?".
	const triggers = page.getByRole('button', { name: /O que é isso\?/ }).elements();
	// camadas, envelope (scope and bank), A/B, preamp, gate (output and bank), Neutro, Q, código.
	expect(triggers.length).toBeGreaterThanOrEqual(9);
	const bank = screen.container.querySelector('section.bank');
	if (!bank) throw new Error('Missing bank');
	const inBank = triggers.filter((trigger) => bank.contains(trigger));
	const names = inBank.map((trigger) => trigger.textContent);
	// Envelope and gate (plus the Q of each active strip, see the bank test), as inline terms.
	expect(names).toEqual(expect.arrayContaining([m.curva_v2_envelope_title(), 'gate']));
	for (const trigger of inBank) expect(trigger.textContent).not.toContain('?');
});

test('before the client mounts: aria-busy, a loading status and reasons on every action', async () => {
	const { screen } = await curva('ouvir', undefined, -0.5, false);
	expect(screen.container.querySelector('.instrument')?.getAttribute('aria-busy')).toBe('true');
	await expect.element(page.getByText(m.curva_v2_loading(), { exact: true })).toBeInTheDocument();
	for (const name of [m.curva_undo(), m.curva_maxclip(), m.curva_rescue_default()]) {
		await expect
			.element(page.getByRole('button', { name, exact: true }))
			.toHaveAccessibleDescription(m.curva_v2_loading_reason());
	}
	// The meter never waits for a skeleton: DATA at once (plan §3.6).
	expect(screen.container.querySelector('.ps-out .meter')?.getAttribute('data-mode')).toBe('data');
});

test('with a client the rack is live and a parked point becomes a gated filter', async () => {
	const { app, screen } = await curva('ajustar', [...NEUTRO.bands]);
	await tick();
	expect(screen.container.querySelector('.instrument')?.getAttribute('aria-busy')).toBe('false');
	// Point 5 is parked at 1 kHz.
	const fifth = page.getByRole('slider', { name: m.curva_v2_parked({ index: '5' }), exact: true });
	const element = fifth.element();
	if (element instanceof SVGElement) element.focus();
	await userEvent.keyboard('{ArrowDown}');
	await vi.waitFor(() =>
		expect(app?.state.curve.current.bands[4]).toMatchObject({
			kind: 'PK',
			freqHz: 1000,
			gainDb: -1
		})
	);
	expect(app?.pendingWrite).toBeNull();
});

test('loading a preset draws its trace in and throws the matching guard lever', async () => {
	const { app, screen } = await curva('ouvir', [CUT, ...NEUTRO.bands.slice(1)], -3);
	await tick();
	const before = screen.container.querySelector('path.tr-eq');
	await page.getByRole('button', { name: m.curva_rescue_default(), exact: true }).click();
	await tick();
	expect(app?.state.curve.current.source).toBe(`preset:${PADRAO_AURI.id}`);
	expect(screen.container.querySelector('path.tr-eq')).not.toBe(before);
	expect(
		screen.container.querySelectorAll('.guard[data-thrown="true"]'),
		'only the Padrão Auri lever'
	).toHaveLength(1);
	expect(app?.pendingWrite).toBeNull();
});
