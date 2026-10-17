// FUX.ART.2 · Cabo (Ray Dolby) art layer. Decorative only: hidden from assistive technology,
// no pointer events, nothing focusable, no text. It starts paused and unseen, reveals once on
// screen, pauses again off screen, and has no animation at all under reduced motion, where the
// final frame shows both compander curves drawn.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import CaboArt from '#lib/components/art/CaboArt.svelte';

interface FakeEntry {
	isIntersecting: boolean;
	target: Element;
}

/** IntersectionObserver under the test's control: the test decides what is on screen. */
class FakeObserver {
	static all: FakeObserver[] = [];
	readonly targets: Element[] = [];
	readonly callback: (entries: FakeEntry[]) => void;
	constructor(callback: (entries: FakeEntry[]) => void) {
		this.callback = callback;
		FakeObserver.all.push(this);
	}
	observe(target: Element) {
		this.targets.push(target);
	}
	disconnect() {
		this.targets.length = 0;
	}
	fire(isIntersecting: boolean) {
		this.callback(this.targets.map((target) => ({ isIntersecting, target })));
	}
}

const onScreen = (inView: boolean) => {
	for (const observer of FakeObserver.all) observer.fire(inView);
};

const FOCUSABLE =
	'a[href], area, button, input, select, textarea, summary, iframe, audio, video, [tabindex], [contenteditable]';
const PSEUDOS = [null, '::before', '::after'] as const;

beforeEach(() => {
	FakeObserver.all = [];
	vi.stubGlobal('IntersectionObserver', FakeObserver);
});

afterEach(async () => {
	await cleanup();
	vi.unstubAllGlobals();
});

async function mountLayer(): Promise<HTMLElement> {
	const screen = await render(CaboArt);
	const layer = screen.container.querySelector('.art-layer');
	if (!(layer instanceof HTMLElement)) throw new Error('Missing art layer');
	return layer;
}

function part(layer: Element, selector: string): Element {
	const element = layer.querySelector(selector);
	if (!element) throw new Error(`Missing ${selector}`);
	return element;
}

const parts = (layer: Element) => [layer, ...layer.querySelectorAll('*')];

/** Every element and pseudo-element of the layer that has an animation, by class and name. */
function animated(layer: Element): string[] {
	const names: string[] = [];
	for (const element of parts(layer)) {
		for (const pseudo of PSEUDOS) {
			const name = getComputedStyle(element, pseudo).animationName;
			if (name !== 'none') names.push(`${element.getAttribute('class')}${pseudo ?? ''}: ${name}`);
		}
	}
	return names;
}

/** Applies the shipped `prefers-reduced-motion: reduce` rules unconditionally while `check` runs. */
function withReducedMotion(check: () => void) {
	const rules: string[] = [];
	const collect = (list: CSSRuleList) => {
		for (const rule of Array.from(list)) {
			if (
				rule instanceof CSSMediaRule &&
				/prefers-reduced-motion:\s*reduce/.test(rule.media.mediaText)
			) {
				rules.push(...Array.from(rule.cssRules, (inner) => inner.cssText));
			} else if (rule instanceof CSSGroupingRule) {
				collect(rule.cssRules);
			}
		}
	};
	for (const sheet of Array.from(document.styleSheets)) {
		let list: CSSRuleList;
		try {
			list = sheet.cssRules;
		} catch {
			continue; // a cross-origin sheet cannot be read and holds none of these rules
		}
		collect(list);
	}
	expect(rules.length).toBeGreaterThan(0);
	const reduced = new CSSStyleSheet();
	reduced.replaceSync(rules.join('\n'));
	document.adoptedStyleSheets = [...document.adoptedStyleSheets, reduced];
	try {
		check();
	} finally {
		document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== reduced);
	}
}

test('is decorative: aria-hidden, under the content, no pointer events, no focus, no text', async () => {
	const layer = await mountLayer();
	expect(layer.getAttribute('aria-hidden')).toBe('true');
	const style = getComputedStyle(layer);
	expect([style.position, style.zIndex, style.overflow]).toEqual(['absolute', '-1', 'hidden']);
	for (const element of parts(layer)) {
		expect(getComputedStyle(element).pointerEvents).toBe('none');
		if (element instanceof HTMLElement || element instanceof SVGElement) {
			expect(element.tabIndex).toBe(-1);
		}
	}
	expect(layer.querySelectorAll(FOCUSABLE)).toHaveLength(0);
	expect(layer.textContent?.trim()).toBe('');
});

test('starts paused and unseen, reveals once on screen, pauses again off screen', async () => {
	const layer = await mountLayer();
	// The root, the hero and the four screw bands each watch their own visibility.
	const groups = [layer, ...layer.querySelectorAll<HTMLElement>('[data-art]')];
	expect(groups).toHaveLength(6);
	for (const group of groups) {
		expect(group.dataset.art).toBe('paused');
		expect(group.dataset.artSeen).toBeUndefined();
	}
	const curve = part(layer, '.enc');
	const glow = part(layer, '.glow');
	expect(getComputedStyle(curve).animationName).toBe('none');
	expect(parseFloat(getComputedStyle(curve).strokeDashoffset)).toBe(1);
	expect(getComputedStyle(glow).animationPlayState).toBe('paused');

	onScreen(true);
	for (const group of groups) {
		expect(group.dataset.art).toBe('running');
		expect(group.dataset.artSeen).toBe('');
	}
	expect(getComputedStyle(curve).animationName).not.toBe('none');
	expect(getComputedStyle(part(layer, '.bolts .screw'), '::after').animationName).not.toBe('none');
	expect(getComputedStyle(glow).animationPlayState).toBe('running');

	onScreen(false);
	expect(layer.dataset.art).toBe('paused');
	// The reveal is one-shot: leaving the viewport does not undo it.
	expect(layer.dataset.artSeen).toBe('');
	expect(getComputedStyle(glow).animationPlayState).toBe('paused');
	expect(getComputedStyle(curve).animationPlayState).toBe('paused');
});

test('reduced motion: no animation anywhere and the final frame shows both curves', async () => {
	const layer = await mountLayer();
	onScreen(true);
	expect(animated(layer).length).toBeGreaterThan(0);
	withReducedMotion(() => {
		expect(animated(layer)).toEqual([]);
		for (const selector of ['.enc', '.dec']) {
			expect(parseFloat(getComputedStyle(part(layer, selector)).strokeDashoffset)).toBe(0);
		}
	});
});
