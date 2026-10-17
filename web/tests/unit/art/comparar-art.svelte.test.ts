import '../primitives/design-system.ts';
import axe from 'axe-core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import ComparArt from '#lib/components/art/ComparArt.svelte';
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

/** Host sections like the cabinet: intro, deck, three panels (tape in the three later gaps). */
const CABINET = [100, 140, 300, 200, 260];

async function mount() {
	const screen = await render(ArtHost, { art: ComparArt, sections: CABINET });
	const layer = screen.container.querySelector<HTMLElement>('.art-layer');
	if (!layer) throw new Error('Missing the Comparar art layer');
	// The sections are read on the first ResizeObserver callback, after layout.
	await expect.poll(() => layer.querySelectorAll('.ca-gap').length).toBe(3);
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
	// Layer, three reels, the sound-on-sound loop and three tape gaps.
	expect(all).toHaveLength(8);
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
	expect(moving.length).toBeGreaterThan(0);
	// Reels, tape runs, the loop draw and the title echoes all really run (an unresolved token
	// would void the shorthand).
	const expected = layer.querySelectorAll('.ca-disc, .ca-tape, .ca-loop, .ca-echo');
	expect(expected.length).toBe(10);
	for (const element of expected) expect(moving).toContain(element);

	reveal(false);
	for (const element of moving) expect(getComputedStyle(element).animationPlayState).toBe('paused');

	reveal();
	vi.spyOn(Document.prototype, 'visibilityState', 'get').mockReturnValue('hidden');
	document.dispatchEvent(new Event('visibilitychange'));
	expect(layer.dataset.art).toBe('paused');
	for (const element of moving) expect(getComputedStyle(element).animationPlayState).toBe('paused');
});

test('echoes the intro plate and runs tape through every gap after the deck', async () => {
	const { screen, layer } = await mount();
	const [intro] = screen.container.querySelectorAll<HTMLElement>('section');
	if (!intro) throw new Error('Missing host sections');
	const echoes = [...layer.querySelectorAll<HTMLElement>('.ca-echo')];
	expect(echoes).toHaveLength(3);
	for (const echo of echoes) {
		expect(echo.style.top).toBe(`${intro.offsetTop}px`);
		expect(echo.style.left).toBe(`${intro.offsetLeft}px`);
		expect(echo.style.width).toBe(`${intro.offsetWidth}px`);
		expect(echo.style.height).toBe(`${intro.offsetHeight}px`);
	}
	for (const gap of layer.querySelectorAll('.ca-gap')) {
		expect(gap.querySelectorAll('.ca-tape')).toHaveLength(1);
	}
	expect(layer.querySelectorAll('.ca-reel')).toHaveLength(3);
	expect(layer.querySelectorAll('.ca-sos .ca-loop')).toHaveLength(1);
});

test('under reduced motion nothing animates and the final frame shows', async () => {
	const { layer } = await mount();
	reveal();
	expect(animated(layer).length).toBeGreaterThan(0);

	const restore = simulateReducedMotion();
	try {
		expect(animated(layer)).toEqual([]);
		const loop = layer.querySelector('.ca-loop');
		if (!loop) throw new Error('Missing the sound-on-sound loop');
		expect(getComputedStyle(loop).strokeDashoffset).toBe('0px');
		expect(getComputedStyle(loop).strokeDasharray).toBe('none');
		// The echo layers rest at their offsets, fully shown.
		const echoes = [...layer.querySelectorAll('.ca-echo')];
		expect(echoes.map((echo) => getComputedStyle(echo).opacity)).toEqual(['1', '1', '1']);
		expect(echoes.map((echo) => getComputedStyle(echo).transform)).toEqual([
			'matrix(1, 0, 0, 1, 5, 4)',
			'matrix(1, 0, 0, 1, 10, 8)',
			'matrix(1, 0, 0, 1, 15, 12)'
		]);
	} finally {
		restore();
	}
});
