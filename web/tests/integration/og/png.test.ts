// T4.7: the real resvg path (WASM inside workerd). No fonts are passed (the ASSETS binding is not
// served by the test pool), so text is not drawn; shapes, size and byte determinism are what this
// file checks. If the WASM module cannot load in the Vitest workerd pool, this file fails on its
// own while og.test.ts (injected renderer) still covers the store and the route.
import { NEUTRAL_BANDS } from 'open-auri/dsp';
import { encodeS1 } from 'open-auri/share';
import { describe, expect, it } from 'vitest';
import { renderPng } from '#lib/server/og/render.ts';
import { OG_HEIGHT, OG_WIDTH, ogSvg } from '#lib/server/og/svg.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function svg(): string {
	const peak = { kind: 'PK', freqHz: 3000, gainDb: 4, qFactor: 1 } as const;
	return ogSvg({
		name: 'Warm vocal',
		license: 'CC-BY-4.0',
		author: 'mixer',
		s1: encodeS1({ bands: NEUTRAL_BANDS.map((band, i) => (i === 0 ? peak : band)), preampDb: 0 }),
		lang: 'pt-BR'
	});
}

function u32(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

describe('renderPng', () => {
	it('renders a 1200×630 PNG, byte-identical for the same SVG', async () => {
		const first = await renderPng(svg(), []);
		const second = await renderPng(svg(), []);
		expect(Array.from(first.slice(0, 8))).toEqual(PNG_SIGNATURE);
		// IHDR is the first chunk: length (4) + "IHDR" (4) + width (4) + height (4).
		expect(String.fromCharCode(...first.slice(12, 16))).toBe('IHDR');
		expect(u32(first, 16)).toBe(OG_WIDTH);
		expect(u32(first, 20)).toBe(OG_HEIGHT);
		expect(second).toEqual(first);
	});
});
