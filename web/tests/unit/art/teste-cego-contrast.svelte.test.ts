// FUX.ART.3: no text of the Teste cego page may sit under its art. The scene part lives inside
// the stage's aperture, over the curtain and under the lamps, the bays and the call to action,
// so every text of the stage paints above it; the title stands beside or above the stage, clear
// of it; the page part takes the desk's grid area, and only its motif boxes rise above the wood,
// inside the desk padding and the side gutters. Measured on the real page (BlindTest with both
// parts, on screen and running) at three widths:
// - no rendered text box intersects a raised motif box;
// - axe's color-contrast finds no violation, and every axe result (passes and incomplete) is the
//   same with both art layers removed: the art neither lowers a pair nor hides text from axe.
// - the title is measured from real pixels too: screenshots of the h1's box with its own paint
//   removed keep the h1 colour at AA (4.5:1), with the art, without it, and even with every art
//   paint raised to full opacity, because no art lies under the title any more.
import axe from 'axe-core';
import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
import '../primitives/design-system.ts';

afterEach(async () => {
	await cleanup();
	await page.viewport(1440, 900);
});

async function colorContrast(container: HTMLElement) {
	const result = await axe.run(container, {
		runOnly: { type: 'rule', values: ['color-contrast'] }
	});
	const targets = (rules: typeof result.passes) =>
		rules.flatMap((rule) => rule.nodes.map((node) => node.target.join(' '))).sort();
	return {
		violations: result.violations,
		passes: targets(result.passes),
		incomplete: targets(result.incomplete)
	};
}

/**
 * Text that cannot sit under the art: visually hidden on purpose (sr-only clip), or inside a
 * popover (tooltips render in the top layer, above everything, or not at all when closed).
 */
function clipped(element: Element, root: Element): boolean {
	if (element.closest('[popover]')) return true;
	for (let node: Element | null = element; node && node !== root; node = node.parentElement) {
		if (getComputedStyle(node).clipPath !== 'none') return true;
	}
	return false;
}

/** The boxes of every rendered, non-blank text run under `root`. */
function textBoxes(root: Element): Array<{ text: string; box: DOMRect }> {
	const boxes: Array<{ text: string; box: DOMRect }> = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node.textContent?.trim() ?? '';
		const parent = node.parentElement;
		if (text === '' || !parent || clipped(parent, root)) continue;
		range.selectNodeContents(node);
		for (const box of range.getClientRects()) {
			if (box.width > 0 && box.height > 0) boxes.push({ text, box });
		}
	}
	return boxes;
}

const overlaps = (a: DOMRect, b: DOMRect) =>
	a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// ---- Pixel contrast of the title over the scene (WCAG 2.x relative luminance) ------------------

const CONTRAST_AA = 4.5;
/**
 * The lightest 1 % of the h1's box is left out: anti-aliased edges and a 3 to 6 px light mote
 * passing by. Anything with an area (the curtain ripple, the polar grid, a lobe) is measured.
 */
const TAIL = 0.01;

function channel(value: number): number {
	const c = value / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(r: number, g: number, b: number): number {
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a: number, b: number): number {
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function context2d(width: number, height: number): OffscreenCanvasRenderingContext2D {
	const context = new OffscreenCanvas(width, height).getContext('2d');
	if (!context) throw new Error('No 2D canvas');
	return context;
}

/** Luminance of any CSS colour, resolved by the browser (rgb, hex, color-mix, oklch...). */
function colorLuminance(color: string): number {
	const context = context2d(1, 1);
	context.fillStyle = color;
	context.fillRect(0, 0, 1, 1);
	const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
	return luminance(r, g, b);
}

function base64Of(shot: unknown): string {
	if (typeof shot === 'string') return shot;
	if (shot && typeof shot === 'object' && 'base64' in shot && typeof shot.base64 === 'string') {
		return shot.base64;
	}
	throw new Error('The screenshot returned no base64 image');
}

/** Everything painted in `element`'s box right now, as RGBA bytes (a real screenshot). */
async function paintedPixels(element: HTMLElement): Promise<Uint8ClampedArray> {
	await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
	const shot: unknown = await page.screenshot({ element, base64: true, save: false });
	const blob = await (await fetch(`data:image/png;base64,${base64Of(shot)}`)).blob();
	const bitmap = await createImageBitmap(blob);
	const context = context2d(bitmap.width, bitmap.height);
	context.drawImage(bitmap, 0, 0);
	bitmap.close();
	return context.getImageData(0, 0, context.canvas.width, context.canvas.height).data;
}

/** Contrast of a text luminance against the backdrop pixels, at the worst tail (TAIL left out). */
function worstContrast(text: number, pixels: Uint8ClampedArray): number {
	const ratios: number[] = [];
	for (let i = 0; i + 2 < pixels.length; i += 4) {
		ratios.push(ratio(text, luminance(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0)));
	}
	expect(ratios.length, 'the screenshot of the title is empty').toBeGreaterThan(100);
	ratios.sort((a, b) => a - b);
	return ratios[Math.floor(ratios.length * TAIL)] ?? 0;
}

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
	{ width: 1920, height: 1080 }
] as const) {
	test(`no text under the art and AA kept, with and without it, at ${viewport.width} px`, async () => {
		await page.viewport(viewport.width, viewport.height);
		const screen = await render(BlindTest, { reducedMotion: true });
		const heading = page.getByRole('heading', { level: 1 });
		await expect.element(heading).toBeVisible();

		const root = screen.container.querySelector<HTMLElement>('.blind-test');
		const pageLayer = root?.querySelector<HTMLElement>(':scope > .art-layer');
		const stage = root?.querySelector<HTMLElement>('.room .stage');
		const aperture = stage?.querySelector<HTMLElement>('.aperture');
		const sceneLayer = aperture?.querySelector<HTMLElement>(':scope > .art-layer');
		if (!root || !pageLayer || !stage || !aperture || !sceneLayer) {
			throw new Error('Missing an art layer');
		}
		const layers = [pageLayer, sceneLayer];
		for (const layer of layers) {
			const style = getComputedStyle(layer);
			expect(style.zIndex).toBe('auto');
			expect(style.pointerEvents).toBe('none');
			expect(style.display).not.toBe('none');
			// The real observer reports it on screen: the art is drawn and animating while measured.
			await expect.poll(() => layer.dataset.art).toBe('running');
		}

		// The scene part sits right above the curtain's valance and right under the lamps, so the
		// bays, the plates and the call to action paint after it; the title is not in the stage.
		expect(sceneLayer.previousElementSibling?.classList.contains('valance')).toBe(true);
		expect(sceneLayer.nextElementSibling?.classList.contains('lamps')).toBe(true);
		expect(stage.contains(heading.element())).toBe(false);
		// The title is not displaced by the stage nor painted over it: their boxes never meet.
		const title = heading.element().getBoundingClientRect();
		const box = stage.getBoundingClientRect();
		expect(overlaps(title, box)).toBe(false);
		expect(overlaps(title, sceneLayer.getBoundingClientRect())).toBe(false);

		// Only the page part's motif boxes rise above the content; none of them covers text.
		const raised = [...pageLayer.querySelectorAll('.art-motif')]
			.filter((motif) => getComputedStyle(motif).zIndex !== 'auto')
			.map((motif) => motif.getBoundingClientRect())
			.filter((box) => box.width > 0 && box.height > 0);
		expect(raised.length).toBeGreaterThanOrEqual(2);
		const texts = textBoxes(root);
		expect(texts.length).toBeGreaterThan(10);
		for (const { text, box } of texts) {
			expect(
				raised.some((motif) => overlaps(motif, box)),
				`text under a raised motif: ${text}`
			).toBe(false);
		}

		const withArt = await colorContrast(screen.container);
		expect(withArt.violations).toEqual([]);
		// axe looked at the page's text, and none of it belongs to the art (it has none).
		expect(withArt.passes.length + withArt.incomplete.length).toBeGreaterThan(10);
		expect([...withArt.passes, ...withArt.incomplete].some((t) => t.includes('art-'))).toBe(false);

		for (const layer of layers) layer.style.display = 'none';
		const withoutArt = await colorContrast(screen.container);
		for (const layer of layers) layer.style.display = '';
		expect(withoutArt.violations).toEqual([]);
		expect(withArt.passes).toEqual(withoutArt.passes);
		expect(withArt.incomplete).toEqual(withoutArt.incomplete);
	}, 30000);

	test(`the title stands clear of the art and stays at AA in real pixels, at ${viewport.width} px`, async () => {
		await page.viewport(viewport.width, viewport.height);
		const screen = await render(BlindTest, { reducedMotion: true });
		const heading = page.getByRole('heading', { level: 1 });
		await expect.element(heading).toBeVisible();
		const title = heading.element();
		if (!(title instanceof HTMLElement)) throw new Error('Missing the title');
		const root = screen.container.querySelector<HTMLElement>('.blind-test');
		const pageLayer = root?.querySelector<HTMLElement>(':scope > .art-layer');
		const sceneLayer = root?.querySelector<HTMLElement>('.room .stage .aperture > .art-layer');
		if (!pageLayer || !sceneLayer) throw new Error('Missing an art layer');
		const layers = [pageLayer, sceneLayer];
		for (const layer of layers) await expect.poll(() => layer.dataset.art).toBe('running');

		// No art paints under the title any more: none of its boxes meets the h1's box.
		const box = title.getBoundingClientRect();
		const underTitle = layers
			.flatMap((layer) => [layer, ...layer.querySelectorAll('*')])
			.map((node) => node.getBoundingClientRect())
			.filter((rect) => rect.width > 0 && rect.height > 0 && overlaps(rect, box));
		expect(underTitle).toHaveLength(0);

		// One frozen frame for every screenshot, so the art is the only difference between them.
		for (const animation of document.getAnimations()) animation.pause();
		const text = colorLuminance(getComputedStyle(title).color);
		// The backdrop only: the title's glyphs and their shadow are removed, its box stays.
		title.style.color = 'transparent';
		title.style.textShadow = 'none';
		const raise = document.createElement('style');
		try {
			const withArt = worstContrast(text, await paintedPixels(title));
			for (const layer of layers) layer.style.display = 'none';
			const withoutArt = worstContrast(text, await paintedPixels(title));
			for (const layer of layers) layer.style.display = '';
			// Even with every art paint fully opaque the title keeps AA: it never sits on the art.
			raise.textContent =
				'.art-layer, .art-layer *, .art-layer *::before, .art-layer *::after { opacity: 1 !important; }';
			document.head.append(raise);
			const raised = worstContrast(text, await paintedPixels(title));

			expect(withoutArt, 'the room alone behind the title').toBeGreaterThanOrEqual(CONTRAST_AA);
			expect(withArt, 'the room with the art behind the title').toBeGreaterThanOrEqual(CONTRAST_AA);
			expect(raised, 'the art is not under the title').toBeGreaterThanOrEqual(CONTRAST_AA);
		} finally {
			raise.remove();
			for (const layer of layers) layer.style.display = '';
			title.style.color = '';
			title.style.textShadow = '';
		}
	}, 30000);
}
