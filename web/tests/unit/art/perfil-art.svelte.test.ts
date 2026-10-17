import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import PerfilArt from '#lib/components/art/PerfilArt.svelte';
import '../primitives/design-system.ts';

// ---- FUX.ART layer contract (the same helpers open every tests/unit/art/*-art test) ----

type Entry = { isIntersecting: boolean };

/** IntersectionObserver stand-in: nothing is on screen until the test says so. */
class FakeObserver {
	static all: FakeObserver[] = [];
	readonly callback: (entries: Entry[]) => void;
	constructor(callback: (entries: Entry[]) => void) {
		this.callback = callback;
		FakeObserver.all.push(this);
	}
	observe(): void {
		// Entries arrive only through `intersect`.
	}
	unobserve(): void {
		// Nothing to release.
	}
	disconnect(): void {
		// Nothing to release.
	}
	takeRecords(): Entry[] {
		return [];
	}
}

let tab: DocumentVisibilityState = 'visible';

beforeEach(() => {
	FakeObserver.all = [];
	vi.stubGlobal('IntersectionObserver', FakeObserver);
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => tab });
});

afterEach(async () => {
	await cleanup();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(document, 'visibilityState');
	tab = 'visible';
});

function intersect(isIntersecting: boolean) {
	for (const observer of FakeObserver.all) observer.callback([{ isIntersecting }]);
}

const PSEUDOS = [null, '::before', '::after'] as const;
const FOCUSABLE =
	'a[href], area[href], button, input, select, textarea, iframe, object, embed, audio, video, summary, [tabindex], [contenteditable]';
const NO_PREFERENCE = /prefers-reduced-motion:\s*no-preference/;
const REDUCE = /prefers-reduced-motion:\s*reduce/;
const LEAN_SVG = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[\d .]+"/;
const SVG_BLOAT =
	/<(?:metadata|script|style|text|image|foreignObject|title|desc)\b|<!--|<\?xml|inkscape|sodipodi/;

function layerOf(container: HTMLElement): HTMLElement {
	const layer = container.querySelector('.art-layer');
	if (!(layer instanceof HTMLElement)) throw new Error('Missing .art-layer');
	return layer;
}

function parts(layer: HTMLElement): Element[] {
	return [layer, ...layer.querySelectorAll('*')];
}

type FoundRule = { rule: CSSStyleRule; motionOnly: boolean };

/** Every style rule of the document; `motionOnly` when it sits under a no-preference query. */
function styleRules(): FoundRule[] {
	const found: FoundRule[] = [];
	const walk = (rules: CSSRuleList, motionOnly: boolean) => {
		for (const rule of Array.from(rules)) {
			if (rule instanceof CSSMediaRule) {
				walk(rule.cssRules, motionOnly || NO_PREFERENCE.test(rule.conditionText));
			} else if (rule instanceof CSSStyleRule) {
				found.push({ rule, motionOnly });
			} else if (rule instanceof CSSGroupingRule) {
				walk(rule.cssRules, motionOnly);
			}
		}
	};
	for (const sheet of Array.from(document.styleSheets)) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue; // A cross-origin sheet has no readable rules.
		}
		walk(rules, false);
	}
	return found;
}

/** `Element.matches` for a rule selector; pseudo-elements count for their host element. */
function matches(element: Element, selector: string): boolean {
	try {
		return element.matches(selector.replace(/::?(?:before|after)\b/g, ''));
	} catch {
		return false;
	}
}

const animates = (rule: CSSStyleRule) =>
	rule.style.animationName.split(',').some((name) => !['', 'none'].includes(name.trim()));

function assetUrls(layer: HTMLElement): string[] {
	const urls = new Set<string>();
	for (const element of parts(layer)) {
		for (const pseudo of PSEUDOS) {
			const style = getComputedStyle(element, pseudo);
			const images = `${style.maskImage} ${style.backgroundImage}`;
			for (const match of images.matchAll(/url\("([^"]+)"\)/g)) {
				if (match[1]) urls.add(new URL(match[1], location.href).pathname);
			}
		}
	}
	return [...urls].sort();
}

function expectPausedUntilSeen(layer: HTMLElement, layers: number) {
	const tracked = [layer, ...layer.querySelectorAll<HTMLElement>('[data-art]')];
	expect(tracked).toHaveLength(layers);
	for (const node of tracked) {
		expect(node.dataset.art).toBe('paused');
		expect(node.hasAttribute('data-art-seen')).toBe(false);
	}
	for (const element of parts(layer)) {
		for (const pseudo of PSEUDOS) {
			const style = getComputedStyle(element, pseudo);
			if (style.animationName === 'none') continue;
			const states = style.animationPlayState.split(',').map((state) => state.trim());
			expect(states).not.toContain('running');
		}
	}
	intersect(true);
	for (const node of tracked) {
		expect(node.dataset.art).toBe('running');
		expect(node.hasAttribute('data-art-seen')).toBe(true);
	}
	tab = 'hidden';
	document.dispatchEvent(new Event('visibilitychange'));
	for (const node of tracked) expect(node.dataset.art).toBe('paused');
	tab = 'visible';
	document.dispatchEvent(new Event('visibilitychange'));
	for (const node of tracked) expect(node.dataset.art).toBe('running');
	intersect(false);
	for (const node of tracked) {
		expect(node.dataset.art).toBe('paused');
		expect(node.hasAttribute('data-art-seen')).toBe(true);
	}
}

function expectStillUnderReducedMotion(layer: HTMLElement) {
	intersect(true); // Arms the one-shot reveals too.
	const elements = parts(layer);
	const rules = styleRules().filter(({ rule }) =>
		elements.some((element) => matches(element, rule.selectorText))
	);
	const moving = rules.filter(({ rule }) => animates(rule));
	expect(moving.length).toBeGreaterThan(0);
	const loose = moving.filter(({ motionOnly }) => !motionOnly);
	expect(loose.map(({ rule }) => rule.selectorText)).toEqual([]);
	const stops = rules.filter(({ rule }) => {
		const parent = rule.parentRule;
		return (
			parent instanceof CSSMediaRule &&
			REDUCE.test(parent.conditionText) &&
			rule.style.animationName === 'none' &&
			rule.style.getPropertyPriority('animation-name') === 'important'
		);
	});
	expect(stops.length).toBeGreaterThan(0);
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
		for (const element of elements) {
			for (const pseudo of PSEUDOS) {
				expect(getComputedStyle(element, pseudo).animationName).toBe('none');
			}
		}
	}
}

async function expectLeanAssets(urls: string[], budget: number) {
	let bytes = 0;
	for (const url of urls) {
		const response = await fetch(url);
		expect(response.ok, url).toBe(true);
		const svg = await response.text();
		bytes += new TextEncoder().encode(svg).length;
		expect(svg, url).toMatch(LEAN_SVG);
		expect(svg, url).not.toMatch(SVG_BLOAT);
	}
	expect(bytes).toBeLessThanOrEqual(budget);
}

// ---- Public profile ----

test('is decorative only: hidden from assistive tech, inert to the pointer, no text, nothing focusable', async () => {
	const screen = await render(PerfilArt);
	const layer = layerOf(screen.container);
	expect(layer.getAttribute('aria-hidden')).toBe('true');
	const style = getComputedStyle(layer);
	expect(style.position).toBe('absolute');
	expect(style.zIndex).toBe('-1');
	expect(style.overflow).toBe('hidden');
	for (const element of parts(layer)) {
		expect(getComputedStyle(element).pointerEvents).toBe('none');
	}
	expect(layer.querySelectorAll(FOCUSABLE)).toHaveLength(0);
	expect(layer.querySelectorAll('[id], img, svg text, title')).toHaveLength(0);
	expect(layer.textContent?.trim()).toBe('');
	// The Perfil tests read the first `.vinyl` (ProfileRecord's disc) and forbid `.room b`.
	const clashes = layer.querySelectorAll('.vinyl, b, .skeleton-disc, .mini-curve');
	expect(clashes).toHaveLength(0);
});

test('starts paused, runs only while seen with the tab visible, and remembers it was seen', async () => {
	const screen = await render(PerfilArt);
	// The layer and the record each follow their own visibility.
	expectPausedUntilSeen(layerOf(screen.container), 2);
});

test('nothing animates under reduced motion: animations live under no-preference and a reduce block stops them', async () => {
	const screen = await render(PerfilArt);
	expectStillUnderReducedMotion(layerOf(screen.container));
});

test('draws from lean static SVGs in /art/perfil, 40 kB at most in all', async () => {
	const screen = await render(PerfilArt);
	const urls = assetUrls(layerOf(screen.container));
	expect(urls).toEqual(['/art/perfil/grooves.svg', '/art/perfil/records.svg']);
	await expectLeanAssets(urls, 40_000);
});

test('the sheen turns without end and the flourish writes itself once, only after it is seen', async () => {
	const screen = await render(PerfilArt);
	const layer = layerOf(screen.container);
	const sheen = layer.querySelector('.sheen');
	const ink = layer.querySelector('.flourish .ink');
	if (!sheen || !ink) throw new Error('Missing sheen or flourish');
	expect(ink.getAttribute('pathLength')).toBe('1');
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
		// The runner asks for reduced motion: the flourish is written, the light rests.
		expect(getComputedStyle(ink).strokeDasharray).toBe('none');
		expect(getComputedStyle(sheen).animationName).toBe('none');
		return;
	}
	expect(getComputedStyle(sheen).animationIterationCount).toBe('infinite');
	expect(getComputedStyle(ink).animationName).toBe('none');
	intersect(true);
	expect(getComputedStyle(ink).animationName).not.toBe('none');
	expect(getComputedStyle(ink).animationIterationCount).toBe('1');
});
