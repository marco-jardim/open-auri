import '../primitives/design-system.ts';
import axe from 'axe-core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import CurvaArt from '#lib/components/art/CurvaArt.svelte';
import ArtHost from './ArtHost.svelte';
import {
	animated,
	expectDecorative,
	motifs,
	reveal,
	simulateReducedMotion,
	useManualObservers
} from './helpers.ts';

beforeEach(() => useManualObservers());

afterEach(async () => {
	await cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** Host sections: nameplate, rack, lower panels (three gaps: two between, one in the padding). */
async function mount(sections?: number[], gaps = 3) {
	const screen = await render(ArtHost, { art: CurvaArt, sections });
	const layer = screen.container.querySelector<HTMLElement>('.art-layer');
	if (!layer) throw new Error('Missing the Curva art layer');
	// The sections are read on the first ResizeObserver callback, after layout.
	await expect.poll(() => layer.querySelectorAll('.cv-gap').length).toBe(gaps);
	return { screen, layer };
}

test('is decorative: aria-hidden, no pointer events, no text, nothing focusable, axe clean', async () => {
	const { screen, layer } = await mount();
	expectDecorative(layer);
	expect(layer.parentElement?.firstElementChild).toBe(layer);
	const { violations } = await axe.run(screen.container);
	expect(violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')).toEqual(
		[]
	);
});

test('starts paused, runs once seen, pauses off screen and on a hidden tab', async () => {
	const { layer } = await mount();
	const all = motifs(layer);
	expect(all.length).toBeGreaterThan(3);
	for (const motif of all) {
		expect(motif.dataset.art).toBe('paused');
		expect(motif.hasAttribute('data-art-seen')).toBe(false);
	}

	reveal();
	for (const motif of all) {
		expect(motif.dataset.art).toBe('running');
		expect(motif.hasAttribute('data-art-seen')).toBe(true);
	}
	const moving = animated(layer);
	// Each reveal and the lamp really run (an unresolved token would void the shorthand).
	const expected = layer.querySelectorAll('.cv-lamp, .cv-wave path, .cv-cord, .cv-swing, .cv-plug');
	// Lamp 1, wave 1, hero 2 cords + 2 swings + 2 plugs, two cabled gaps × (2 cords + 2 swings).
	expect(expected.length).toBe(16);
	for (const element of expected) expect(moving).toContain(element);

	reveal(false);
	for (const element of moving) expect(getComputedStyle(element).animationPlayState).toBe('paused');

	reveal();
	vi.spyOn(Document.prototype, 'visibilityState', 'get').mockReturnValue('hidden');
	document.dispatchEvent(new Event('visibilitychange'));
	expect(layer.dataset.art).toBe('paused');
	for (const element of moving) expect(getComputedStyle(element).animationPlayState).toBe('paused');
});

test('places a rail in every gap, cables below the rack and the lamp on the deepest module', async () => {
	const { screen, layer } = await mount();
	const sections = () => [...screen.container.querySelectorAll<HTMLElement>('section')];
	const [nameplate, rack] = sections();
	if (!nameplate || !rack) throw new Error('Missing host sections');

	const gaps = [...layer.querySelectorAll<HTMLElement>('.cv-gap')];
	expect(gaps.map((gap) => gap.querySelectorAll('.cv-rail').length)).toEqual([1, 1, 1]);
	expect(gaps.map((gap) => gap.querySelectorAll('.cv-cord').length)).toEqual([0, 2, 2]);
	const between = (nameplate.offsetTop + nameplate.offsetHeight + rack.offsetTop) / 2;
	expect(gaps[0]?.style.top).toBe(`${between}px`);
	expect(layer.querySelector<HTMLElement>('.cv-hero')?.style.height).toBe(`${rack.offsetTop}px`);
	expect(layer.querySelector<HTMLElement>('.cv-lamp-box')?.style.top).toBe(`${rack.offsetTop}px`);

	// Opening a deeper layer adds a module: one more gap, and the lamp moves to it.
	await screen.rerender({ sections: [180, 400, 560, 220] });
	await expect.poll(() => layer.querySelectorAll('.cv-gap').length).toBe(4);
	const bank = sections()[2];
	if (!bank) throw new Error('Missing the added section');
	await expect
		.poll(() => layer.querySelector<HTMLElement>('.cv-lamp-box')?.style.top)
		.toBe(`${bank.offsetTop}px`);
});

test('under reduced motion nothing animates and the final frame shows', async () => {
	const { layer } = await mount();
	reveal();
	expect(animated(layer).length).toBeGreaterThan(0);

	const restore = simulateReducedMotion();
	try {
		expect(animated(layer)).toEqual([]);
		const drawn = layer.querySelectorAll('.cv-draw');
		expect(drawn.length).toBeGreaterThan(0);
		for (const path of drawn) {
			expect(getComputedStyle(path).strokeDashoffset).toBe('0px');
			expect(getComputedStyle(path).strokeDasharray).toBe('none');
		}
		for (const plug of layer.querySelectorAll('.cv-plug')) {
			expect(getComputedStyle(plug).opacity).toBe('1');
		}
	} finally {
		restore();
	}
});
