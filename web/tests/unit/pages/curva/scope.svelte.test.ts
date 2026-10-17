import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import type { ComponentProps } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { m } from '#lib/paraglide/messages.js';
import ScopePanel from '#lib/components/pages/curva/ScopePanel.svelte';
import { formatSignedDb } from '#lib/components/pages/curva/format.ts';
import type { Curve } from '#lib/components/pages/curva/model.ts';
import { OUTPUT_LIMIT_DB } from '#lib/components/pages/curva/scope.ts';

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

// Mock steps: ←/→ 1/24 octave, ↑/↓ 1 dB, PgUp/PgDn Q ±0.1; Shift ×10, Alt ×0.1.
test.each([
	['ArrowRight', {}, { freqHz: 1029 }],
	['ArrowLeft', {}, { freqHz: 972 }],
	['ArrowRight', { shiftKey: true }, { freqHz: 1335 }],
	['ArrowRight', { altKey: true }, { freqHz: 1003 }],
	['ArrowUp', {}, { gainDb: -2 }],
	['ArrowDown', {}, { gainDb: -4 }],
	['ArrowUp', { shiftKey: true }, { gainDb: 7 }],
	['ArrowUp', { altKey: true }, { gainDb: -2.9 }],
	['PageUp', {}, { qFactor: 1.1 }],
	['PageDown', {}, { qFactor: 0.9 }]
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
	expect(oncommit).toHaveBeenLastCalledWith(1, { freqHz: 51 });
	key(handle.element(), 'PageUp');
	expect(oncommit).toHaveBeenLastCalledWith(1, { qFactor: 0.8 });
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
	await screen.rerender({
		playing: false,
		previewDisabled: true,
		previewReason: 'Engine loading',
		previewError: null
	});
	// Unavailable, but focusable and saying why (T8); a press does nothing.
	const lever = page.getByRole('button', { name: m.curva_preview(), exact: true });
	await expect.element(lever).toHaveAttribute('aria-disabled', 'true');
	await expect.element(lever).toHaveAccessibleDescription('Engine loading');
	// A DOM click: Playwright refuses to click an aria-disabled control, which is the point.
	const leverElement = lever.element();
	if (leverElement instanceof HTMLElement) leverElement.click();
	expect(onpreview).toHaveBeenCalledTimes(2);
	await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
});

test('the approximate-preview note shows only while playing at a rate other than 96 kHz', async () => {
	const { screen } = await setup({ approximate: true });
	// Not playing: no note, even if the engine reports a fallback rate.
	await expect.element(page.getByText(m.curva_approximate())).not.toBeInTheDocument();
	await screen.rerender({ playing: true, approximate: false });
	await expect.element(page.getByText(m.curva_approximate())).not.toBeInTheDocument();
	await screen.rerender({ playing: true, approximate: true });
	const note = page.getByText(m.curva_approximate());
	await expect.element(note).toBeVisible();
	await expect.element(note).toHaveAttribute('role', 'status');
	await screen.rerender({ playing: false, approximate: true });
	await expect.element(page.getByText(m.curva_approximate())).not.toBeInTheDocument();
});

test('the selected section shows its safe box and hard zones; the output limit is always drawn', async () => {
	const { screen } = await setup();
	const text = () => screen.container.textContent ?? '';
	const limit = m.curva_limit_line({ db: formatSignedDb(OUTPUT_LIMIT_DB, 'pt-BR', 2) });
	expect(text()).toContain(limit);
	expect(text()).toContain(m.curva_safe_box());
	expect(text()).toContain(m.curva_hard_limit());
	expect(text()).toContain(m.curva_d7_zone());
	expect(screen.container.querySelector('rect.safe')).not.toBeNull();
	// Focus selects: the HP has a safe strip but no gain zones.
	const hp = page.getByRole('slider', { name: /^Filtro 2:/ }).element();
	if (hp instanceof SVGElement) hp.focus();
	await vi.waitFor(() => expect(text()).not.toContain(m.curva_d7_zone()));
	expect(text()).toContain(m.curva_safe_box());
	await screen.rerender({ layer: 'ouvir' });
	expect(text()).not.toContain(m.curva_safe_box());
	expect(text()).toContain(limit);
});

test('a curve over the output limit is marked where it happens, with its peak', async () => {
	const { screen } = await setup({
		curve: {
			bands: [{ kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 }, ...NEUTRO.bands.slice(1)],
			preampDb: -3
		}
	});
	expect(screen.container.querySelectorAll('rect.zone-hot').length).toBeGreaterThan(0);
	expect(screen.container.querySelector('path.tr-hot')).not.toBeNull();
	expect(screen.container.textContent).toContain(m.curva_hot_output());
	const peak = screen.container.querySelector('.scope-legend .pk')?.textContent ?? '';
	expect(peak).toMatch(/^pico \+/);
	// A comfortable curve has no marked region.
	await screen.rerender({ curve });
	expect(screen.container.querySelector('rect.zone-hot')).toBeNull();
	expect(screen.container.textContent).not.toContain(m.curva_hot_output());
});

test('an advisory refusal colours the handle and the chip; the bubble follows the drag', async () => {
	const { screen } = await setup();
	const handle = page.getByRole('slider', { name: /^Filtro 1:/ }).element();
	vi.spyOn(handle, 'setPointerCapture').mockImplementation(() => undefined);
	const chip = () => screen.container.querySelector('.chip');
	// Without a verdict or an advisory answer the chip claims nothing.
	expect(chip()).toBeNull();
	await screen.rerender({ drag: { index: 0, status: 'checking' } });
	expect(chip()?.getAttribute('data-state')).toBe('checking');
	await screen.rerender({ drag: { index: 0, status: 'outside' } });
	expect(handle.classList.contains('outside')).toBe(true);
	expect(chip()?.getAttribute('data-state')).toBe('outside');
	expect(chip()?.textContent).toContain(m.curva_chip_outside());
	const box = screen.container.querySelector('svg.handles')?.getBoundingClientRect();
	if (!box) throw new Error('Missing handle overlay');
	const pointer = (type: string) =>
		handle.dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				cancelable: true,
				pointerId: 3,
				clientX: box.left + box.width / 2,
				clientY: box.top + box.height / 2
			})
		);
	pointer('pointerdown');
	pointer('pointermove');
	await vi.waitFor(() => expect(screen.container.querySelector('.bubble')).not.toBeNull());
	expect(screen.container.querySelector('.bubble')?.textContent).toBe(
		m.curva_bubble({ freq: '1 kHz', gain: '−3,0 dB', q: '1,00' })
	);
	pointer('pointerup');
	await screen.rerender({ drag: null });
	await vi.waitFor(() => expect(screen.container.querySelector('.bubble')).toBeNull());
	expect(handle.classList.contains('outside')).toBe(false);
});

test('the wheel over an editable handle steps Q and commits after a pause; locked ones ignore it', async () => {
	const { ondrag, oncommit } = await setup({ layer: 'ajustar' });
	const wheel = (name: RegExp, deltaY: number, init: WheelEventInit = {}) =>
		page
			.getByRole('slider', { name })
			.element()
			.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...init }));
	expect(wheel(/^Filtro 1:/, -100)).toBe(false);
	expect(ondrag).toHaveBeenLastCalledWith(0, { qFactor: 1.1 });
	expect(wheel(/^Filtro 1:/, 100, { shiftKey: true })).toBe(false);
	expect(ondrag).toHaveBeenLastCalledWith(0, { qFactor: 0.1 });
	await vi.waitFor(() => expect(oncommit).toHaveBeenCalledExactlyOnceWith(0, { qFactor: 0.1 }));
	ondrag.mockClear();
	expect(wheel(/^Filtro 3:/, -100)).toBe(true);
	expect(ondrag).not.toHaveBeenCalled();
});

test.each([
	[false, true],
	[true, false]
] as const)('reduced motion %s: decorative sweep shown %s', async (reducedMotion, sweep) => {
	const { screen } = await setup({ reducedMotion });
	expect(screen.container.querySelector('.sweep') !== null).toBe(sweep);
	// Real data stays: traces, limit line and handles are drawn either way.
	expect(screen.container.querySelector('path.tr-eq')).not.toBeNull();
	expect(screen.container.querySelector('line.lim')).not.toBeNull();
	expect(page.getByRole('slider', { name: /^Filtro 1:/ }).element()).toBeTruthy();
});
