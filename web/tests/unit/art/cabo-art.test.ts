// FUX.ART.2 · Cabo art budget and hygiene (docs/plans/fux-art-brief.md §3): the weight lives in
// static SVGs (40 kB at most for the page), every referenced file exists and is used, the files
// carry no script, style, text or metadata, keyframes only touch transform, opacity and
// stroke-dashoffset, and the component adds at most 2 kB gzip of JS to the route.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { compile } from 'svelte/compiler';
import { expect, test } from 'vitest';

const web = new URL('../../../', import.meta.url);
const component = readFileSync(new URL('src/lib/components/art/CaboArt.svelte', web), 'utf8');
const visibility = readFileSync(new URL('src/lib/components/art/visibility.ts', web), 'utf8');
const assets = new URL('static/art/cabo/', web);
const files = readdirSync(assets).filter((name) => name.endsWith('.svg'));

test('every static SVG is referenced and present, 40 kB at most for the page', () => {
	const referenced = [...component.matchAll(/url\('\/art\/cabo\/([\w-]+\.svg)'\)/g)].map(
		(match) => match[1]
	);
	expect(new Set(referenced)).toEqual(new Set(files));
	const total = files.reduce((sum, name) => sum + statSync(new URL(name, assets)).size, 0);
	expect(total).toBeLessThanOrEqual(40_000);
});

test('static SVGs are hand-optimised, scalable and inert', () => {
	for (const name of files) {
		const svg = readFileSync(new URL(name, assets), 'utf8');
		expect(svg, name).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]* viewBox="/);
		expect(svg, name).not.toMatch(
			/<(?:script|style|text|image|foreignObject|metadata)\b|<!--|<\?xml|inkscape|sodipodi|href="(?!#)/i
		);
	}
});

test('keyframes animate only transform, opacity and stroke-dashoffset', () => {
	const style = component.slice(component.indexOf('<style>'));
	const blocks = [...style.matchAll(/@keyframes\s+[\w-]+\s*\{((?:[^{}]*\{[^}]*\})+)\s*\}/g)];
	expect(blocks.length).toBeGreaterThan(0);
	for (const [, body] of blocks) {
		for (const [, property] of body.matchAll(/([\w-]+)\s*:/g)) {
			expect(['transform', 'opacity', 'stroke-dashoffset']).toContain(property);
		}
	}
	expect(style).not.toMatch(/\btransition\b/);
});

test('animations stay valid without the global tokens and pause whatever their specificity', () => {
	const style = component.slice(component.indexOf('<style>'));
	const shorthands = [...style.matchAll(/\banimation:\s*([^;]+);/g)].map((match) => match[1]);
	expect(shorthands.length).toBeGreaterThan(0);
	// An unresolved var() makes the whole shorthand compute to `animation: none`.
	for (const value of shorthands) expect(value).not.toMatch(/var\(--[\w-]+\)/);
	// Each shorthand resets the play state to running; only !important outranks the reveals.
	const pause =
		/:global\(\[data-art='paused'\]\)[^{]*\{\s*animation-play-state: paused !important;/;
	expect(style).toMatch(pause);
});

test('the component adds at most 2 kB gzip of JS to the route', () => {
	expect([...component.matchAll(/^\s*import\s/gm)]).toHaveLength(1);
	const { js } = compile(component, {
		filename: 'CaboArt.svelte',
		generate: 'client',
		css: 'external',
		runes: true
	});
	// Unminified output plus the commented attachment source: an upper bound of the built size.
	expect(gzipSync(js.code).length + gzipSync(visibility).length).toBeLessThanOrEqual(2048);
});
