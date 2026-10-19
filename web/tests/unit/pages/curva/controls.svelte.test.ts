import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO, OFFICIAL_PRESETS } from 'open-auri/catalog';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import LayerSelector from '#lib/components/pages/curva/LayerSelector.svelte';
import PresetTabs from '#lib/components/pages/curva/PresetTabs.svelte';
import MacroKnobs from '#lib/components/pages/curva/MacroKnobs.svelte';
import FilterBank from '#lib/components/pages/curva/FilterBank.svelte';
import Cabinet from '#lib/components/pages/curva/Cabinet.svelte';
import { verdictFor, type Band, type Curve } from '#lib/components/pages/curva/model.ts';
import type { Layer } from '#lib/components/pages/curva/layers.ts';
import type { MeterFrame } from '#lib/audio/meters.ts';

const cut: Band = { kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 };
const bands: Band[] = [
	cut,
	{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 },
	{ kind: 'HP', freqHz: 50, qFactor: 0.7 },
	{ kind: 'LP', freqHz: 16000, qFactor: 0.7 },
	...NEUTRO.bands.slice(4)
];
const curve: Curve = { bands, preampDb: -3 };
const frame: MeterFrame = {
	vuL: -2,
	vuR: -3,
	ppmL: -8,
	ppmR: -10,
	truePeakDb: -6,
	lufsM: -17,
	lufsS: -18,
	correlation: 0.9,
	active: true
};

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

function key(element: Element, value: string, modifiers: KeyboardEventInit = {}) {
	return element.dispatchEvent(
		new KeyboardEvent('keydown', {
			key: value,
			bubbles: true,
			cancelable: true,
			...modifiers
		})
	);
}

function inputValue(element: Element, value: string, event = 'change') {
	if (!(element instanceof HTMLInputElement)) throw new Error('Expected input');
	element.value = value;
	element.dispatchEvent(new Event(event, { bubbles: true }));
	return element;
}

test.each([
	['ouvir', 'ArrowRight', 'ajustar'],
	['ajustar', 'ArrowDown', 'engenharia'],
	['engenharia', 'ArrowRight', 'ouvir'],
	['ouvir', 'ArrowLeft', 'engenharia'],
	['ajustar', 'ArrowUp', 'ouvir']
] as const)('%s + %s requests %s', async (layer, arrow, next) => {
	const onlayer = vi.fn();
	const labels: Record<Layer, string> = {
		ouvir: m.curva_layer_ouvir(),
		ajustar: m.curva_layer_ajustar(),
		engenharia: m.curva_layer_engenharia()
	};
	const screen = await render(LayerSelector, { layer, onlayer });
	const selected = page.getByRole('radio', { name: labels[layer], exact: true });
	await expect.element(selected).toHaveAttribute('tabindex', '0');
	expect(key(selected.element(), arrow)).toBe(false);
	expect(onlayer).toHaveBeenLastCalledWith(next);
	await screen.rerender({ layer: next });
	await expect
		.element(page.getByRole('radio', { name: labels[next], exact: true }))
		.toHaveAttribute('aria-checked', 'true');
	expect(key(selected.element(), 'Escape')).toBe(true);
	expect(onlayer).toHaveBeenCalledTimes(1);
});

test.each(['pt-BR', 'en-US'])('preset description focus/pointer paths (%s)', async (locale) => {
	const preset = OFFICIAL_PRESETS[0];
	if (!preset) throw new Error('Missing catalog preset');
	const onload = vi.fn();
	const screen = await render(PresetTabs, { activeId: null, locale, onload });
	const button = page.getByRole('button', { name: preset.label, exact: true });
	const element = button.element();
	expect(screen.container.querySelector('.desc')?.textContent?.trim()).toBe('');
	// Headless Chromium is unfocused: exercise component focus handlers explicitly.
	element.dispatchEvent(new FocusEvent('focus'));
	await tick();
	expect(screen.container.querySelector('.desc')?.textContent).toContain(
		locale.startsWith('en') ? (preset.descriptionEn ?? preset.description) : preset.description
	);
	expect(onload).not.toHaveBeenCalled();
	element.dispatchEvent(new FocusEvent('blur'));
	await tick();
	expect(screen.container.querySelector('.desc')?.textContent?.trim()).toBe('');
	element.dispatchEvent(new PointerEvent('pointerenter'));
	await tick();
	expect(screen.container.querySelector('.desc')?.textContent).toContain(m.curva_preset_license());
	element.dispatchEvent(new PointerEvent('pointerleave'));
	await tick();
	expect(screen.container.querySelector('.desc')?.textContent?.trim()).toBe('');
	await button.click();
	expect(onload).toHaveBeenLastCalledWith(preset.id);
	await screen.rerender({ activeId: preset.id });
	await expect.element(button).toHaveAttribute('aria-pressed', 'true');
});

test('macro draft commits once, then snaps to the accepted prop', async () => {
	const onchange = vi.fn();
	const screen = await render(MacroKnobs, {
		values: [0, 0, 0, 0],
		scopes: [
			{ type: 'sections', count: 1 },
			{ type: 'sections', count: 2 },
			{ type: 'free' },
			{ type: 'none' }
		],
		locale: 'pt-BR',
		onchange
	});
	for (const text of [
		m.curva_macro_section_one(),
		m.curva_macro_sections({ count: '2' }),
		m.curva_macro_free(),
		m.curva_macro_none()
	]) {
		await expect.element(page.getByText(text, { exact: true })).toBeVisible();
	}
	const bass = page.getByRole('slider', { name: /Grave/ });
	const input = inputValue(bass.element(), '6', 'input');
	await tick();
	await expect.element(bass).toHaveAttribute('aria-valuetext', '+6,0 dB');
	expect(onchange).not.toHaveBeenCalled();
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await tick();
	expect(onchange).toHaveBeenCalledExactlyOnceWith(0, 6);
	expect(input.valueAsNumber).toBe(0);
	await expect.element(bass).toHaveAttribute('aria-valuetext', '0,0 dB');
	inputValue(bass.element(), '-6');
	expect(onchange).toHaveBeenLastCalledWith(0, -6);
	await screen.rerender({
		values: [-2, 0, 0, 0],
		scopes: [],
		message: 'Gate boundary',
		disabled: true
	});
	const stopped = page.getByText('Gate boundary', { exact: true });
	await expect.element(stopped).toHaveAttribute('role', 'status');
	await expect.element(stopped).toBeVisible();
	await expect.element(bass).toBeDisabled();
	await expect.element(bass).toHaveAttribute('aria-valuetext', '−2,0 dB');
});

test('bank locks HS/HP/LP in Ajustar and exposes pass filters without gain', async () => {
	const onmove = vi.fn();
	const onkind = vi.fn();
	const onorder = vi.fn();
	const screen = await render(FilterBank, {
		curve,
		verdict: verdictFor(curve),
		layer: 'ajustar',
		locale: 'pt-BR',
		stages: [],
		onmove,
		onkind,
		onorder
	});
	const modules = screen.container.querySelectorAll('li.module');
	for (const index of [1, 2, 3]) {
		const module = modules[index];
		if (!module) throw new Error('Missing experimental module');
		expect(module.classList.contains('locked')).toBe(true);
		for (const field of module.querySelectorAll('input,select')) {
			expect(field).toHaveProperty('disabled', true);
		}
	}
	expect(modules[2]?.querySelectorAll('input').length).toBe(2);
	expect(modules[0]?.querySelectorAll('input').length).toBe(3);
	await screen.rerender({
		layer: 'engenharia',
		message: 'Typed value stopped',
		stages: [
			{ mode: 'live', frame },
			{ mode: 'data', frame: null }
		]
	});
	await expect.element(page.getByText('Typed value stopped')).toBeVisible();
	for (const index of [1, 2, 3]) {
		const module = modules[index];
		if (!module) throw new Error('Missing experimental module');
		expect(module.classList.contains('locked')).toBe(false);
		for (const field of module.querySelectorAll('input')) {
			expect(field).toHaveProperty('disabled', false);
		}
		const kindDial = module.querySelector('.kind-dial [role="spinbutton"]');
		expect(kindDial?.hasAttribute('aria-disabled')).toBe(false);
	}
	// The kind dial (the bank's own gate preflight) steps PK → LS; the bank waits for the page.
	const dial = modules[0]?.querySelector<HTMLElement>('.kind-dial [role="spinbutton"]');
	if (!dial) throw new Error('Missing kind dial');
	dial.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await vi.waitFor(() => expect(onkind).toHaveBeenCalledExactlyOnceWith(0, 'LS'));
	expect(dial.querySelector('.value')?.textContent).toBe('PK');
	expect(dial.hasAttribute('aria-invalid')).toBe(false);
	const freq = page.getByRole('spinbutton', { name: 'Freq (Hz)', exact: true }).first();
	const gain = page.getByRole('spinbutton', { name: 'Ganho (dB)', exact: true }).first();
	const q = page.getByRole('spinbutton', { name: 'Q', exact: true }).first();
	inputValue(freq.element(), '1250');
	inputValue(gain.element(), '-5');
	inputValue(q.element(), '1.5');
	expect(onmove.mock.calls).toEqual([
		[0, { freqHz: 1250 }],
		[0, { gainDb: -5 }],
		[0, { qFactor: 1.5 }]
	]);
	expect(freq.element()).toHaveProperty('valueAsNumber', 1000);
	inputValue(freq.element(), '');
	expect(onmove).toHaveBeenCalledTimes(3);
	// Only engraved stops are ever proposed: unrelated keys on the dial propose nothing.
	for (const name of ['x', 'Tab', 'PageUp']) key(dial, name);
	await tick();
	expect(onkind).toHaveBeenCalledTimes(1);
	await page.getByRole('button', { name: m.curva_order_reset() }).click();
	expect(onorder).toHaveBeenCalledOnce();
});

test('cabinet keyboard boundaries, selection and pointer drops use callbacks', async () => {
	const onselect = vi.fn();
	const onreorder = vi.fn();
	const screen = await render(Cabinet, {
		curve,
		locale: 'pt-BR',
		selected: 0,
		refused: 1,
		message: 'Order refused',
		onselect,
		onreorder
	});
	// Natural-language module names (no plan code): "Filtro 1 PK 1 kHz −3,0 dB".
	const first = page.getByRole('button', { name: /^Filtro 1 PK/ });
	const second = page.getByRole('button', { name: /^Filtro 2 HS/ });
	expect(screen.container.textContent).not.toMatch(/\bS\d+\b/);
	await second.click();
	expect(onselect).toHaveBeenCalledExactlyOnceWith(1);
	key(first.element(), 'ArrowLeft', { altKey: true });
	key(first.element(), 'ArrowRight');
	key(first.element(), 'Enter', { altKey: true });
	expect(onreorder).not.toHaveBeenCalled();
	key(first.element(), 'ArrowRight', { altKey: true });
	key(second.element(), 'ArrowLeft', { altKey: true });
	expect(onreorder.mock.calls).toEqual([
		[0, 1],
		[1, 0]
	]);
	await expect
		.element(page.getByRole('button', { name: m.curva_v2_move_left({ index: '1' }) }))
		.toBeDisabled();
	await expect
		.element(page.getByRole('button', { name: m.curva_v2_move_right({ index: '10' }) }))
		.toBeDisabled();
	const modules = screen.container.querySelectorAll('li.cmod');
	const from = modules[0];
	const to = modules[2];
	if (!from || !to) throw new Error('Missing modules');
	const dataTransfer = new DataTransfer();
	from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
	expect(dataTransfer.getData('text/plain')).toBe('0');
	to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
	await tick();
	expect(to.classList.contains('over')).toBe(true);
	from.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
	await tick();
	expect(to.classList.contains('over')).toBe(true);
	to.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
	await tick();
	expect(to.classList.contains('over')).toBe(false);
	to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
	expect(onreorder).toHaveBeenLastCalledWith(0, 2);
	from.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
	dataTransfer.setData('text/plain', '1');
	to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
	expect(onreorder).toHaveBeenLastCalledWith(1, 2);
	const count = onreorder.mock.calls.length;
	dataTransfer.setData('text/plain', 'invalid');
	to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
	dataTransfer.setData('text/plain', '2');
	to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
	expect(onreorder).toHaveBeenCalledTimes(count);
	expect(modules[1]?.classList.contains('spring')).toBe(true);
	await expect.element(page.getByRole('status')).toHaveTextContent('Order refused');
});
