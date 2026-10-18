// /c/[id] layout (Chromium, with the app's global stylesheet): the actions row and the compact
// Transport never overlap (the Transport wraps its seek bar under its own buttons when narrow,
// 7e50ada), and every action/transport button reads against the surface it sits on with at
// least 3:1 non-text contrast (WCAG 1.4.11), computed from the computed colours.
import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { encodeS1 } from 'open-auri/share';
import type { ClientApp } from '#lib/app/client.svelte.ts';
import { IDLE_STATE, type AudioEngineState } from '#lib/audio/engine.ts';
import SharedCurve from '#lib/components/pages/shared-curve/SharedCurve.svelte';
import type { SharedCurveData, SharedCurveMeta } from '#lib/components/pages/shared-curve/types.ts';
import { m } from '#lib/paraglide/messages.js';
import { neutralCurve } from '#lib/state/model.ts';
import '../../primitives/design-system.ts';

afterEach(() => {
	cleanup();
	delete document.body.dataset.page;
});

const CURVE: SharedCurveData = {
	lineageId: 'lin-abcdef123456',
	versionId: 'ver-abcdef123456',
	isHead: true,
	name: 'Warm vocal',
	description: 'A gentle lift around 3 kHz.',
	license: 'CC-BY-4.0',
	lang: 'en-US',
	author: { username: 'geoff', displayUsername: 'Geoff' },
	s1: encodeS1(neutralCurve()),
	visibility: 'unlisted',
	shareId: 'share-abcdef1234'
};

const META: SharedCurveMeta = {
	canonical: 'https://example.test/c/lin-abcdef123456',
	image: 'https://example.test/og/ver-abcdef123456.png',
	indexable: false
};

/** A loaded file, so both Transport buttons are available (unavailable faces are exempt). */
function fakeApp(): ClientApp {
	const state: AudioEngineState = { ...IDLE_STATE, source: 'file', duration: 225, position: 0 };
	const audio = {
		state: () => state,
		onChange: () => () => undefined,
		getContext: () => ({ state: 'running', resume: async () => undefined })
	};
	const app = {
		requestWrite: () => undefined,
		state: { curve: { current: neutralCurve() } },
		audio
	};
	return app as unknown as ClientApp;
}

type RGB = readonly [number, number, number];

const canvas = document.createElement('canvas');
canvas.width = 1;
canvas.height = 1;
const context = canvas.getContext('2d', { willReadFrequently: true });

/** Paints the colours bottom to top (source-over, as CSS stacks them) and reads the pixel. */
function paint(...colours: string[]): { rgb: RGB; alpha: number } {
	if (!context) throw new Error('no 2D canvas');
	context.clearRect(0, 0, 1, 1);
	for (const colour of colours) {
		context.fillStyle = colour;
		context.fillRect(0, 0, 1, 1);
	}
	const data = context.getImageData(0, 0, 1, 1).data;
	return { rgb: [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0], alpha: (data[3] ?? 0) / 255 };
}

const css = ([r, g, b]: RGB) => `rgb(${r}, ${g}, ${b})`;
const opaque = (colour: string) => paint(colour).alpha >= 0.99;
const visible = (colour: string) => paint(colour).alpha > 0;

/** Colour stops of a computed `background-image` (gradients), in source order. */
function stops(image: string): string[] {
	if (image === 'none') return [];
	return image.match(/rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}\b/gi) ?? [];
}

/**
 * The opaque colours behind an element: the nearest ancestor painted with an opaque colour (or
 * the opaque stops of its gradient, every one a candidate), with the translucent backgrounds
 * between flattened on top.
 */
function surfacesBehind(element: Element): string[] {
	const layers: string[] = [];
	const flatten = (base: string) => css(paint(base, ...[...layers].reverse()).rgb);
	for (let node = element.parentElement; node; node = node.parentElement) {
		const style = getComputedStyle(node);
		const solid = stops(style.backgroundImage).filter(opaque);
		if (solid.length > 0) return solid.map(flatten);
		if (opaque(style.backgroundColor)) return [flatten(style.backgroundColor)];
		if (visible(style.backgroundColor)) layers.push(style.backgroundColor);
	}
	return [flatten('#ffffff')];
}

function luminance([r, g, b]: RGB): number {
	const linear = (channel: number) => {
		const c = channel / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: RGB, b: RGB): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** Worst-case contrast of the button's face or border (the better of the two) on its surface. */
function buttonContrast(button: HTMLElement): { ratio: number; detail: string } {
	const style = getComputedStyle(button);
	const bordered = parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none';
	let worst = Infinity;
	let detail = '';
	for (const surface of surfacesBehind(button)) {
		const under = paint(surface).rgb;
		const faceStops = stops(style.backgroundImage);
		// The border is measured straight on the surface (without the face under it): the
		// stricter of the two readings for translucent faces.
		const faces = (faceStops.length > 0 ? faceStops : ['transparent']).map(
			(stop) => paint(surface, style.backgroundColor, stop).rgb
		);
		const face = Math.min(...faces.map((rgb) => contrast(rgb, under)));
		const edge = bordered ? contrast(paint(surface, style.borderTopColor).rgb, under) : 1;
		const ratio = Math.max(face, edge);
		if (ratio < worst) {
			worst = ratio;
			detail = `surface ${surface}, face ${style.backgroundColor} (${face.toFixed(2)}:1), border ${
				style.borderTopColor
			} (${edge.toFixed(2)}:1)`;
		}
	}
	return { ratio: worst, detail };
}

const intersects = (a: DOMRect, b: DOMRect, slack = 0.5) =>
	a.left < b.right - slack &&
	b.left < a.right - slack &&
	a.top < b.bottom - slack &&
	b.top < a.bottom - slack;

const nameOf = (element: Element) =>
	element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName;

for (const width of [1440, 1024, 390, 320]) {
	test(`at ${width} px the buttons never overlap and contrast with their surface`, async () => {
		// The route's accent (/c/[id] is in the Biblioteca theme).
		document.body.dataset.page = 'biblioteca';
		await page.viewport(width, 900);
		const screen = await render(SharedCurve, {
			curve: CURVE,
			meta: META,
			signedIn: true,
			app: fakeApp()
		});
		screen.container.style.width = `${width}px`;
		await document.fonts.ready;
		// The arrival animations transform (and tilt) the card: measure its resting layout.
		for (const animation of document.getAnimations()) animation.finish();

		const byName = (name: string) =>
			page.getByRole('button', { name, exact: true }).element() as HTMLElement;
		const actions = [
			byName(m.shared_curve_listen()),
			page.getByRole('link', { name: m.shared_curve_open(), exact: true }).element() as HTMLElement,
			byName(m.shared_curve_favorite()),
			byName(m.shared_curve_install())
		];
		const transport = [byName(m.transport_play()), byName(m.transport_restart())];
		const group = page.getByRole('group', { name: m.transport_group() }).element() as HTMLElement;

		// No two buttons of the card intersect (every button, plus the link drawn as one).
		const article = screen.container.querySelector('article');
		if (!article) throw new Error('SharedCurve is not mounted');
		const buttons = [...article.querySelectorAll<HTMLElement>('button, a.btn')].filter((node) => {
			const rect = node.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		});
		for (const control of [...actions, ...transport]) expect(buttons).toContain(control);
		buttons.forEach((first, index) => {
			for (const second of buttons.slice(index + 1)) {
				expect(
					intersects(first.getBoundingClientRect(), second.getBoundingClientRect()),
					`${width} px: "${nameOf(first)}" overlaps "${nameOf(second)}"`
				).toBe(false);
			}
		});

		// The Transport row starts below the actions row, and nothing leaves the card.
		const actionsBottom = Math.max(...actions.map((node) => node.getBoundingClientRect().bottom));
		expect(group.getBoundingClientRect().top, `${width} px`).toBeGreaterThanOrEqual(
			actionsBottom - 0.5
		);
		const card = article.getBoundingClientRect();
		for (const control of [...actions, ...transport]) {
			const rect = control.getBoundingClientRect();
			expect(rect.left, `${width} px: ${nameOf(control)}`).toBeGreaterThanOrEqual(card.left - 0.5);
			expect(rect.right, `${width} px: ${nameOf(control)}`).toBeLessThanOrEqual(card.right + 0.5);
		}

		// Non-text contrast (WCAG 1.4.11): face or border against the surface behind the button.
		for (const control of [...actions, ...transport]) {
			const { ratio, detail } = buttonContrast(control);
			expect(ratio, `${width} px: "${nameOf(control)}": ${detail}`).toBeGreaterThanOrEqual(3);
		}
	});
}
