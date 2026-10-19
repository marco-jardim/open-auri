// Filter bank above 20 kHz: the FREQ knob and field follow the layer (core `freqMaxFor`): 20 kHz
// in Ajustar; in Engenharia 32 kHz for sections that never amplify and 20 kHz for a boost; Modo
// YOLO 32 kHz for every kind. A strip above 20 kHz is locked outside Engenharia.
import '../../primitives/design-system.ts';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import FilterBank from '#lib/components/pages/curva/FilterBank.svelte';
import { verdictFor, type Band, type Curve } from '#lib/components/pages/curva/model.ts';
import { m } from '#lib/paraglide/messages.js';

const cut: Band = { kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 };
const boost: Band = { kind: 'PK', freqHz: 2000, gainDb: 3, qFactor: 1 };
const lp: Band = { kind: 'LP', freqHz: 18000, qFactor: 0.7 };
const ultra: Band = { kind: 'PK', freqHz: 25000, gainDb: -3, qFactor: 1 };
const curve: Curve = { bands: [cut, boost, lp, ultra, ...NEUTRO.bands.slice(4)], preampDb: -6 };

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

async function setup() {
	const onmove = vi.fn();
	const ondrag = vi.fn();
	const screen = await render(FilterBank, {
		curve,
		verdict: verdictFor(curve),
		layer: 'ajustar',
		locale: 'pt-BR',
		stages: [],
		onmove,
		ondrag,
		onkind: vi.fn(),
		onorder: vi.fn()
	});
	const modules = () => [...screen.container.querySelectorAll('li.module')];
	const freq = (index: number) => {
		const input = modules()[index]?.querySelector<HTMLInputElement>('.kctl input');
		if (!input) throw new Error(`Missing frequency field ${index}`);
		return input;
	};
	return { screen, modules, freq, onmove, ondrag };
}

function type(input: HTMLInputElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

test('the frequency field max follows the layer, the band and Modo YOLO', async () => {
	const { screen, freq } = await setup();
	const max = (index: number) => freq(index).getAttribute('max');
	expect([0, 1, 2].map(max)).toEqual(['20000', '20000', '20000']);
	await screen.rerender({ layer: 'engenharia' });
	expect([0, 1, 2, 3].map(max)).toEqual(['32000', '20000', '32000', '32000']);
	await screen.rerender({ yolo: true });
	expect([0, 1, 2, 3].map(max)).toEqual(['32000', '32000', '32000', '32000']);
	// YOLO exists only in Engenharia.
	await screen.rerender({ layer: 'ajustar' });
	expect([0, 1, 2].map(max)).toEqual(['20000', '20000', '20000']);
});

test('a typed frequency stops at the band limit of the layer', async () => {
	const { screen, freq, onmove } = await setup();
	type(freq(0), '40000');
	expect(onmove).toHaveBeenLastCalledWith(0, { freqHz: 20000 });
	await screen.rerender({ layer: 'engenharia' });
	type(freq(0), '40000');
	expect(onmove).toHaveBeenLastCalledWith(0, { freqHz: 32000 });
	type(freq(1), '25000');
	expect(onmove).toHaveBeenLastCalledWith(1, { freqHz: 20000 });
	await screen.rerender({ yolo: true });
	type(freq(1), '25000');
	expect(onmove).toHaveBeenLastCalledWith(1, { freqHz: 25000 });
});

test('the FREQ knob spans 32 kHz in Engenharia; a boost stops at 20 kHz outside YOLO', async () => {
	const { screen, modules, ondrag } = await setup();
	const turnUp = (index: number, pointerId: number) => {
		const knob = modules()[index]?.querySelector<HTMLElement>('.kdial');
		if (!knob) throw new Error(`Missing knob ${index}`);
		vi.spyOn(knob, 'setPointerCapture').mockImplementation(() => undefined);
		const send = (type: string, clientY: number) =>
			knob.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, clientY }));
		send('pointerdown', 1000);
		send('pointermove', -1000);
		send('pointercancel', -1000);
		return ondrag.mock.lastCall;
	};
	expect(turnUp(0, 1)).toEqual([0, { freqHz: 20000 }]);
	await screen.rerender({ layer: 'engenharia' });
	expect(turnUp(0, 2)).toEqual([0, { freqHz: 32000 }]);
	expect(turnUp(1, 3)).toEqual([1, { freqHz: 20000 }]);
	await screen.rerender({ yolo: true });
	expect(turnUp(1, 4)).toEqual([1, { freqHz: 32000 }]);
});

test('a strip above 20 kHz is locked outside Engenharia, with its own hint', async () => {
	const { screen, modules, freq } = await setup();
	const strip = () => modules()[3];
	expect(strip()?.classList.contains('locked')).toBe(true);
	expect(freq(3).disabled).toBe(true);
	expect(strip()?.textContent).toContain(m.curva_ultra_hint());
	expect(strip()?.textContent).not.toContain(m.curva_exp_hint());
	// The LP strip is locked for its kind, with the experimental hint.
	expect(modules()[2]?.textContent).toContain(m.curva_exp_hint());
	await screen.rerender({ layer: 'engenharia' });
	expect(strip()?.classList.contains('locked')).toBe(false);
	expect(freq(3).disabled).toBe(false);
	expect(strip()?.textContent).not.toContain(m.curva_ultra_hint());
});
