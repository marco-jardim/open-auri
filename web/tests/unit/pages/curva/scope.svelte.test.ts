import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import type { ComponentProps } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { m } from '#lib/paraglide/messages.js';
import ScopePanel from '#lib/components/pages/curva/ScopePanel.svelte';
import { formatSignedDb } from '#lib/components/pages/curva/format.ts';
import type { DragTarget } from '#lib/components/pages/curva/drag.ts';
import type { Curve } from '#lib/components/pages/curva/model.ts';
import {
	DRAG_GRID,
	F_MAX,
	OUTPUT_LIMIT_DB,
	PLOT,
	SCOPE_GRID,
	xOf,
	yOf
} from '#lib/components/pages/curva/scope.ts';
import { CURVA_SESSION } from '#lib/components/pages/curva/preview.svelte.ts';
import { approximatedSections, createAudioEngine, skippedSections } from '#lib/audio/engine.ts';
import { fakeEnv, resetAudioConfig } from '../../audio/fake-audio.ts';
import '../../primitives/design-system.ts';

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
	resetAudioConfig();
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
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
	expect(key(handle, name, modifiers)).toBe(false);
	expect(oncommit).toHaveBeenCalledExactlyOnceWith(0, target);
	expect(ondrag).not.toHaveBeenCalled();
});

test('pass filters expose frequency and Q, but ignore gain keys and unrelated keys', async () => {
	const { oncommit } = await setup();
	const handle = page.getByRole('slider', { name: /^Filtro B,/ });
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
	for (const badge of ['B', 'C']) {
		const handle = page.getByRole('slider', { name: new RegExp(`^Filtro ${badge},`) });
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
	// Only the handles go; the Transport's seek bar (SEEK.2) stays.
	await expect.element(page.getByRole('slider', { name: /^Filtro / })).not.toBeInTheDocument();
});

test('pointer drags are advisory until release and clamp to visible limits', async () => {
	const { screen, ondrag, oncommit } = await setup();
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
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
	// Engenharia: a cut goes on to 32 kHz (`freqMaxFor`); a boost stops at 20 kHz.
	pointer('pointermove', box.right + 100, box.bottom + 100);
	expect(ondrag).toHaveBeenLastCalledWith(0, { freqHz: 32000, gainDb: -24 });
	pointer('pointermove', box.right + 100, box.top + 10);
	expect(ondrag).toHaveBeenLastCalledWith(0, expect.objectContaining({ freqHz: 20000 }));
	pointer('pointermove', box.right + 100, box.bottom + 100);
	pointer('pointerup', box.right, box.bottom);
	expect(oncommit).toHaveBeenCalledExactlyOnceWith(0, { freqHz: 32000, gainDb: -24 });
	pointer('pointerdown', box.left, box.top);
	pointer('pointerup', box.left, box.top);
	expect(oncommit).toHaveBeenCalledTimes(1);
});

test('pass-filter pointer drags never propose a gain', async () => {
	const { ondrag, oncommit } = await setup();
	const handle = page.getByRole('slider', { name: /^Filtro B,/ }).element();
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
	// No session: unavailable but focusable, saying why (T8); a press does nothing.
	await expect.element(reference).toHaveAttribute('aria-disabled', 'true');
	await expect.element(reference).not.toHaveAttribute('disabled');
	await expect.element(reference).toHaveAccessibleDescription(m.curva_v2_ab_unavailable());
	(reference.element() as HTMLElement).click();
	expect(onside).not.toHaveBeenCalled();
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

test('paused, A/B still switches and the lever says "Continuar"; stopped, A/B says why', async () => {
	const { screen, onpreview, onside } = await setup({ playing: false, paused: true, side: 'B' });
	// The paused preview keeps its chains (CurvaPreview.select works while paused).
	const lever = page.getByRole('button', { name: m.transport_toggle_resume(), exact: true });
	await expect.element(lever).toBeVisible();
	await expect.element(lever).toHaveAttribute('aria-pressed', 'false');
	const reference = page.getByRole('radio', { name: m.curva_ab_a({ name: 'Reference' }) });
	const editor = page.getByRole('radio', { name: m.curva_ab_b() });
	await expect.element(reference).not.toHaveAttribute('aria-disabled');
	await expect.element(reference).not.toHaveAttribute('aria-describedby');
	await expect.element(page.getByText(m.curva_v2_ab_unavailable())).not.toBeInTheDocument();
	await reference.click();
	(editor.element() as HTMLElement).focus();
	await userEvent.keyboard('{Enter}');
	expect(onside.mock.calls).toEqual([['A'], ['B']]);
	await lever.click();
	expect(onpreview).toHaveBeenCalledOnce();

	// Playing keeps the stop label (e2e offline.spec.ts selects "Parar prévia").
	await screen.rerender({ playing: true, paused: false });
	await expect
		.element(page.getByRole('button', { name: m.curva_preview_stop(), exact: true }))
		.toBeVisible();

	// No session at all: nothing to switch. aria-disabled with the reason; click and Enter do nothing.
	await screen.rerender({ playing: false, paused: false });
	await expect
		.element(page.getByRole('button', { name: m.curva_preview(), exact: true }))
		.toBeVisible();
	for (const tab of [reference, editor]) {
		await expect.element(tab).toHaveAttribute('aria-disabled', 'true');
		await expect.element(tab).toHaveAccessibleDescription(m.curva_v2_ab_unavailable());
		(tab.element() as HTMLElement).click();
		(tab.element() as HTMLElement).focus();
		await userEvent.keyboard('{Enter}');
	}
	expect(onside).toHaveBeenCalledTimes(2);
});

test('the compact Transport renders and starts through the lever, resuming only Curva', async () => {
	const engine = createAudioEngine(fakeEnv(null).env);
	try {
		const { onpreview } = await setup({ engine });
		const transport = page.getByRole('group', { name: m.transport_group() });
		await expect.element(transport).toBeVisible();
		await expect
			.element(transport.getByRole('slider', { name: m.transport_seek() }))
			.toBeInTheDocument();
		// Nothing paused: Transport play is the page's own start (A/B, level match).
		const play = transport.getByRole('button', { name: m.transport_play(), exact: true });
		await play.click();
		expect(onpreview).toHaveBeenCalledOnce();

		// A paused Curva session: play continues it in the engine, without a new start.
		const chain = engine.buildChain(NEUTRO.bands, 0);
		await engine.start('chains', { startAt: 'random', session: CURVA_SESSION });
		engine.pause();
		const resume = vi.spyOn(engine, 'resume');
		const cont = transport.getByRole('button', { name: m.transport_resume(), exact: true });
		await cont.click();
		await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
		expect(onpreview).toHaveBeenCalledOnce();
		expect(engine.state()).toMatchObject({ playing: true, session: CURVA_SESSION });
		chain.dispose();
	} finally {
		await engine.dispose();
	}
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
	const hp = page.getByRole('slider', { name: /^Filtro B,/ }).element();
	if (hp instanceof SVGElement) hp.focus();
	await vi.waitFor(() => expect(text()).not.toContain(m.curva_d7_zone()));
	expect(text()).toContain(m.curva_safe_box());
	await screen.rerender({ layer: 'ouvir' });
	expect(text()).not.toContain(m.curva_safe_box());
	expect(text()).toContain(limit);
});

test.each([390, 1440, 1920])(
	'Neutro: the limit label clears all parked handles at %i px',
	async (width) => {
		const viewport = { width: innerWidth, height: innerHeight };
		try {
			await page.viewport(width, 1000);
			const { screen } = await setup({ curve: NEUTRO, reducedMotion: true });
			await document.fonts.ready;
			for (const layer of ['engenharia', 'ajustar', 'ouvir'] as const) {
				await screen.rerender({ layer });
				const label = screen.container.querySelector<HTMLElement>('.lim-t');
				const limit = screen.container.querySelector<SVGLineElement>('line.lim');
				const plot = screen.container.querySelector('svg.scope');
				const handles = [...screen.container.querySelectorAll('.handle.parked, .parked-dot')];
				if (!label || !limit || !plot) throw new Error('Missing the output limit');
				expect(handles).toHaveLength(10);
				expect(label.textContent?.trim()).toBe(
					m.curva_limit_line({ db: formatSignedDb(OUTPUT_LIMIT_DB, 'pt-BR', 2) })
				);
				// Only the caption moves: the gate threshold and the plot's line endpoints stay exact.
				expect(limit.getAttribute('x1')).toBe(String(PLOT.left));
				// The audible limit ends at 20 kHz; the shaded axis continues to 48 kHz.
				expect(limit.getAttribute('x2')).toBe(String(xOf(F_MAX)));
				expect(limit.getAttribute('y1')).toBe(String(yOf(OUTPUT_LIMIT_DB)));
				expect(limit.getAttribute('y2')).toBe(String(yOf(OUTPUT_LIMIT_DB)));
				await expect
					.poll(() => {
						const box = label.getBoundingClientRect();
						if (!box.width || !box.height) return false;
						if (box.bottom > plot.getBoundingClientRect().top) return false;
						return handles.every((handle) => {
							// Includes the transparent hit target, not just the visible numbered ring.
							const point = handle.getBoundingClientRect();
							return (
								point.width > 0 &&
								point.height > 0 &&
								(box.right <= point.left ||
									box.left >= point.right ||
									box.bottom <= point.top ||
									box.top >= point.bottom)
							);
						});
					})
					.toBe(true);
			}
		} finally {
			await page.viewport(viewport.width, viewport.height);
		}
	}
);

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
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
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

test('while a point moves the screen drops its blurred effects; at rest they all come back', async () => {
	const { screen } = await setup({ reducedMotion: false });
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
	vi.spyOn(handle, 'setPointerCapture').mockImplementation(() => undefined);
	const part = (selector: string) => {
		const element = screen.container.querySelector(selector);
		if (!element) throw new Error(`Missing ${selector}`);
		return element;
	};
	const section = part('section.ps-scope');
	const glass = part('.screen');
	const plot = part('svg.scope');
	const live = part('svg.scope-live');
	const eq = part('path.tr-eq');
	const ring = part('.handle.sel .ring');
	const sweep = part('rect.sweep');
	const filter = (element: Element) => getComputedStyle(element).filter;
	const points = (path: Element) => (path.getAttribute('d') ?? '').split('L').length;
	// The live layer lies exactly over the static plot, and draws on top of it.
	expect(live.getBoundingClientRect().toJSON()).toEqual(plot.getBoundingClientRect().toJSON());
	expect(plot.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	const resting = { eq: eq.getAttribute('d'), points: points(eq) };
	expect(resting.points).toBe(SCOPE_GRID.length);
	const expectAtRest = () => {
		expect(section.hasAttribute('data-dragging')).toBe(false);
		// Phosphor glow on the EQ trace and the selected handle's shadow, the sweep running, the
		// glass over the screen, everything in one layer, every trace at full resolution.
		expect(filter(eq)).toMatch(/^url\(/);
		expect(filter(ring)).toContain('drop-shadow');
		expect(getComputedStyle(sweep).animationPlayState).toBe('running');
		expect(getComputedStyle(glass, '::after').visibility).toBe('visible');
		expect(getComputedStyle(live).willChange).toBe('auto');
		expect(eq.getAttribute('d')).toBe(resting.eq);
	};
	expectAtRest();
	const box = part('svg.handles').getBoundingClientRect();
	const pointer = (type: string) =>
		handle.dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				cancelable: true,
				pointerId: 5,
				clientX: box.left + box.width / 2,
				clientY: box.top + box.height / 2
			})
		);
	pointer('pointerdown');
	pointer('pointermove');
	await vi.waitFor(() => expect(section.hasAttribute('data-dragging')).toBe(true));
	const lit = part('rect.safe.lit');
	expect(filter(eq)).toBe('none');
	expect(filter(ring)).toBe('none');
	expect(filter(lit)).toBe('none');
	expect(getComputedStyle(sweep).animationPlayState).toBe('paused');
	expect(getComputedStyle(glass, '::after').visibility).toBe('hidden');
	expect(getComputedStyle(live).contain).toBe('strict');
	// The moving traces use half the points (DRAG_GRID).
	await vi.waitFor(() => expect(points(eq)).toBe(DRAG_GRID.length));
	// The readouts are unchanged: the bubble still follows the handle.
	expect(screen.container.querySelector('.bubble')).not.toBeNull();
	pointer('pointerup');
	await vi.waitFor(() => expect(section.hasAttribute('data-dragging')).toBe(false));
	// On release the resting state is exactly the one before the drag.
	expectAtRest();
});

test('the wheel over an editable handle steps Q and commits after a pause; locked ones ignore it', async () => {
	const { ondrag, oncommit } = await setup({ layer: 'ajustar' });
	const wheel = (name: RegExp, deltaY: number, init: WheelEventInit = {}) =>
		page
			.getByRole('slider', { name })
			.element()
			.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...init }));
	expect(wheel(/^Filtro A,/, -100)).toBe(false);
	expect(ondrag).toHaveBeenLastCalledWith(0, { qFactor: 1.1 });
	expect(wheel(/^Filtro A,/, 100, { shiftKey: true })).toBe(false);
	expect(ondrag).toHaveBeenLastCalledWith(0, { qFactor: 0.1 });
	await vi.waitFor(() => expect(oncommit).toHaveBeenCalledExactlyOnceWith(0, { qFactor: 0.1 }));
	ondrag.mockClear();
	expect(wheel(/^Filtro C,/, -100)).toBe(true);
	expect(ondrag).not.toHaveBeenCalled();
});

// --- above 20 kHz (Engenharia up to 32 kHz for cuts, Modo YOLO for every kind) ----------------

const boost: Curve = {
	bands: [{ kind: 'PK', freqHz: 1000, gainDb: 3, qFactor: 1 }, ...NEUTRO.bands.slice(1)],
	preampDb: -6
};
const ultraCut: Curve = {
	bands: [
		{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 },
		{ kind: 'PK', freqHz: 25000, gainDb: -3, qFactor: 1 },
		...NEUTRO.bands.slice(2)
	],
	preampDb: -3
};
const valueMax = (badge: string) =>
	page
		.getByRole('slider', { name: new RegExp(`^Filtro ${badge},`) })
		.element()
		.getAttribute('aria-valuemax');

test('handle frequency limits follow the layer, the band and Modo YOLO', async () => {
	const { screen } = await setup({ layer: 'ajustar' });
	expect(valueMax('A')).toBe('20000');
	await screen.rerender({ layer: 'engenharia' });
	// Sections that never amplify: PK cut, HP Q 0.7, HS cut Q 0.7.
	for (const badge of ['A', 'B', 'C']) expect(valueMax(badge)).toBe('32000');
	await screen.rerender({ curve: boost });
	expect(valueMax('A')).toBe('20000');
	await screen.rerender({ yolo: true });
	expect(valueMax('A')).toBe('32000');
	// YOLO exists only in Engenharia: elsewhere 20 kHz still.
	await screen.rerender({ layer: 'ajustar' });
	expect(valueMax('A')).toBe('20000');
});

test('pointer and keys clamp a boost at 20 kHz in Engenharia; YOLO lets it reach 32 kHz', async () => {
	const { screen, ondrag, oncommit } = await setup({ curve: boost });
	const overlay = screen.container.querySelector('svg.handles');
	if (!overlay) throw new Error('Missing handle overlay');
	const box = overlay.getBoundingClientRect();
	// Far right, well above 0 dB (the top part of the plot).
	const clientY = box.top + box.height * 0.15;
	const dragRight = (pointerId: number): DragTarget => {
		const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
		vi.spyOn(handle, 'setPointerCapture').mockImplementation(() => undefined);
		const send = (type: string, clientX: number) =>
			handle.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, clientX, clientY }));
		send('pointerdown', box.left);
		send('pointermove', box.right + 100);
		send('pointercancel', box.right + 100);
		return ondrag.mock.lastCall?.[1] ?? {};
	};
	const engenharia = dragRight(3);
	expect(engenharia.freqHz).toBe(20000);
	expect(engenharia.gainDb).toBeGreaterThan(0);
	await screen.rerender({ yolo: true });
	const yolo = dragRight(4);
	expect(yolo.freqHz).toBe(32000);
	expect(yolo.gainDb).toBeGreaterThan(0);
	oncommit.mockClear();
	const near: Curve = {
		...boost,
		bands: [{ kind: 'PK', freqHz: 19990, gainDb: 3, qFactor: 1 }, ...boost.bands.slice(1)]
	};
	await screen.rerender({ yolo: false, curve: near });
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
	key(handle, 'ArrowRight', { shiftKey: true });
	expect(oncommit).toHaveBeenLastCalledWith(0, { freqHz: 20000 });
});

test('Engenharia hatches the 20–32 kHz boost zone (not in YOLO) and 32–48 kHz as never editable', async () => {
	const { screen } = await setup();
	const text = () => screen.container.textContent ?? '';
	const noEdit = () => screen.container.querySelector('[data-testid="scope-noedit"]');
	expect(text()).toContain(m.curva_ultra_zone());
	expect(screen.container.querySelector('[data-zone="ultra-boost"]')).not.toBeNull();
	expect(noEdit()?.getAttribute('x')).toBe(String(xOf(32000)));
	await screen.rerender({ yolo: true });
	await vi.waitFor(() => expect(text()).not.toContain(m.curva_ultra_zone()));
	expect(noEdit()).not.toBeNull();
	await screen.rerender({ yolo: false, layer: 'ajustar' });
	expect(text()).not.toContain(m.curva_ultra_zone());
	expect(noEdit()).toBeNull();
});

test('bands above 20 kHz are locked outside Engenharia, with a hint', async () => {
	const { screen, oncommit } = await setup({ curve: ultraCut, layer: 'ajustar' });
	const ultra = page.getByRole('slider', { name: /^Filtro B,/ });
	await expect.element(ultra).toHaveAttribute('aria-disabled', 'true');
	key(ultra.element(), 'ArrowLeft');
	expect(oncommit).not.toHaveBeenCalled();
	await expect.element(page.getByText(m.curva_ultra_hint())).toBeVisible();
	await screen.rerender({ layer: 'engenharia' });
	await expect.element(ultra).toHaveAttribute('aria-disabled', 'false');
	await expect.element(page.getByText(m.curva_ultra_hint())).not.toBeInTheDocument();
	key(ultra.element(), 'ArrowLeft');
	expect(oncommit).toHaveBeenCalledExactlyOnceWith(1, {
		freqHz: Math.round(25000 * 2 ** (-1 / 24))
	});
});

test('away from 96 kHz the preview notes count the filters above 20 kHz skipped and approximated', async () => {
	const { screen } = await setup({ curve: ultraCut, committed: ultraCut, playing: true });
	const skip = () => screen.container.querySelector('[data-testid="ultra-skip"]');
	const approx = () => screen.container.querySelector('[data-testid="ultra-approx"]');
	expect(skip()).toBeNull();
	expect(approx()).toBeNull();
	// The 25 kHz cut lowers the top of the audible band on the chip: approximated, not skipped.
	expect(approximatedSections(ultraCut.bands, 48000)).toBe(1);
	await screen.rerender({ approximate: true, rate: 48000 });
	await expect.element(page.getByText(m.qa1y_ultra_approximated_one())).toBeVisible();
	await expect.element(page.getByText(m.curva_approximate())).toBeVisible();
	expect(skip()).toBeNull();
	// An inaudible one (−0,2 dB at 30 kHz) is skipped, with its own note next to it.
	const both: Curve = {
		...ultraCut,
		bands: ultraCut.bands.map((band, index) =>
			index === 2 ? { kind: 'PK' as const, freqHz: 30000, gainDb: -0.2, qFactor: 1 } : band
		)
	};
	expect(skippedSections(both.bands, 48000)).toBe(1);
	await screen.rerender({ curve: both, committed: both });
	await expect.element(page.getByText(m.curva_ultra_skipped_one())).toBeVisible();
	await expect.element(page.getByText(m.qa1y_ultra_approximated_one())).toBeVisible();
	// A plays the reference (nothing above 20 kHz there): no count.
	await screen.rerender({ side: 'A', reference: curve });
	expect(skip()).toBeNull();
	expect(approx()).toBeNull();
	// The page's own counts win.
	await screen.rerender({ skipped: 3, approximated: 2 });
	await expect
		.element(page.getByText(m.curva_ultra_skipped({ count: '3' })))
		.toHaveAttribute('role', 'status');
	await expect
		.element(page.getByText(m.qa1y_ultra_approximated({ count: '2' })))
		.toHaveAttribute('role', 'status');
	await screen.rerender({ playing: false });
	expect(skip()).toBeNull();
	expect(approx()).toBeNull();
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
	expect(page.getByRole('slider', { name: /^Filtro A,/ }).element()).toBeTruthy();
});
