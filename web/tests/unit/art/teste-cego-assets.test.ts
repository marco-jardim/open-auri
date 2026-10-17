// FUX.ART.3 budget and hygiene for the Teste cego art (fux-art-brief §3): the static SVG masks
// stay within 40 kB for the page and are hand-optimised shapes only (viewBox, no metadata, no
// text, no external references); the component animates only transform, opacity,
// stroke-dashoffset or filter, points at files that exist and carries no logic besides the part
// switch and the shared attachment. No text may sit under the art: the page part makes no
// stacking context and only its motif boxes rise, inside geometry that mirrors BlindTest's desk
// padding; the scene part sits inside ListeningRoom's frame between the drawing and the plates.
// BlindTest inserts the page part once, as the first child of its isolated root.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { expect, test } from 'vitest';

const STATIC_ROOT = new URL('../../../static/', import.meta.url);
const STATIC = new URL('art/teste-cego/', STATIC_ROOT);
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const COMPONENT = read('../../../src/lib/components/art/TesteCegoArt.svelte');
const PAGE = read('../../../src/lib/components/pages/teste-cego/BlindTest.svelte');
const ROOM = read('../../../src/lib/components/pages/teste-cego/ListeningRoom.svelte');
/** The component's <style> block without comments: CSS checks never read prose. */
const STYLE = (COMPONENT.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '').replace(
	/\/\*[\s\S]*?\*\//g,
	''
);
const ANIMATABLE = new Set(['transform', 'opacity', 'stroke-dashoffset', 'filter']);

test('static SVGs: at most 40 kB for the page, shapes only, no text or external references', () => {
	const files = readdirSync(STATIC).filter((name) => name.endsWith('.svg'));
	expect(files.length).toBeGreaterThan(0);
	let total = 0;
	for (const name of files) {
		const url = new URL(name, STATIC);
		const source = readFileSync(url, 'utf8');
		total += statSync(url).size;
		expect(source).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[^"]+"/);
		expect(source).not.toMatch(/<(?:metadata|script|style|text|foreignObject|image|title|desc)\b/);
		expect(source).not.toMatch(/<!--|<\?xml|inkscape|sodipodi|data-name|\son[a-z]+=/i);
		expect(source).not.toMatch(/\bhref="(?!#)/);
	}
	expect(total).toBeLessThanOrEqual(40 * 1024);
});

test('the component points only at existing masks of its own page', () => {
	const urls = [...COMPONENT.matchAll(/url\('([^']+)'\)/g)].map((match) => match[1] ?? '');
	expect(urls.length).toBeGreaterThan(0);
	for (const url of urls) {
		expect(url.startsWith('/art/teste-cego/')).toBe(true);
		expect(existsSync(new URL(`.${url}`, STATIC_ROOT))).toBe(true);
	}
});

test('keyframes animate only transform, opacity, stroke-dashoffset or filter; no transitions', () => {
	expect(STYLE).toContain('.art-layer');
	const blocks = STYLE.match(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g) ?? [];
	expect(blocks.length).toBeGreaterThan(0);
	for (const block of blocks) {
		const properties = [...block.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1] ?? '');
		expect(properties.length).toBeGreaterThan(0);
		for (const property of properties) expect(ANIMATABLE.has(property)).toBe(true);
	}
	// The only transition declaration is the reduced-motion `transition: none`.
	const transitions = [...STYLE.matchAll(/\btransition\s*:([^;]*);/g)].map((match) =>
		(match[1] ?? '').trim()
	);
	expect(transitions.length).toBeGreaterThan(0);
	for (const value of transitions) expect(value).toMatch(/^none\b/);
	// The lobes play once; only the curtain ripple and the motes loop.
	expect(STYLE).toMatch(/animation: lobe-expand (?![^;]*infinite)[^;]*both paused;/);
	expect(STYLE.match(/\binfinite\b/g)).toHaveLength(3);
});

test('two static parts and no other logic: the page part and the scene part', () => {
	const script = COMPONENT.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '';
	expect(script.replace(/\s+/g, ' ').trim()).toBe(
		"import { artVisibility } from './visibility.ts'; let { place = 'page' }: { place?: 'page' | 'scene' } = $props();"
	);
	expect(COMPONENT).not.toMatch(/\{#(?:each|await|key)\b|\$state|\$effect|\$derived/);
	expect(COMPONENT.match(/\{#if\b/g)).toHaveLength(1);
	expect(COMPONENT).toContain("{#if place === 'scene'}");
	for (const part of ['art-scene', 'art-page']) {
		expect(COMPONENT).toContain(
			`<div class="art-layer ${part}" aria-hidden="true" data-art="paused" {@attach artVisibility}>`
		);
	}
});

/** The body of a top-level rule of the component's style block. */
function rule(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return STYLE.match(new RegExp(`\\n\\t${escaped} \\{([^}]*)\\}`))?.[1] ?? '';
}

test('no text under the art: only the motif boxes rise, inside the desk padding and gutters', () => {
	const flat = /z-index|contain|opacity|transform|isolation|filter|mask|will-change/;
	// The page part's root and band make no stacking context: they paint under the room and desk.
	for (const selector of ['.art-layer', '.art-page', '.art-desk']) {
		expect(rule(selector)).not.toBe('');
		expect(rule(selector)).not.toMatch(flat);
	}
	// The one z-index of the component belongs to the motif boxes.
	expect(rule('.art-motif')).toMatch(/z-index: 1;/);
	expect(STYLE.match(/z-index/g)).toHaveLength(1);
	// Their geometry mirrors BlindTest's desk (4 px border, padding 34 / clamp / 46, 1360 px grid)
	// and ListeningRoom's height, so they stay in the padding and the gutters.
	expect(PAGE).toMatch(/\.desk \{[^}]*padding: 34px clamp\(12px, 3vw, 40px\) 46px;/);
	expect(PAGE).toMatch(/\.desk \{[^}]*border-top: 4px solid/);
	expect(PAGE).toMatch(/\.desk-grid \{[^}]*max-width: 1360px;/);
	expect(rule('.art-desk')).toContain('--pad: clamp(12px, 3vw, 40px);');
	expect(ROOM).toMatch(/\.room \{[^}]*height: clamp\(400px, 64vh, 660px\);/);
	expect(rule('.art-spacer')).toContain('height: clamp(400px, 64vh, 660px);');
	expect(rule('.art-frieze-top')).toMatch(/top: 8px;/);
	expect(rule('.art-frieze')).toMatch(/height: 26px;/);
	expect(rule('.art-frieze-bottom')).toMatch(/bottom: 10px;/);
	expect(rule('.art-column')).toMatch(
		/top: 38px;\s*bottom: 46px;\s*width: calc\(var\(--pad\) - 10px\);/
	);
});

test('ListeningRoom renders the scene part once, between the scene drawing and the plates', () => {
	expect(ROOM).toContain("import TesteCegoArt from '#lib/components/art/TesteCegoArt.svelte';");
	expect(ROOM.match(/<TesteCegoArt\b/g)).toHaveLength(1);
	expect(ROOM).toMatch(
		/<\/svg>\s*(?:<!--[\s\S]*?-->\s*)?<TesteCegoArt place="scene" \/>\s*<div class="plates">/
	);
});

test('BlindTest inserts the art once, as the first child of its isolated root', () => {
	expect(PAGE.match(/<TesteCegoArt\b/g)).toHaveLength(1);
	expect(PAGE).toMatch(/<div class="blind-test">\s*<TesteCegoArt \/>/);
	const root = PAGE.match(/\.blind-test \{([^}]*)\}/)?.[1] ?? '';
	expect(root).toMatch(/position: relative;/);
	expect(root).toMatch(/isolation: isolate;/);
});
