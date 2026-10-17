// FUX.ART.3: no text of the Teste cego page may sit under its art. The scene part lives inside
// ListeningRoom's frame, between the drawing and the plates, so the plates, the title, the cue
// and the help paint above it; the page part paints under the room and the desk, and only its
// motif boxes rise above the wood, inside the desk padding and the side gutters. Measured on the
// real page (BlindTest with both parts, on screen and running) at three widths:
// - no rendered text box intersects a raised motif box;
// - axe's color-contrast finds no violation, and every axe result (passes and incomplete) is the
//   same with both art layers removed: the art neither lowers a pair nor hides text from axe.
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
		const frame = root?.querySelector<HTMLElement>('.room .frame');
		const sceneLayer = frame?.querySelector<HTMLElement>(':scope > .art-layer');
		if (!root || !pageLayer || !frame || !sceneLayer) throw new Error('Missing an art layer');
		const layers = [pageLayer, sceneLayer];
		for (const layer of layers) {
			const style = getComputedStyle(layer);
			expect(style.zIndex).toBe('auto');
			expect(style.pointerEvents).toBe('none');
			expect(style.display).not.toBe('none');
			// The real observer reports it on screen: the art is drawn and animating while measured.
			await expect.poll(() => layer.dataset.art).toBe('running');
		}

		// The scene part sits right above the drawing and right under the plates; the title, the
		// cue and the help are outside the frame, painted after it.
		expect(sceneLayer.previousElementSibling?.tagName.toLowerCase()).toBe('svg');
		expect(sceneLayer.nextElementSibling?.classList.contains('plates')).toBe(true);
		expect(frame.contains(heading.element())).toBe(false);
		// The scene part spans the title's area, so the title is measured over the art.
		const title = heading.element().getBoundingClientRect();
		const scene = sceneLayer.getBoundingClientRect();
		expect(scene.top).toBeLessThanOrEqual(title.top);
		expect(scene.bottom).toBeGreaterThanOrEqual(title.bottom);

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
}
