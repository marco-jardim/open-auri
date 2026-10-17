// FUX.ART.3: the Comunidade art layer (console surface, masking tape, faders, ON AIR lamp) is
// decoration only: hidden from assistive technology, out of the way of the pointer and the
// keyboard, still until it is seen in a visible tab, and still for good under reduced motion.
// The faders slide in once and then hold still: nothing here may read as a meter (§0.12.7).
import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import ComunidadeArt from '#lib/components/art/ComunidadeArt.svelte';
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
	'a, button, input, select, textarea, iframe, audio, video, summary, details, [tabindex], [contenteditable], [href]';

afterEach(async () => {
	await cleanup();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(document, 'visibilityState');
	FakeObserver.last = null;
});

async function mount(): Promise<HTMLElement> {
	vi.stubGlobal('IntersectionObserver', FakeObserver);
	const screen = await render(ComunidadeArt);
	flushSync();
	const layer = screen.container.querySelector('.art-layer');
	if (!(layer instanceof HTMLElement)) throw new Error('Missing art layer');
	await expect.poll(() => FakeObserver.last?.targets.includes(layer)).toBe(true);
	return layer;
}

function faderCount(layer: HTMLElement): number {
	return layer.querySelectorAll('.art-faders i').length;
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

test('is hidden from assistive technology and the pointer, with no text and nothing focusable', async () => {
	const layer = await mount();
	expect(layer.getAttribute('aria-hidden')).toBe('true');
	const style = getComputedStyle(layer);
	expect(style.pointerEvents).toBe('none');
	expect(style.position).toBe('absolute');
	expect(style.zIndex).toBe('-1');
	expect(layer.textContent?.trim()).toBe('');
	expect(layer.querySelectorAll(FOCUSABLE)).toHaveLength(0);
	for (const node of layer.querySelectorAll('*')) {
		expect(getComputedStyle(node).pointerEvents).toBe('none');
		if (node instanceof HTMLElement) expect(node.tabIndex).toBeLessThan(0);
	}
});

test('starts paused and runs only while it is on screen in a visible tab', async () => {
	const layer = await mount();
	const lamp = layer.querySelector('.art-onair');
	const fader = layer.querySelector('.art-faders i');
	if (!lamp || !fader) throw new Error('Missing lamp or fader');
	expect(layer.dataset.art).toBe('paused');
	expect(layer.hasAttribute('data-art-seen')).toBe(false);
	expect(getComputedStyle(lamp, '::after').animationPlayState).toBe('paused');
	expect(getComputedStyle(fader).animationPlayState).toBe('paused');

	observer().emit(true);
	expect(layer.dataset.art).toBe('running');
	expect(layer.hasAttribute('data-art-seen')).toBe(true);
	expect(getComputedStyle(lamp, '::after').animationPlayState).toBe('running');
	expect(getComputedStyle(fader).animationPlayState).toBe('running');

	setTabHidden(true);
	expect(layer.dataset.art).toBe('paused');
	expect(getComputedStyle(lamp, '::after').animationPlayState).toBe('paused');
	setTabHidden(false);
	expect(layer.dataset.art).toBe('running');

	observer().emit(false);
	expect(layer.dataset.art).toBe('paused');
	expect(getComputedStyle(fader).animationPlayState).toBe('paused');
	// The entrance happened once: leaving the viewport does not arm it again.
	expect(layer.hasAttribute('data-art-seen')).toBe(true);
});

test('faders slide in once and then hold their rest position: never a loop, never a meter', async () => {
	const layer = await mount();
	const faders = [...layer.querySelectorAll('.art-faders i')];
	expect(faders.length).toBeGreaterThan(0);
	const rests = new Set<string>();
	for (const fader of faders) {
		const style = getComputedStyle(fader);
		rests.add(style.getPropertyValue('--y').trim());
		if (style.animationName === 'none') continue;
		expect(style.animationIterationCount).toBe('1');
		expect(style.animationFillMode).toBe('both');
		expect(style.animationDirection).toBe('normal');
	}
	// Each fader keeps its own fixed rest (a mix), not one shared, moving level.
	expect(rests.size).toBeGreaterThan(faders.length / 2);
	// The flare is a one-shot too; only the lamp's halo loops, slowly.
	const flare = layer.querySelector('.art-flare');
	const lamp = layer.querySelector('.art-onair');
	if (!flare || !lamp) throw new Error('Missing flare or lamp');
	for (const pseudo of ['::before', '::after'] as const) {
		const style = getComputedStyle(flare, pseudo);
		if (style.animationName !== 'none') expect(style.animationIterationCount).toBe('1');
	}
	const halo = getComputedStyle(lamp, '::after');
	if (halo.animationName !== 'none') {
		expect(parseFloat(halo.animationDuration)).toBeGreaterThanOrEqual(6);
	}
});

test('animations exist only without a reduced-motion preference and reduce switches all off', async () => {
	const layer = await mount();
	const nodes = [layer, ...layer.querySelectorAll('*')];
	const touches = (rule: CSSStyleRule) =>
		PSEUDOS.some((pseudo) => nodes.some((node) => matches(node, parts(rule, pseudo))));
	const rules = documentRules();

	// The faders, the flare (both pseudo-elements) and the lamp's halo.
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
		const live = liveAnimated(nodes);
		expect(faderCount(layer)).toBeGreaterThan(0);
		expect(live.length).toBeGreaterThanOrEqual(faderCount(layer));
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
