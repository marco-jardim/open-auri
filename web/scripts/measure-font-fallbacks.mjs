#!/usr/bin/env node
// Measures the metric overrides for the local fallback faces declared in
// src/lib/styles/fonts.css ("Geist Fallback" on Arial, "Instrument Serif Fallback" on Georgia),
// spec docs/plans/fux-spec.md §5.6. No new package: it drives the Playwright Chromium the e2e
// suite already installs, loads the self-hosted woff2 files as data URLs and compares them with
// the local fonts through canvas measureText.
//
//   size-adjust      = average advance of the web font / average advance of the local font
//   ascent-override  = web font ascent (em) / size-adjust
//   descent-override = web font descent (em) / size-adjust
//
// Usage (from web/): node scripts/measure-font-fallbacks.mjs
// Prints the @font-face block to paste into src/lib/styles/fonts.css. Run it on a machine that
// has the local fonts (Windows or macOS have Arial and Georgia); it fails if a local font is
// missing instead of printing values measured against a substitute.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const FONTS_DIR = fileURLToPath(new URL('../static/fonts/', import.meta.url));

/** Text close to what the app shows: pt-BR and en-US words, digits and punctuation. */
const SAMPLE =
	'Curva Biblioteca Comparar Soe como X Comunidade Teste cego Cabo Docs ' +
	'Gravar no cabo, alterações não gravadas; Write to cable, unsaved changes. ' +
	'O gráfico é o que vai para o cabo: preamp −3,0 dB, 10 seções, CRC 0x4FFF. ' +
	'The quick brown fox jumps over the lazy dog 0123456789';

const TARGETS = [
	{
		family: 'Geist',
		file: 'geist/geist-latin-wght-normal.woff2',
		weight: '400',
		style: 'normal',
		fallbackName: 'Geist Fallback',
		local: 'Arial'
	},
	{
		family: 'Instrument Serif',
		file: 'instrument-serif/instrument-serif-latin-400-normal.woff2',
		weight: '400',
		style: 'normal',
		fallbackName: 'Instrument Serif Fallback',
		local: 'Georgia'
	},
	{
		family: 'Instrument Serif',
		file: 'instrument-serif/instrument-serif-latin-400-italic.woff2',
		weight: '400',
		style: 'italic',
		fallbackName: 'Instrument Serif Fallback',
		local: 'Georgia'
	}
];

const SIZE = 100;

/** @param {number} value */
const pct = (value) => `${(value * 100).toFixed(2)}%`;

async function main() {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
		const blocks = [];
		for (const target of TARGETS) {
			const bytes = await readFile(`${FONTS_DIR}${target.file}`);
			const dataUrl = `data:font/woff2;base64,${bytes.toString('base64')}`;
			const result = await page.evaluate(
				async ({ target, dataUrl, sample, size }) => {
					const face = new FontFace(`${target.family} Measure`, `url(${dataUrl})`, {
						weight: target.weight,
						style: target.style
					});
					await face.load();
					document.fonts.add(face);
					const local = target.local;
					const canvas = document.createElement('canvas');
					const ctx = canvas.getContext('2d');
					if (!ctx) return { error: 'no 2d context' };
					const font = (family) => `${target.style} ${target.weight} ${size}px "${family}"`;
					ctx.font = font(`${target.family} Measure`);
					const web = ctx.measureText(sample);
					ctx.font = font(local);
					const fallback = ctx.measureText(sample);
					// A missing local font silently resolves to the default face: compare against a
					// generic family to detect that case.
					ctx.font = `${target.style} ${target.weight} ${size}px monospace`;
					const generic = ctx.measureText(sample);
					return {
						webWidth: web.width,
						fallbackWidth: fallback.width,
						genericWidth: generic.width,
						webAscent: web.fontBoundingBoxAscent / size,
						webDescent: web.fontBoundingBoxDescent / size
					};
				},
				{ target, dataUrl, sample: SAMPLE, size: SIZE }
			);
			if ('error' in result) throw new Error(`${target.family}: ${result.error}`);
			if (Math.abs(result.fallbackWidth - result.genericWidth) < 0.5) {
				throw new Error(`${target.local} seems to be missing (measured as the generic face)`);
			}
			const sizeAdjust = result.webWidth / result.fallbackWidth;
			blocks.push({
				...target,
				sizeAdjust,
				ascent: result.webAscent / sizeAdjust,
				descent: result.webDescent / sizeAdjust,
				raw: result
			});
		}

		for (const block of blocks) {
			console.log(
				`/* ${block.family} ${block.style} vs ${block.local}: web width ${block.raw.webWidth.toFixed(1)}, ` +
					`local width ${block.raw.fallbackWidth.toFixed(1)}, ascent ${block.raw.webAscent.toFixed(4)} em, ` +
					`descent ${block.raw.webDescent.toFixed(4)} em */`
			);
			console.log(
				[
					'@font-face {',
					`\tfont-family: '${block.fallbackName}';`,
					...(block.style === 'italic' ? ['\tfont-style: italic;'] : []),
					`\tsrc: local('${block.local}${block.style === 'italic' ? ' Italic' : ''}');`,
					`\tsize-adjust: ${pct(block.sizeAdjust)};`,
					`\tascent-override: ${pct(block.ascent)};`,
					`\tdescent-override: ${pct(block.descent)};`,
					'\tline-gap-override: 0%;',
					'}',
					''
				].join('\n')
			);
		}
	} finally {
		await browser.close();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
