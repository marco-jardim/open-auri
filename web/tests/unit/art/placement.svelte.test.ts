import axe from 'axe-core';
import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { handleGateRequest } from '#lib/workers/gate-handler.ts';
import CompararPage from '#lib/components/pages/comparar/CompararPage.svelte';
import CurvaPage from '#lib/components/pages/curva/CurvaPage.svelte';
import type { GateClient } from '#lib/components/pages/curva/drag.ts';
import { fakeAppOptions } from '../app/fakes.ts';
import '../primitives/design-system.ts';
import { simulateReducedMotion } from './helpers.ts';

let apps: ClientApp[] = [];

afterEach(async () => {
	await cleanup();
	for (const app of apps) app.dispose();
	apps = [];
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

async function expectAccessible(container: HTMLElement) {
	const { violations } = await axe.run(container);
	const blocking = violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
	expect(blocking).toEqual([]);
}

/** The art is the host's first child, the host an isolated stacking context, no <img> added. */
async function expectPlaced(host: HTMLElement | null): Promise<HTMLElement> {
	if (!host) throw new Error('Missing the art host');
	// The art arrives through LazyArt once the page is idle: wait for it to lead the host.
	await expect
		.poll(() => host.firstElementChild?.classList.contains('art-layer') ?? false, { timeout: 5000 })
		.toBe(true);
	const layer = host.firstElementChild;
	if (!(layer instanceof HTMLElement)) throw new Error('Missing the art layer');
	expect(layer.classList.contains('art-layer')).toBe(true);
	expect(layer.getAttribute('aria-hidden')).toBe('true');
	const style = getComputedStyle(host);
	expect(style.position).toBe('relative');
	expect(style.isolation).toBe('isolate');
	expect(getComputedStyle(layer).zIndex).toBe('-1');
	expect(layer.querySelector('img')).toBeNull();
	return layer;
}

/**
 * Where the gaps of a page root really are: the middle between consecutive in-flow sections, then
 * of the bottom padding when there is one. Read from the live DOM, so deferred panels that grow
 * (or a padding token the test page does not load) change the expectation with the page.
 */
function sectionGaps(root: HTMLElement, layer: HTMLElement): string[] {
	const sections = [...root.children].filter(
		(child): child is HTMLElement =>
			child !== layer &&
			child instanceof HTMLElement &&
			child.offsetParent === root &&
			child.offsetHeight >= 40
	);
	const gaps: string[] = [];
	let above: HTMLElement | undefined;
	for (const section of sections) {
		if (above) gaps.push(`${(above.offsetTop + above.offsetHeight + section.offsetTop) / 2}px`);
		above = section;
	}
	const end = above ? above.offsetTop + above.offsetHeight : 0;
	if (above && root.clientHeight - end > 8) gaps.push(`${(end + root.clientHeight) / 2}px`);
	return gaps;
}

/** Where the art put its gap motifs. */
function artGaps(layer: HTMLElement): string[] {
	return [...layer.querySelectorAll<HTMLElement>('.cv-gap')].map((gap) => gap.style.top);
}

test('Curva: the art layer leads the page root, follows its sections and keeps axe clean', async () => {
	const app = createClientApp(fakeAppOptions().options);
	apps.push(app);
	const screen = await render(CurvaPage, {
		app,
		layer: 'ouvir',
		hash: '',
		pageUrl: new URL('https://example.test/'),
		onlayer: () => {},
		gateClient: gateClient()
	});
	await tick();
	await expect.element(page.getByRole('heading', { level: 1, name: 'Curva' })).toBeVisible();
	const root = screen.container.querySelector<HTMLElement>('main.curva');
	const layer = await expectPlaced(root);
	if (!root) throw new Error('Missing the Curva root');
	// Ouvir: nameplate, rack and lower panels, so at least the two gaps between them. Deferred
	// panels keep resizing while they load: wait until the art sits in the gaps of the sections
	// that are there now.
	await expect.poll(() => sectionGaps(root, layer).length).toBeGreaterThanOrEqual(2);
	await expect
		.poll(() => artGaps(layer).join(' ') === sectionGaps(root, layer).join(' '))
		.toBe(true);
	expect(artGaps(layer)).toEqual(sectionGaps(root, layer));
	// The lamp sits on the deepest open module: the rack, in Ouvir.
	const rack = root.querySelector<HTMLElement>('.instrument');
	if (!rack) throw new Error('Missing the Curva rack');
	expect(layer.querySelector<HTMLElement>('.cv-lamp-box')?.style.top).toBe(`${rack.offsetTop}px`);
	expect(screen.container.querySelector('img')).toBeNull();
	await expectAccessible(screen.container);
}, 30000);

test.each([1440, 1920])(
	'Curva: hero cables clear every text box at %i px',
	async (width) => {
		const viewport = { width: innerWidth, height: innerHeight };
		let restoreMotion: (() => void) | undefined;
		try {
			await page.viewport(width, 1000);
			const app = createClientApp(fakeAppOptions().options);
			apps.push(app);
			const screen = await render(CurvaPage, {
				app,
				layer: 'ouvir',
				hash: '',
				pageUrl: new URL('https://example.test/'),
				onlayer: () => {},
				gateClient: gateClient()
			});
			const root = screen.container.querySelector<HTMLElement>('main.curva');
			const layer = await expectPlaced(root);
			const hero = root?.querySelector<HTMLElement>('.nameplate');
			const artHero = layer.querySelector<HTMLElement>('.cv-hero');
			if (!hero || !artHero) throw new Error('Missing the Curva hero');
			await document.fonts.ready;
			hero.scrollIntoView({ block: 'start' });
			await expect.poll(() => artHero.style.height).not.toBe('');
			await expect.poll(() => artHero.hasAttribute('data-art-seen')).toBe(true);
			const cords = [...layer.querySelectorAll<SVGPathElement>('.cv-jacks .cv-cord')];
			expect(cords).toHaveLength(2);

			// Use actual text-node line boxes (including the selector copy and help button), not
			// just a paragraph's enclosing block. Check the entire stroke, even while it draws in.
			const expectClear = () => {
				const walker = document.createTreeWalker(hero, NodeFilter.SHOW_TEXT);
				const textBoxes: DOMRect[] = [];
				while (walker.nextNode()) {
					if (!walker.currentNode.textContent?.trim()) continue;
					const range = document.createRange();
					range.selectNodeContents(walker.currentNode);
					textBoxes.push(...[...range.getClientRects()].filter((box) => box.width && box.height));
				}
				expect(textBoxes.length).toBeGreaterThan(0);
				for (const cord of cords) {
					const box = cord.getBoundingClientRect();
					if (!box.width || !box.height) {
						// A column narrower than the bundle intentionally omits the decoration.
						const help = hero.querySelector('.np-help');
						if (!help) throw new Error('Missing the help column');
						expect(help.getBoundingClientRect().width).toBeLessThan(120);
						continue;
					}
					for (const text of textBoxes) {
						const overlaps =
							box.left - 2 < text.right &&
							box.right + 2 > text.left &&
							box.top - 2 < text.bottom &&
							box.bottom + 2 > text.top;
						expect(overlaps, `Cable over hero text at ${width} px`).toBe(false);
					}
				}
			};

			// Sample the plug-in swing as well as its final pose; reduced motion must also be clear.
			const animations = artHero.getAnimations({ subtree: true });
			for (const animation of animations) animation.pause();
			for (const time of [0, 150, 400, 720, 1200, 2000, 3000]) {
				for (const animation of animations) animation.currentTime = time;
				expectClear();
			}
			restoreMotion = simulateReducedMotion();
			expectClear();

			// A font/locale or container change can shrink just the help column without resizing
			// the page root. That column is observed too, so the bundle disappears rather than spills.
			const help = hero.querySelector<HTMLElement>('.np-help');
			const jacks = artHero.querySelector('.cv-jacks');
			if (!help || !jacks) throw new Error('Missing the hero jacks or their column');
			help.style.width = '100px';
			await expect.poll(() => getComputedStyle(jacks).display).toBe('none');
			expectClear();
		} finally {
			restoreMotion?.();
			await page.viewport(viewport.width, viewport.height);
		}
	},
	30000
);

// Regression (real build, 320×1000, /?camada=engenharia): the gap cables' 360 px boxes, placed
// from 4% of the width, ended at 373 px and the page scrolled 68 px sideways.
test.each([320, 390])(
	'Curva: no art passes the right edge or widens the page at %i px',
	async (width) => {
		const viewport = { width: innerWidth, height: innerHeight };
		try {
			await page.viewport(width, 1000);
			const app = createClientApp(fakeAppOptions().options);
			apps.push(app);
			const screen = await render(CurvaPage, {
				app,
				layer: 'engenharia',
				hash: '',
				pageUrl: new URL('https://example.test/'),
				onlayer: () => {},
				gateClient: gateClient()
			});
			const root = screen.container.querySelector<HTMLElement>('main.curva');
			const layer = await expectPlaced(root);
			if (!root) throw new Error('Missing the Curva root');
			await document.fonts.ready;
			// The deferred Engenharia modules keep resizing while they load: wait until the art sits
			// in the gaps of the sections that are there now, with the cabled gaps among them.
			await expect.poll(() => layer.querySelectorAll('.cv-gap .cv-c1').length).toBeGreaterThan(0);
			await expect
				.poll(() => artGaps(layer).join(' ') === sectionGaps(root, layer).join(' '))
				.toBe(true);

			// Mark every motif as seen so its reveal runs, then sample the plug-in swing (it starts
			// rotated) and the final frame, paused, as for the hero cables.
			for (const motif of layer.querySelectorAll<HTMLElement>('[data-art]')) {
				motif.dataset.artSeen = '';
			}
			await expect
				.poll(() => layer.querySelectorAll('.cv-gap .cv-swing')[0]?.getAnimations().length ?? 0)
				.toBeGreaterThan(0);
			const animations = layer.getAnimations({ subtree: true });
			for (const animation of animations) animation.pause();
			const edge = document.documentElement.clientWidth;
			for (const time of [0, 150, 400, 720, 1200, 3000]) {
				for (const animation of animations) animation.currentTime = time;
				let measured = 0;
				for (const part of [layer, ...layer.querySelectorAll('*')]) {
					const rect = part.getBoundingClientRect();
					if (rect.width === 0 && rect.height === 0) continue;
					measured++;
					const name = `${time} ms: ${part.tagName} ${part.getAttribute('class') ?? ''}`;
					expect(rect.right, name).toBeLessThanOrEqual(edge);
				}
				expect(measured).toBeGreaterThan(4);
				expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
					document.documentElement.clientWidth
				);
			}
		} finally {
			await page.viewport(viewport.width, viewport.height);
		}
	},
	30000
);

test('Comparar: the art layer leads the cabinet, follows its sections and keeps axe clean', async () => {
	const screen = await render(CompararPage, { app: null, locale: 'pt-BR' });
	await expect.element(page.getByRole('heading', { level: 1 })).toBeVisible();
	const root = screen.container.querySelector<HTMLElement>('.comparar');
	if (!root) throw new Error('Missing the Comparar root');
	expect(getComputedStyle(root).isolation).toBe('isolate');
	const layer = await expectPlaced(root.querySelector<HTMLElement>('.cabinet'));
	await expect.poll(() => layer.querySelectorAll('.ca-gap').length).toBeGreaterThan(2);
	await expect.poll(() => layer.querySelectorAll('.ca-echo').length).toBe(3);
	await expectAccessible(screen.container);
}, 30000);
