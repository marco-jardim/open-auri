// FUX.ART.3 budget and hygiene for the Comunidade art (fux-art-brief §3): the static SVG masks
// stay within 40 kB for the page and are hand-optimised shapes only (viewBox, no metadata, no
// text, no external references); the component animates only transform, opacity,
// stroke-dashoffset or filter, points at files that exist, carries no logic besides the shared
// attachment (the route is close to its JS budget), and the page inserts it once, as the first
// child of its isolated root.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { expect, test } from 'vitest';

const STATIC_ROOT = new URL('../../../static/', import.meta.url);
const STATIC = new URL('art/comunidade/', STATIC_ROOT);
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const COMPONENT = read('../../../src/lib/components/art/ComunidadeArt.svelte');
const PAGE = read('../../../src/lib/components/pages/comunidade/Comunidade.svelte');
const PAGE_CSS = read('../../../src/lib/components/pages/comunidade/comunidade.css');
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
		expect(url.startsWith('/art/comunidade/')).toBe(true);
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
	// One loop only (the lamp's halo); the faders and the flare play once.
	expect(STYLE.match(/\binfinite\b/g)).toHaveLength(1);
	expect(STYLE).toMatch(/animation: onair-halo [^;]*infinite/);
});

test('ships no logic: the shared visibility attachment, static markup, paused from the start', () => {
	const script = COMPONENT.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '';
	expect(script.trim()).toBe("import { artVisibility } from './visibility.ts';");
	expect(COMPONENT).not.toMatch(/\{#(?:each|if|await|key)\b|\$state|\$effect|\$derived|\$props/);
	expect(COMPONENT).toMatch(
		/<div class="art-layer" aria-hidden="true" data-art="paused" \{@attach artVisibility\}>/
	);
});

test('the page inserts the art once, as the first child of its isolated root', () => {
	expect(PAGE.match(/<ComunidadeArt\b/g)).toHaveLength(1);
	expect(PAGE).toMatch(/<div class="oa-comunidade">\s*<ComunidadeArt \/>/);
	const root = PAGE_CSS.match(/\.oa-comunidade \{([^}]*)\}/)?.[1] ?? '';
	expect(root).toMatch(/position: relative;/);
	expect(root).toMatch(/isolation: isolate;/);
});
