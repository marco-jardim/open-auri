// FUX.ART.3: the Teste cego art (scene part: curtain ripple, polar lobes, light motes; page part:
// diffusers and loudspeakers behind fabric around the desk) is decoration only: hidden from
// assistive technology, out of the way of the pointer and the keyboard, still until it is seen
// in a visible tab, and still for good under reduced motion. The lobes are drawn once and then
// hold still: nothing measures. Neither part makes a layer over text: the scene part has no
// z-index (ListeningRoom places it under the plates and the title) and the page part's root
// makes no stacking context; only its motif boxes rise (z-index 1).
import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import TesteCegoArt from '#lib/components/art/TesteCegoArt.svelte';
import '../primitives/design-system.ts';

type Entry = { target: Element; isIntersecting: boolean };

/** IntersectionObserver double: nothing is reported until the test says so. */
class FakeObserver {
	static last: FakeObserver | null = null;
	readonly targets: Element[] = [];
	constructor(readonly callback: (entries: Entry[]) => void) {
		FakeObserver.last = this;
	}
	observe(target: Element) {
		this.targets.push(target);
	}
	disconnect() {
		this.targets.length = 0;
	}
	emit(isIntersecting: boolean) {
		this.callback(this.targets.map((target) => ({ target, isIntersecting })));
	}
}

const FOCUSABLE =
	'a, button, input, select, textarea, iframe, audio, video, summary, details, [tabindex], [contenteditable], [href], [focusable="true"]';

afterEach(async () => {
	await cleanup();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(document, 'visibilityState');
	FakeObserver.last = null;
});

async function mount(place: 'page' | 'scene' = 'scene'): Promise<HTMLElement> {
	vi.stubGlobal('IntersectionObserver', FakeObserver);
	const screen = await render(TesteCegoArt, { place });
	flushSync();
	const layer = screen.container.querySelector('.art-layer');
	if (!(layer instanceof HTMLElement)) throw new Error('Missing art layer');
	await expect.poll(() => FakeObserver.last?.targets.includes(layer)).toBe(true);
	return layer;
}

function observer(): FakeObserver {
	if (!FakeObserver.last) throw new Error('The layer is not observed');
	return FakeObserver.last;
}

function setTabHidden(hidden: boolean) {
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => (hidden ? 'hidden' : 'visible')
	});
	document.dispatchEvent(new Event('visibilitychange'));
}

type Found = { rule: CSSStyleRule; media: string[] };

function collect(list: CSSRuleList, media: string[]): Found[] {
	const found: Found[] = [];
	for (const rule of Array.from(list)) {
		if (rule instanceof CSSStyleRule) found.push({ rule, media });
		else if (rule instanceof CSSMediaRule)
			found.push(...collect(rule.cssRules, [...media, rule.conditionText]));
		else if (rule instanceof CSSGroupingRule) found.push(...collect(rule.cssRules, media));
	}
	return found;
}

function documentRules(): Found[] {
	return [...Array.from(document.styleSheets), ...document.adoptedStyleSheets].flatMap((sheet) => {
		try {
			return collect(sheet.cssRules, []);
		} catch {
			return [];
		}
	});
}

/**
 * The animation a rule declares. A shorthand that contains `var()` leaves its longhands
 * pending substitution, so CSSOM reports `animation-name` as '' and only the shorthand text
 * survives: read both.
 */
function declaredAnimation(rule: CSSStyleRule): string {
	return (
		rule.style.getPropertyValue('animation-name') || rule.style.getPropertyValue('animation')
	).trim();
}

const PSEUDOS = ['', '::before', '::after'] as const;

/** Every element or pseudo-element of the layer that the browser is animating right now. */
function liveAnimated(
	nodes: Element[]
): Array<{ node: Element; pseudo: (typeof PSEUDOS)[number] }> {
	return nodes.flatMap((node) =>
		PSEUDOS.filter((pseudo) => getComputedStyle(node, pseudo || null).animationName !== 'none').map(
			(pseudo) => ({ node, pseudo })
		)
	);
}

/** The selector parts of a rule that target an element (`''`) or its `::before` / `::after`. */
function parts(rule: CSSStyleRule, pseudo: '' | '::before' | '::after'): string[] {
	return rule.selectorText
		.split(',')
		.map((part) => part.trim())
		.filter((part) => (pseudo === '' ? !part.includes('::') : part.endsWith(pseudo)))
		.map((part) => {
			const base = part.slice(0, part.length - pseudo.length);
			return base === '' || /[\s>+~]$/.test(base) ? `${base}*` : base;
		});
}

function matches(node: Element, selectors: string[]): boolean {
	return selectors.some((selector) => {
		try {
			return node.matches(selector);
		} catch {
			return false;
		}
	});
}

for (const place of ['scene', 'page'] as const) {
	test(`${place} part: hidden from assistive technology and the pointer, no text, nothing focusable`, async () => {
		const layer = await mount(place);
		expect(layer.getAttribute('aria-hidden')).toBe('true');
		const style = getComputedStyle(layer);
		expect(style.pointerEvents).toBe('none');
		expect(style.position).toBe('absolute');
		// No layer over text: the root never takes a z-index of its own.
		expect(style.zIndex).toBe('auto');
		expect(layer.textContent?.trim()).toBe('');
		expect(layer.querySelectorAll(FOCUSABLE)).toHaveLength(0);
		for (const node of layer.querySelectorAll('*')) {
			expect(getComputedStyle(node).pointerEvents).toBe('none');
			if (node instanceof HTMLElement) expect(node.tabIndex).toBeLessThan(0);
		}
		// It complements the room instead of redrawing it: no second curtain, cone or dust.
		expect(layer.querySelectorAll('.scrim, .dust, .mote, .speaker-box')).toHaveLength(0);
	});
}

test('page part: only the motif boxes rise above the desk, and its root makes no stacking context', async () => {
	const layer = await mount('page');
	const flat = (node: Element) => {
		const style = getComputedStyle(node);
		return (
			style.zIndex === 'auto' &&
			style.isolation === 'auto' &&
			style.opacity === '1' &&
			style.transform === 'none' &&
			style.contain === 'none' &&
			style.maskImage === 'none'
		);
	};
	const desk = layer.querySelector('.art-desk');
	if (!desk) throw new Error('Missing the desk band');
	expect(flat(layer)).toBe(true);
	expect(flat(desk)).toBe(true);
	const motifs = [...layer.querySelectorAll('.art-motif')];
	expect(motifs.length).toBeGreaterThan(3);
	for (const motif of motifs) {
		expect(motif.parentElement).toBe(desk);
		expect(getComputedStyle(motif).zIndex).toBe('1');
	}
	// Static decoration: nothing on the desk moves.
	expect(layer.getAnimations({ subtree: true })).toHaveLength(0);
});

test('starts paused and runs only while it is on screen in a visible tab', async () => {
	const layer = await mount();
	const ripple = layer.querySelector('.art-ripple');
	const lobe = layer.querySelector('.art-lobes path');
	const mote = layer.querySelector('.art-motes i');
	if (!ripple || !lobe || !mote) throw new Error('Missing ripple, lobe or mote');
	expect(layer.dataset.art).toBe('paused');
	expect(layer.hasAttribute('data-art-seen')).toBe(false);
	expect(getComputedStyle(ripple, '::before').animationPlayState).toBe('paused');
	expect(getComputedStyle(lobe).animationPlayState).toBe('paused');
	expect(getComputedStyle(mote).animationPlayState).toBe('paused');

	observer().emit(true);
	expect(layer.dataset.art).toBe('running');
	expect(layer.hasAttribute('data-art-seen')).toBe(true);
	expect(getComputedStyle(ripple, '::before').animationPlayState).toBe('running');
	expect(getComputedStyle(lobe).animationPlayState).toBe('running');
	expect(getComputedStyle(mote).animationPlayState).toBe('running');

	setTabHidden(true);
	expect(layer.dataset.art).toBe('paused');
	expect(getComputedStyle(mote).animationPlayState).toBe('paused');
	setTabHidden(false);
	expect(layer.dataset.art).toBe('running');

	observer().emit(false);
	expect(layer.dataset.art).toBe('paused');
	expect(getComputedStyle(ripple, '::after').animationPlayState).toBe('paused');
	expect(layer.hasAttribute('data-art-seen')).toBe(true);
});

test('lobes expand once from the stage and stay; the ambient loops are slow', async () => {
	const layer = await mount();
	const lobes = [...layer.querySelectorAll('.art-lobes path')];
	expect(lobes.length).toBeGreaterThan(1);
	for (const lobe of lobes) {
		// Every lobe starts at the loudspeaker (the origin) and is drawn with a unit path length.
		expect(lobe.getAttribute('d')).toMatch(/^M0 0a/);
		expect(lobe.getAttribute('pathLength')).toBe('1');
		const style = getComputedStyle(lobe);
		if (style.animationName === 'none') continue;
		expect(style.animationIterationCount).toBe('1');
		expect(style.animationFillMode).toBe('both');
	}
	const ripple = layer.querySelector('.art-ripple');
	if (!ripple) throw new Error('Missing ripple');
	const loops = [
		getComputedStyle(ripple, '::before'),
		getComputedStyle(ripple, '::after'),
		...[...layer.querySelectorAll('.art-motes i')].map((mote) => getComputedStyle(mote))
	];
	for (const style of loops) {
		if (style.animationName === 'none') continue;
		expect(parseFloat(style.animationDuration)).toBeGreaterThanOrEqual(6);
	}
});

test('animations exist only without a reduced-motion preference and reduce switches all off', async () => {
	const layer = await mount();
	const nodes = [layer, ...layer.querySelectorAll('*')];
	const touches = (rule: CSSStyleRule) =>
		PSEUDOS.some((pseudo) => nodes.some((node) => matches(node, parts(rule, pseudo))));
	const rules = documentRules();

	// The curtain ripple (both pseudo-elements), the lobes and the motes.
	const animated = rules.filter(({ rule }) => {
		const animation = declaredAnimation(rule);
		return animation !== '' && !/^none\b/.test(animation) && touches(rule);
	});
	expect(animated.length).toBeGreaterThanOrEqual(4);
	for (const { media } of animated) {
		expect(media.some((query) => query.includes('prefers-reduced-motion: no-preference'))).toBe(
			true
		);
	}
	// Without a reduced-motion preference the browser really animates those parts, and every
	// live animation comes from one of the rules above (none declared outside the media query).
	if (matchMedia('(prefers-reduced-motion: no-preference)').matches) {
		const moving = layer.querySelectorAll('.art-lobes path, .art-motes i').length;
		expect(moving).toBeGreaterThan(0);
		const live = liveAnimated(nodes);
		expect(live.length).toBeGreaterThanOrEqual(moving);
		for (const { node, pseudo } of live) {
			expect(animated.some(({ rule }) => matches(node, parts(rule, pseudo)))).toBe(true);
		}
	}

	const stills = rules.filter(
		({ rule, media }) =>
			media.some((query) => query.includes('prefers-reduced-motion: reduce')) &&
			rule.style.getPropertyValue('animation-name') === 'none' &&
			rule.style.getPropertyPriority('animation-name') === 'important'
	);
	expect(stills.length).toBeGreaterThan(0);
	for (const pseudo of PSEUDOS) {
		const selectors = stills.flatMap(({ rule }) => parts(rule, pseudo));
		for (const node of pseudo === '' ? nodes : nodes.slice(1)) {
			expect(matches(node, selectors)).toBe(true);
		}
	}
	if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
		observer().emit(true);
		expect(layer.getAnimations({ subtree: true })).toHaveLength(0);
	}
});
