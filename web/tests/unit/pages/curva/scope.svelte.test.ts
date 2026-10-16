import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import type { ComponentProps } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { m } from '#lib/paraglide/messages.js';
import ScopePanel from '#lib/components/pages/curva/ScopePanel.svelte';
import type { Curve } from '#lib/components/pages/curva/model.ts';

const curve: Curve = {
	bands: [
		{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 },
		{ kind: 'HP', freqHz: 50, qFactor: 0.7 },
		{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 },
		...NEUTRO.bands.slice(3)
	],
	preampDb: -3
};

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

async function setup(overrides: Partial<ComponentProps<typeof ScopePanel>> = {}) {
	const ondrag = vi.fn();
	const oncommit = vi.fn();
	const onpreview = vi.fn();
	const onside = vi.fn();
	const screen = await render(ScopePanel, {
		curve,
		layer: 'engenharia',
		locale: 'pt-BR',
		spectrumMode: 'data',
		analyser: null,
		playing: false,
		side: 'B',
		referenceName: 'Reference',
		ondrag,
		oncommit,
		onpreview,
		onside,
		...overrides
	});
	return { screen, ondrag, oncommit, onpreview, onside };
}

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

test.each([
	['ArrowRight', {}, { freqHz: 1059 }],
	['ArrowLeft', {}, { freqHz: 944 }],
	['ArrowRight', { shiftKey: true }, { freqHz: 1414 }],
	['ArrowRight', { altKey: true }, { freqHz: 1015 }],
	['ArrowUp', {}, { gainDb: -2.5 }],
	['ArrowDown', {}, { gainDb: -3.5 }],
	['ArrowUp', { shiftKey: true }, { gainDb: 0 }],
	['ArrowUp', { altKey: true }, { gainDb: -2.9 }],
	['PageUp', {}, { qFactor: 1.1 }],
	['PageDown', {}, { qFactor: 0.91 }]
] as const)('%s with %j edits one parameter', async (name, modifiers, target) => {
	const { oncommit, ondrag } = await setup();
	const handle = page.getByRole('slider', { name: /^Filtro 1:/ }).element();
	expect(key(handle, name, modifiers)).toBe(false);
	expect(oncommit).toHaveBeenCalledExactlyOnceWith(0, target);
	expect(ondrag).not.toHaveBeenCalled();
});

test('pass filters expose frequency and Q, but ignore gain keys and unrelated keys', async () => {
	const { oncommit } = await setup();
	const handle = page.getByRole('slider', { name: /^Filtro 2:/ });
	key(handle.element(), 'ArrowUp');
	key(handle.element(), 'ArrowDown');
	key(handle.element(), 'Escape');
	expect(oncommit).not.toHaveBeenCalled();
	key(handle.element(), 'ArrowRight');
	expect(oncommit).toHaveBeenLastCalledWith(1, { freqHz: 53 });
	key(handle.element(), 'PageUp');
	expect(oncommit).toHaveBeenLastCalledWith(1, { qFactor: 0.77 });
	await expect.element(handle).toHaveAttribute('aria-valuetext', '50 Hz');
});

test('locked handles reject keyboard and pointer edits; Ouvir omits all edit handles', async () => {
	const { screen, oncommit, ondrag } = await setup({ layer: 'ajustar' });
	for (const index of [2, 3]) {
		const handle = page.getByRole('slider', { name: new RegExp(`^Filtro ${index}:`) });
		await expect.element(handle).toHaveAttribute('aria-disabled', 'true');
		key(handle.element(), 'ArrowRight');
		handle
			.element()
			.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 4 }));
	}
	expect(oncommit).not.toHaveBeenCalled();
	expect(ondrag).not.toHaveBeenCalled();
	await expect.element(page.getByText(m.curva_exp_hint())).toBeVisible();
	await screen.rerender({ layer: 'ouvir' });
	await expect.element(page.getByRole('slider')).not.toBeInTheDocument();
});

test('pointer drags are advisory until release and clamp to visible limits', async () => {
	const { screen, ondrag, oncommit } = await setup();
	const handle = page.getByRole('slider', { name: /^Filtro 1:/ }).element();
	// Synthetic pointers have no capture slot. Handlers and geometry are real.
	vi.spyOn(handle, 'setPointerCapture').mockImplementation(() => undefined);
	const overlay = screen.container.querySelector('svg.handles');
	if (!overlay) throw new Error('Missing handle overlay');
	const box = overlay.getBoundingClientRect();
	const pointer = (type: string, x: number, y: number, pointerId = 7) =>
		handle.dispatchEvent(
			new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, clientX: x, clientY: y })
		);
	pointer('pointermove', box.left, box.top);
	pointer('pointerup', box.left, box.top);
	expect(ondrag).not.toHaveBeenCalled();
	pointer('pointerdown', box.left, box.top);
	pointer('pointermove', box.left, box.top, 8);
	pointer('pointerup', box.left, box.top, 8);
	expect(ondrag).not.toHaveBeenCalled();
	pointer('pointermove', box.left - 100, box.top - 100);
	expect(ondrag).toHaveBeenLastCalledWith(0, { freqHz: 20, gainDb: 9.2 });
	expect(oncommit).not.toHaveBeenCalled();
	pointer('pointermove', box.right + 100, box.bottom + 100);
	expect(ondrag).toHaveBeenLastCalledWith(0, { freqHz: 20000, gainDb: -24 });
	pointer('pointerup', box.right, box.bottom);
	expect(oncommit).toHaveBeenCalledExactlyOnceWith(0, { freqHz: 20000, gainDb: -24 });
	pointer('pointerdown', box.left, box.top);
	pointer('pointerup', box.left, box.top);
	expect(oncommit).toHaveBeenCalledTimes(1);
});

test('pass-filter pointer drags never propose a gain', async () => {
	const { ondrag, oncommit } = await setup();
	const handle = page.getByRole('slider', { name: /^Filtro 2:/ }).element();
	vi.spyOn(handle, 'setPointerCapture').mockImplementation(() => undefined);
	for (const type of ['pointerdown', 'pointermove', 'pointercancel']) {
		handle.dispatchEvent(
			new PointerEvent(type, { bubbles: true, pointerId: 7, clientX: 0, clientY: 0 })
		);
	}
	expect(ondrag).toHaveBeenCalledExactlyOnceWith(1, { freqHz: 20 });
	expect(oncommit).toHaveBeenCalledExactlyOnceWith(1, { freqHz: 20 });
});

test('preview controls expose playback, A/B, errors and disablement', async () => {
	const { screen, onpreview, onside } = await setup();
	const reference = page.getByRole('radio', { name: m.curva_ab_a({ name: 'Reference' }) });
	await expect.element(reference).toBeDisabled();
	await page.getByRole('button', { name: m.curva_preview(), exact: true }).click();
	expect(onpreview).toHaveBeenCalledOnce();
	await screen.rerender({
		playing: true,
		side: 'A',
		message: 'Gate stopped',
		previewError: 'Audio blocked'
	});
	await expect.element(page.getByRole('alert')).toHaveTextContent('Audio blocked');
	await expect.element(page.getByText('Gate stopped')).toBeVisible();
	await expect.element(reference).toHaveAttribute('aria-checked', 'true');
	await page.getByRole('radio', { name: m.curva_ab_b() }).click();
	await page.getByRole('radio', { name: m.curva_ab_a({ name: 'Reference' }) }).click();
	expect(onside.mock.calls).toEqual([['B'], ['A']]);
	await page.getByRole('button', { name: m.curva_preview_stop(), exact: true }).click();
	expect(onpreview).toHaveBeenCalledTimes(2);
	await screen.rerender({ playing: false, previewDisabled: true, previewError: null });
	await expect
		.element(page.getByRole('button', { name: m.curva_preview(), exact: true }))
		.toBeDisabled();
	await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
});
