import { expect, vi } from 'vitest';

type Entries = { isIntersecting: boolean }[];

interface Watch {
	callback: (entries: Entries) => void;
	targets: Element[];
}

const watches: Watch[] = [];

/** An IntersectionObserver that never reports by itself: the art stays as mounted until `reveal`. */
class ManualIntersectionObserver {
	readonly root = null;
	readonly rootMargin = '0px';
	readonly thresholds: readonly number[] = [0];
	readonly #watch: Watch;

	constructor(callback: (entries: Entries) => void) {
		this.#watch = { callback, targets: [] };
		watches.push(this.#watch);
	}
	observe(target: Element): void {
		this.#watch.targets.push(target);
	}
	unobserve(target: Element): void {
		this.#watch.targets = this.#watch.targets.filter((watched) => watched !== target);
	}
	disconnect(): void {
		this.#watch.targets = [];
	}
	takeRecords(): [] {
		return [];
	}
}

/** Replaces IntersectionObserver for the current test (undo with `vi.unstubAllGlobals`). */
export function useManualObservers(): void {
	watches.length = 0;
	vi.stubGlobal('IntersectionObserver', ManualIntersectionObserver);
}

/** Reports every observed element as on screen (or, with `false`, as off screen). */
export function reveal(isIntersecting = true): void {
	for (const watch of watches) {
		if (watch.targets.length > 0) watch.callback(watch.targets.map(() => ({ isIntersecting })));
	}
}

/** The layer and its descendants that currently have a CSS animation applied. */
export function animated(layer: Element): Element[] {
	return [layer, ...layer.querySelectorAll('*')].filter(
		(element) => getComputedStyle(element).animationName !== 'none'
	);
}

/**
 * Makes the page's CSS behave as under `prefers-reduced-motion: reduce`: every
 * `(prefers-reduced-motion: no-preference)` block stops matching and every `(… reduce)` block
 * starts matching, so computed styles are the ones a reduced-motion user gets. Returns the undo.
 */
export function simulateReducedMotion(): () => void {
	const changed: { media: MediaList; text: string }[] = [];
	const walk = (rules: CSSRuleList) => {
		for (const rule of rules) {
			if (!(rule instanceof CSSMediaRule)) continue;
			const text = rule.media.mediaText;
			if (text.includes('prefers-reduced-motion: no-preference')) {
				changed.push({ media: rule.media, text });
				rule.media.mediaText = 'not all';
			} else if (text.includes('prefers-reduced-motion: reduce')) {
				changed.push({ media: rule.media, text });
				rule.media.mediaText = 'all';
			}
			walk(rule.cssRules);
		}
	};
	for (const sheet of document.styleSheets) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue; // a cross-origin sheet: not ours
		}
		walk(rules);
	}
	expect(changed.length).toBeGreaterThan(0);
	return () => {
		for (const { media, text } of changed) media.mediaText = text;
	};
}

const FOCUSABLE =
	'a[href], area[href], button, input, select, textarea, iframe, summary, audio[controls], video[controls], [tabindex], [contenteditable]';

/** Decorative contract: hidden from assistive tech, inert to the pointer, no text, nothing to focus. */
export function expectDecorative(layer: HTMLElement): void {
	expect(layer.getAttribute('aria-hidden')).toBe('true');
	const style = getComputedStyle(layer);
	expect(style.pointerEvents).toBe('none');
	expect(style.position).toBe('absolute');
	expect(style.zIndex).toBe('-1');
	expect(style.overflow).toBe('hidden');
	expect(layer.textContent?.trim()).toBe('');
	expect(layer.querySelectorAll(FOCUSABLE)).toHaveLength(0);
	for (const element of layer.querySelectorAll('*')) {
		if (element instanceof HTMLElement || element instanceof SVGElement) {
			expect(element.tabIndex).toBeLessThan(0);
		}
	}
	// Shapes are CSS backgrounds or inline strokes: never <img> (page tests forbid it).
	expect(layer.querySelector('img')).toBeNull();
}

/** Every motif carrying its own visibility state, the layer first. */
export function motifs(layer: HTMLElement): HTMLElement[] {
	return [layer, ...layer.querySelectorAll<HTMLElement>('[data-art]')];
}
