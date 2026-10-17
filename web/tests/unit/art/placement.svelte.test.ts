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
